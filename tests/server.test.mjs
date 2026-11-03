// Pure logic only: nothing here reaches the VM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildTopology, cliCommand, describeTopology, helperSpec, linkInterfaces, renderStartupConfig,
} from "../server/src/topology.mjs";
import { designChecks, formatChecklist } from "../server/src/health.mjs";
import { planFault, rng } from "../server/src/faults.mjs";
import { parsePing } from "../server/src/drivers.mjs";
import { taskFor } from "../server/src/exercises.mjs";
import { HELPER_VERSION, parseFacts, setupReport } from "../server/src/setup.mjs";

const ring = () => buildTopology({ name: "ring4", template: "ring", size: 4, routing: "ospf" });

test("addressing plan: loopback 10.255.0.i, link 10.i.j.0/30, lower index gets .1", () => {
  const t = ring();
  assert.equal(t.nodes[2].loopback, "10.255.0.3");
  assert.deepEqual(t.links[0], {
    id: 0,
    subnet: "10.1.2.0/30",
    a: { node: "r1", interface: "eth1", ip: "10.1.2.1" },
    b: { node: "r2", interface: "eth1", ip: "10.1.2.2" },
  });
  // The closing link is declared r4 -> r1, but r1 has the lower index.
  assert.deepEqual(t.links[3].a, { node: "r1", interface: "eth2", ip: "10.1.4.1" });
});

test("node names that tools or the VM helper cannot handle are refused", () => {
  for (const name of ["all", "loopback", "shell1", "bash-gw", "python3", "sudo"]) {
    assert.throws(() => buildTopology({ name: "x", nodes: [{ name }, { name: "r2" }] }), /reserved/, name);
  }
  buildTopology({ name: "x", nodes: [{ name: "ally" }, { name: "lo1" }] });
});

test("a link fault lands on the interface that was named, or fails", () => {
  const t = ring();
  const target = (params) => planFault(t, "interface_shutdown", params, rng(1)).params.interface;
  assert.equal(target({ node: "r1", interface: "eth2" }), "eth2");
  assert.equal(target({ node: "r1", interface: "Ethernet2" }), "eth2");
  assert.equal(target({ node: "r1" }), "eth1");
  for (const name of ["Loopback0", "eth1.10", "Gi0/1", "eth9"]) {
    assert.throws(() => target({ node: "r1", interface: name }), /no suitable link interface/, name);
  }
});

test("parsePing reads BusyBox (FRR) and iputils (cEOS) output", () => {
  const busybox = "3 packets transmitted, 3 packets received, 0% packet loss\nround-trip min/avg/max = 0.1/0.2/0.3 ms";
  assert.deepEqual(parsePing(busybox), {
    success: true, sent: 3, received: 3, loss_percent: 0, rtt_ms: { min: 0.1, avg: 0.2, max: 0.3 },
  });
  const iputils = "20 packets transmitted, 15 received, 25% packet loss, time 3805ms\nrtt min/avg/max/mdev = 0.05/0.07/0.1/0.01 ms";
  assert.equal(parsePing(iputils).loss_percent, 25);
  assert.deepEqual(parsePing("ping: sendto: Network unreachable"), { success: false, sent: 0, received: 0, loss_percent: 100 });
});

test("the task says how many faults and what done means, and less on harder levels", () => {
  const easy = taskFor("all", { faults: 1, separateRouters: true, symptoms: 3, checks: 38 });
  assert.match(easy[0], /There is one fault/);
  assert.equal(easy[2], 'You are done when the 3 symptoms above are gone and all 38 health checks pass. Say "validate my fix" to check.');
  assert.match(taskFor("all", { faults: 1, separateRouters: true, symptoms: 1, checks: 38 })[2], /the 1 symptom above is gone/);

  const medium = taskFor("end-to-end", { faults: 1, separateRouters: true, symptoms: 2, checks: 38 });
  assert.match(medium[2], /only the end-to-end ones; other checks may be failing too/);
  assert.doesNotMatch(medium[2], /\d symptoms/);
  // An OSPF fault in a ring breaks no end-to-end check, so nothing is listed to refer to.
  assert.doesNotMatch(taskFor("end-to-end", { faults: 1, separateRouters: true, symptoms: 0, checks: 38 })[2], /symptom/);

  const hard = taskFor("none", { faults: 2, separateRouters: true, symptoms: 0, checks: 40 });
  assert.match(hard[0], /There are 2 faults on different routers\. Fixing one will not clear every symptom\./);
  assert.equal(hard[2], 'You are done when all 40 health checks pass. Say "validate my fix" to check.');
  assert.match(hard[4], /3 per fault/);
  assert.doesNotMatch(taskFor("none", { faults: 2, separateRouters: false, symptoms: 0, checks: 40 })[0], /different routers/);
});

test("a bare lab is cabling only: no addresses, cEOS ports stay switchports", () => {
  const t = buildTopology({ name: "stp3", template: "ring", size: 3, routing: "bare", node_kinds: { r3: "ceos" } });
  assert.equal(t.nodes[0].loopback, undefined);
  assert.equal(t.links[0].subnet, undefined);
  assert.equal(renderStartupConfig(t, t.nodes[0]), [
    "frr defaults traditional", "hostname r1", "service integrated-vtysh-config", "!",
    "interface eth1", " description to r2 eth1", "exit", "!",
    "interface eth2", " description to r3 eth2", "exit", "!",
    "!",
  ].join("\n"));
  assert.equal(renderStartupConfig(t, t.nodes[2]), [
    "hostname r3", "username admin privilege 15 secret admin", "!",
    "interface Ethernet1", "   description to r2 eth2", "!",
    "interface Ethernet2", "   description to r1 eth2", "!",
    "!",
  ].join("\n"));
  assert.deepEqual(linkInterfaces(t, t.nodes[0])[0], { interface: "eth1", ip: undefined, peer: "r2", peer_interface: "eth1" });
  assert.doesNotMatch(JSON.stringify(describeTopology(t)), /undefined|10\./);
  // Faults that need addresses are not offered; a cable fault still is.
  assert.throws(() => planFault(t, "static_blackhole", undefined, rng(1)), /does not apply/);
  assert.equal(planFault(t, "interface_shutdown", { node: "r1" }, rng(1)).params.interface, "eth1");
});

test("an addressed lab still renders addresses and routed cEOS ports", () => {
  const t = buildTopology({ name: "mix", template: "ring", size: 3, routing: "none", node_kinds: { r3: "ceos" } });
  assert.match(renderStartupConfig(t, t.nodes[0]), /interface lo\n ip address 10\.255\.0\.1\/32/);
  assert.match(renderStartupConfig(t, t.nodes[2]), /ip routing[^]*no switchport\n   ip address 10\.2\.3\.2\/30/);
  assert.equal(describeTopology(t).links[0], "r1 eth1 10.1.2.1  <->  r2 eth1 10.1.2.2   (10.1.2.0/30)");
});

test("check_setup stops at the first blocking problem and names the fix", () => {
  const facts = parseFacts([
    `helper_version=${HELPER_VERSION}`, "docker=28.5.2", "containerlab=0.80.0", "lab_storage=ok", "labs_defined=2", "labs_max=6",
    "memory_available_mb=10641", "frr_image=lab-dojo/frr:10.7.1", "ceos_image=", "host_image=lab-dojo/host:1",
    "extra_images=web=nginx:alpine,dns=coredns/coredns:1.12(missing),",
  ].join("\n"));
  const failed = (r) => r.checks.filter((c) => !c.ok && !c.optional).map((c) => c.check);

  assert.deepEqual(failed(setupReport(undefined)), ["VM address"]);
  assert.deepEqual(failed(setupReport("me@vm", null, { exitCode: 255, message: "Permission denied" })), ["SSH to the VM"]);
  assert.deepEqual(failed(setupReport("me@vm", null, { message: "timed out" })), ["SSH to the VM"]);

  const missing = setupReport("me@vm", null, { exitCode: 127, message: "No such file" });
  assert.deepEqual(failed(missing), ["Helper on the VM"]);
  assert.match(missing.checks.at(-1).fix, /scp -r remote\/\. me@vm:.*\n.*install-remote\.sh/);
  // A helper from before the doctor action refuses it; a newer one reports its own number.
  assert.match(setupReport("me@vm", null, { exitCode: 2, refused: true }).checks.at(-1).detail, /an older version is installed/);
  assert.equal(setupReport("me@vm", { ...facts, helper_version: "1" }).ready, false);

  // cEOS is optional: without it the VM is ready, and the report says what that rules out.
  const ok = setupReport("me@vm", facts);
  assert.equal(ok.ready, true);
  assert.deepEqual(failed(ok), []);
  assert.match(ok.checks.at(-1).fix, /docker import/);
  assert.deepEqual(ok.can_build, ["routed labs and exercises with FRR routers", "Linux host nodes (Alpine with network tools)"]);
  assert.equal(ok.not_available.length, 1);
  assert.equal(setupReport("me@vm", { ...facts, ceos_image: "ceos:4.36.2F" }).can_build.length, 3);
  assert.deepEqual(failed(setupReport("me@vm", { ...facts, frr_image: "", containerlab: "", host_image: "" })),
    ["Containerlab", "FRR router image", "Linux host image"]);
  // Extra images come from the root-owned list on the VM; the command to add one is for the user to run.
  assert.deepEqual(ok.extra_images, ["web=nginx:alpine", "dns=coredns/coredns:1.12(missing)"]);
  assert.match(ok.add_image_command, /^sudo .*clab-mcp-admin add-image <name> <image-ref>$/);
});

test("the helper and the server agree on the helper version", () => {
  const helper = readFileSync(new URL("../remote/clab-mcp-remote", import.meta.url), "utf8");
  assert.equal(Number(/^HELPER_VERSION=(\d+)$/m.exec(helper)[1]), HELPER_VERSION);
});

test("a host is a Linux machine, not a router", () => {
  const t = buildTopology({
    name: "edge",
    routing: "ibgp-ospf",
    nodes: [{ name: "r1" }, { name: "r2" }, { name: "host1", kind: "host" }, { name: "web1", kind: "host", image: "web" }],
    links: [{ a: "r1", b: "r2" }, { a: "r1", b: "host1" }, { a: "r2", b: "web1" }],
  });
  const [r1, , host1, web1] = t.nodes;

  // No generated addresses, routing or startup configuration; the router's end of the link keeps its address.
  assert.equal(host1.loopback, undefined);
  assert.equal(host1.asn, undefined);
  assert.equal(renderStartupConfig(t, host1), null);
  assert.deepEqual(t.links[1], {
    id: 1,
    subnet: "10.1.3.0/30",
    a: { node: "r1", interface: "eth2", ip: "10.1.3.1" },
    b: { node: "host1", interface: "eth1", ip: undefined },
  });
  assert.match(renderStartupConfig(t, r1), /interface eth2\n description to host1 eth1\n ip address 10\.1\.3\.1\/30/);
  assert.equal(describeTopology(t).links[1], "r1 eth2 10.1.3.1  <->  host1 eth1   (10.1.3.0/30)");
  assert.deepEqual(t.bgp_sessions.map((s) => `${s.a}-${s.b}`), ["r1-r2"]);

  // What reaches the VM helper, and how a person opens each node.
  assert.match(helperSpec(t), /^node host1 host$/m);
  assert.match(helperSpec(t), /^node web1 host web$/m);
  assert.match(cliCommand(t, host1), / bash$/);
  assert.match(cliCommand(t, web1), / sh$/);

  // Faults never land on a host or on a link towards one.
  assert.throws(() => planFault(t, "interface_shutdown", { node: "r1", interface: "eth2" }, rng(1)), /no suitable link interface/);
  assert.throws(() => planFault(t, "static_blackhole", { node: "r1", peer: "host1" }, rng(1)), /two routers/);
  for (let seed = 1; seed <= 20; seed += 1) {
    const { params } = planFault(t, "ospf_passive_interface", undefined, rng(seed));
    assert.ok(["r1", "r2"].includes(params.node) && ["r1", "r2"].includes(params.peer));
    assert.ok(["r1", "r2"].includes(planFault(t, "static_blackhole", undefined, rng(seed)).params.target));
  }

  assert.throws(() => buildTopology({ name: "x", nodes: [{ name: "r1", image: "web" }] }), /only a host node takes an image/);
  assert.throws(() => buildTopology({ name: "x", nodes: [{ name: "h1", kind: "host" }], extra_config: { h1: ["x"] } }), /no startup configuration/);
});

test("health checks skip what a host cannot have", () => {
  const t = buildTopology({
    name: "edge",
    routing: "ibgp-ospf",
    nodes: [{ name: "r1" }, { name: "r2" }, { name: "host1", kind: "host" }],
    links: [{ a: "r1", b: "r2" }, { a: "r1", b: "host1" }],
  });
  const up = (name) => ({ name, admin: "up", oper: "up", addresses: [] });
  const router = (self, peer, links) => ({
    interfaces: links.map(up),
    ospf: [{ neighbor_id: `10.255.0.${peer}`, eth: "eth1", state: "full" }],
    bgp: { peers: [{ peer: `10.255.0.${peer}`, state: "established" }] },
    routes: [{ prefix: `172.16.${peer}.0/24`, protocol: "bgp", nexthops: [] }],
  });
  const snap = { r1: router(1, 2, ["eth1", "eth2"]), r2: router(2, 1, ["eth1"]), host1: {} };
  const reach = { "r1>10.255.0.2": true, "r2>10.255.0.1": true };

  const checks = designChecks(t, snap, reach);
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  // 2 links, 1 adjacency, 1 session, 2 BGP routes, 2 pings: nothing is expected of the host.
  assert.equal(checks.length, 8);
  assert.ok(checks.every((c) => !/host1/.test(c.id)));

  // The link to the host is still watched, from the router's end.
  snap.r1.interfaces[1].oper = "down";
  assert.deepEqual(designChecks(t, snap, reach).filter((c) => !c.ok).map((c) => c.description), ["Link r1 eth2 <-> host1 eth1 is down"]);
});

test("the checklist marks each check like a test case, grouped by kind", () => {
  const checks = [
    { id: "link:r1:eth1", name: "Link r1 eth1 <-> r2 eth1 is up", ok: true },
    { id: "bgp:r1:10.255.0.2", name: "BGP session r1 <-> r2 (ibgp) is established", ok: false },
    { id: "bgp:r2:10.255.0.3", name: "BGP session r2 <-> r3 (ibgp) is established", ok: true },
  ];
  assert.equal(formatChecklist(checks), [
    "Links (1/1)",
    "  ✅ Link r1 eth1 <-> r2 eth1 is up",
    "BGP sessions (1/2)",
    "  ❌ BGP session r1 <-> r2 (ibgp) is established",
    "  ✅ BGP session r2 <-> r3 (ibgp) is established",
    "",
    "Not solved yet: 2/3",
  ].join("\n"));
  assert.match(formatChecklist(checks, { results: false }), /^Links\n  ☐ Link r1 eth1/);
  assert.match(formatChecklist(checks.map((c) => ({ ...c, ok: true }))), /All checks passed: 3\/3$/);
  // Hard leaves the fault's own checks out of the briefing, and says so.
  assert.match(formatChecklist(checks, { results: false, hidden: 2 }), /\n\n\+ 2 more checks about the fault, shown when you validate$/);
  assert.doesNotMatch(formatChecklist(checks, { results: false }), /more check/);
});

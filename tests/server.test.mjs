// Pure logic only: nothing here reaches the VM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTopology } from "../server/src/topology.mjs";
import { planFault, rng } from "../server/src/faults.mjs";
import { parsePing } from "../server/src/drivers.mjs";
import { taskFor } from "../server/src/exercises.mjs";

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

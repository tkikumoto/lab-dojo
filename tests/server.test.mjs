// Pure logic only: nothing here reaches the VM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTopology } from "../server/src/topology.mjs";
import { planFault, rng } from "../server/src/faults.mjs";
import { parsePing } from "../server/src/drivers.mjs";

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

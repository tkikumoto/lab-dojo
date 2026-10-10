// Lab-wide state collection and outcome-based health checks. Checks are derived
// from the topology design (what *should* be true), so any correct repair
// passes, not just the one the exercise author had in mind.
import { remote } from "./remote.mjs";
import { getBgpSummary, getInterfaces, getOspfNeighbors, getRoutes, parsePing } from "./drivers.mjs";
import { nodeByName, osIfName, toEth, usesBgp, usesOspf } from "./topology.mjs";

async function settle(promise) {
  try {
    return await promise;
  } catch (error) {
    return { error: error.message };
  }
}

export async function collectNode(lab, topology, node) {
  const [interfaces, routes, ospf, bgp] = await Promise.all([
    settle(getInterfaces(lab, node)),
    settle(getRoutes(lab, node)),
    usesOspf(topology) ? settle(getOspfNeighbors(lab, node)) : undefined,
    usesBgp(topology) ? settle(getBgpSummary(lab, node)) : undefined,
  ]);
  return { interfaces, routes, ospf, bgp };
}

export async function collectSnapshot(lab, topology) {
  const entries = await Promise.all(topology.nodes.map(async (node) => [node.name, await collectNode(lab, topology, node)]));
  return Object.fromEntries(entries);
}

/** Loopback-to-loopback reachability, one ping sweep per source node. */
export async function collectReachability(lab, topology) {
  const results = {};
  await Promise.all(topology.nodes.map(async (src) => {
    const targets = topology.nodes.filter((n) => n !== src).map((n) => n.loopback);
    if (!targets.length) return;
    try {
      const out = await remote("ping-sweep", [lab, src.name, src.loopback, ...targets], { timeout: 60_000 });
      for (const line of out.trim().split("\n")) {
        const [dest, verdict] = line.trim().split(/\s+/);
        results[`${src.name}>${dest}`] = verdict === "ok";
      }
    } catch (error) {
      for (const dest of targets) results[`${src.name}>${dest}`] = false;
      results[`${src.name}:error`] = error.message;
    }
  }));
  return results;
}

function check(id, description, ok, detail) {
  return { id, description, ok, ...(detail && !ok ? { detail } : {}) };
}

function evaluateLinks(topology, snapshot) {
  return topology.links.map((link) => {
    const ends = [link.a, link.b].map((end) => {
      const node = nodeByName(topology, end.node);
      const list = snapshot[end.node]?.interfaces;
      const intf = Array.isArray(list) ? list.find((i) => toEth(i.name) === end.interface) : undefined;
      return { node, end, intf, label: `${end.node} ${osIfName(node.kind, end.interface)}` };
    });
    const bad = ends.filter((e) => !e.intf || e.intf.oper !== "up" || e.intf.admin !== "up");
    return check(
      `link:${link.a.node}:${link.a.interface}`,
      `link ${ends[0].label} <-> ${ends[1].label} is up`,
      bad.length === 0,
      bad.map((e) => `${e.label}: ${e.intf ? `admin ${e.intf.admin}, oper ${e.intf.oper}` : "not found"}`).join("; "),
    );
  });
}

function evaluateOspf(topology, snapshot) {
  return topology.links.map((link) => {
    const sides = [[link.a, link.b], [link.b, link.a]].map(([self, other]) => {
      const list = snapshot[self.node]?.ospf;
      const peer = nodeByName(topology, other.node);
      const nbr = Array.isArray(list) ? list.find((n) => n.neighbor_id === peer.loopback && n.eth === self.interface) : undefined;
      return { self, peer, state: nbr?.state ?? (Array.isArray(list) ? "absent" : "unknown") };
    });
    return check(
      `ospf:${link.a.node}:${link.a.interface}`,
      `OSPF adjacency ${link.a.node} <-> ${link.b.node} on ${link.subnet} is full`,
      sides.every((s) => s.state === "full"),
      sides.map((s) => `${s.self.node} sees ${s.peer.name}: ${s.state}`).join("; "),
    );
  });
}

function evaluateBgpSessions(topology, snapshot) {
  return topology.bgp_sessions.map((s) => {
    const sides = [[s.a, s.b_ip], [s.b, s.a_ip]].map(([node, peerIp]) => {
      const bgp = snapshot[node]?.bgp;
      const peer = bgp?.peers?.find((p) => p.peer === peerIp);
      return `${node} -> ${peerIp}: ${peer?.state ?? (bgp?.error ? "unknown" : "not configured")}`;
    });
    const ok = [[s.a, s.b_ip], [s.b, s.a_ip]].every(([node, ip]) =>
      snapshot[node]?.bgp?.peers?.find((p) => p.peer === ip)?.state === "established");
    return check(`bgp:${s.a}:${s.b_ip}`, `BGP session ${s.a} <-> ${s.b} (${s.type}) is established`, ok, sides.join("; "));
  });
}

function evaluateBgpRoutes(topology, snapshot) {
  const checks = [];
  for (const node of topology.nodes) {
    const routes = snapshot[node.name]?.routes;
    for (const other of topology.nodes) {
      if (other === node) continue;
      const route = Array.isArray(routes) ? routes.find((r) => r.prefix === other.service_prefix) : undefined;
      checks.push(check(
        `bgp-route:${node.name}:${other.service_prefix}`,
        `${node.name} has a BGP route to ${other.name}'s service prefix ${other.service_prefix}`,
        route?.protocol === "bgp",
        route ? `selected route is ${route.protocol} via ${route.nexthops.join(", ")}` : "no route",
      ));
    }
  }
  return checks;
}

function evaluateReachability(topology, reach) {
  const checks = [];
  for (const src of topology.nodes) {
    for (const dst of topology.nodes) {
      if (src === dst) continue;
      checks.push(check(
        `reach:${src.name}:${dst.name}`,
        `${src.name} (${src.loopback}) can ping ${dst.name} (${dst.loopback})`,
        reach[`${src.name}>${dst.loopback}`] === true,
        reach[`${src.name}:error`] ?? "ping from loopback failed",
      ));
    }
  }
  return checks;
}

/** Extra, exercise-specific checks attached to faults. */
export async function runExtraCheck(lab, topology, spec) {
  if (spec.type === "ping_quality") {
    const src = nodeByName(topology, spec.from);
    const dst = nodeByName(topology, spec.to);
    const out = await remote("ping", [lab, src.name, dst.loopback, spec.count, src.loopback], { timeout: 60_000 });
    const result = parsePing(out);
    const lossOk = result.loss_percent <= (spec.max_loss_percent ?? 0);
    const rttOk = spec.max_avg_rtt_ms == null || (result.rtt_ms?.avg ?? Infinity) <= spec.max_avg_rtt_ms;
    return check(
      `quality:${spec.from}:${spec.to}`,
      `${spec.count} pings ${spec.from} -> ${spec.to} with <= ${spec.max_loss_percent ?? 0}% loss`
        + (spec.max_avg_rtt_ms != null ? ` and avg RTT <= ${spec.max_avg_rtt_ms} ms` : ""),
      lossOk && rttOk,
      `loss ${result.loss_percent}%, avg RTT ${result.rtt_ms?.avg ?? "n/a"} ms`,
    );
  }
  if (spec.type === "bgp_prefixes") {
    const node = nodeByName(topology, spec.node);
    const summary = await getBgpSummary(lab, node);
    const peer = summary.peers.find((p) => p.peer === spec.peer);
    const count = peer?.prefixes_accepted ?? peer?.prefixes_received ?? 0;
    return check(
      `bgp-prefixes:${spec.node}:${spec.peer}`,
      `${spec.node} accepts at least ${spec.min} prefixes from BGP peer ${spec.peer}`,
      peer?.state === "established" && count >= spec.min,
      peer ? `state ${peer.state}, ${count} prefixes accepted` : "peer not configured",
    );
  }
  throw new Error(`unknown check type ${spec.type}`);
}

export async function evaluateHealth(lab, topology, { extraChecks = [], snapshot } = {}) {
  const [snap, reach, extra] = await Promise.all([
    snapshot ?? collectSnapshot(lab, topology),
    collectReachability(lab, topology),
    Promise.all(extraChecks.map((spec) => runExtraCheck(lab, topology, spec)
      .catch((error) => check(`extra:${spec.type}`, spec.type, false, error.message)))),
  ]);
  const checks = [
    ...evaluateLinks(topology, snap),
    ...(usesOspf(topology) ? evaluateOspf(topology, snap) : []),
    ...evaluateBgpSessions(topology, snap),
    ...(usesBgp(topology) ? evaluateBgpRoutes(topology, snap) : []),
    ...evaluateReachability(topology, reach),
    ...extra,
  ];
  const failed = checks.filter((c) => !c.ok);
  return {
    snapshot: snap,
    summary: {
      healthy: failed.length === 0,
      passed: checks.length - failed.length,
      total: checks.length,
      failed: failed.map(({ id, description, detail }) => ({ id, description, detail })),
    },
  };
}

/** One compact line-set per node, for snapshot_state. */
export function summariseSnapshot(topology, snapshot) {
  const out = {};
  for (const node of topology.nodes) {
    const s = snapshot[node.name];
    const entry = { kind: node.kind };
    if (s.interfaces?.error) entry.error = s.interfaces.error;
    if (Array.isArray(s.interfaces)) {
      entry.interfaces = s.interfaces
        .filter((i) => toEth(i.name) || /^lo|^Loopback/.test(i.name))
        .map((i) => `${i.name} ${i.admin}/${i.oper} ${i.addresses.join(",")}`.trim());
    }
    if (Array.isArray(s.ospf)) entry.ospf_neighbors = s.ospf.map((n) => `${n.neighbor_id} ${n.state} on ${n.interface}`);
    if (s.bgp?.peers) entry.bgp_peers = s.bgp.peers.map((p) => `${p.peer} AS${p.remote_as} ${p.state} pfx=${p.prefixes_received}`);
    if (Array.isArray(s.routes)) {
      entry.route_count = s.routes.reduce((acc, r) => ({ ...acc, [r.protocol]: (acc[r.protocol] ?? 0) + 1 }), {});
    }
    out[node.name] = entry;
  }
  return out;
}

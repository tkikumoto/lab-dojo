// Fault catalogue. Each fault knows where it can be applied in a topology, how
// to inject it on FRR and on cEOS, what the learner is told (a vague ticket),
// progressive hints, the solution, and any extra checks needed to prove it is
// fixed when the generic health checks would not notice (e.g. packet loss).
import { remote } from "./remote.mjs";
import { isBare, loopbackLabel, nodeByName, osIfName, toEth, usesBgp, usesOspf } from "./topology.mjs";

function linkEnds(topology) {
  return topology.links.flatMap((link) => [[link.a, link.b], [link.b, link.a]].map(([self, other]) => ({
    node: self.node,
    interface: self.interface,
    peer: other.node,
    peer_interface: other.interface,
    link: link.id,
  })));
}

function osIf(topology, node, eth) {
  return osIfName(nodeByName(topology, node).kind, eth);
}

function linkLabel(topology, p) {
  return `${p.node} ${osIf(topology, p.node, p.interface)} <-> ${p.peer} ${osIf(topology, p.peer, p.peer_interface)}`;
}

function bgpEnds(topology) {
  return topology.bgp_sessions.flatMap((s) => [
    { node: s.a, peer_ip: s.b_ip, peer: s.b, session_type: s.type },
    { node: s.b, peer_ip: s.a_ip, peer: s.a, session_type: s.type },
  ]);
}

/** Fills in or validates link-endpoint parameters supplied by the caller. */
function resolveLinkEnd(topology, params, filter = () => true) {
  const ends = linkEnds(topology).filter(filter);
  const eth = params.interface ? toEth(params.interface) : undefined;
  // A name toEth cannot read must fail, not fall back to "any interface".
  const match = (!params.interface || eth) && ends.find((e) => e.node === params.node && (!eth || e.interface === eth));
  if (!match) {
    throw new Error(`no suitable link interface on ${params.node}${params.interface ? ` ${params.interface}` : ""}. `
      + `Valid: ${ends.map((e) => `${e.node} ${osIf(topology, e.node, e.interface)}`).join(", ") || "none"}`);
  }
  return match;
}

function resolveBgpEnd(topology, params) {
  const ends = bgpEnds(topology);
  const match = ends.find((e) => e.node === params.node && (!params.peer_ip || e.peer_ip === params.peer_ip)
    && (!params.peer || e.peer === params.peer));
  if (!match) {
    throw new Error(`no BGP session matches node=${params.node} peer=${params.peer ?? params.peer_ip ?? "?"}. `
      + `Valid: ${ends.map((e) => `${e.node}->${e.peer}(${e.peer_ip})`).join(", ") || "none"}`);
  }
  return match;
}

const frrOrCeos = (topology, node, frrLines, ceosLines) =>
  ({ op: "configure", node, lines: nodeByName(topology, node).kind === "frr" ? frrLines : ceosLines });

export const FAULTS = {
  interface_shutdown: {
    family: "layer1",
    difficulty: 1,
    summary: "Administratively shut down one end of a link.",
    applies: (t) => t.links.length > 0,
    candidates: (t) => linkEnds(t),
    resolve: (t, p) => resolveLinkEnd(t, p),
    actions: (t, p) => [{ op: "configure", node: p.node, lines: [`interface ${osIf(t, p.node, p.interface)}`, "shutdown"] }],
    ticket: (t, p) => `Monitoring reports that ${p.node} lost connectivity to one of its neighbours after a maintenance window.`,
    hints: (t, p) => [
      "Start at the bottom of the stack: check interface status on the routers involved.",
      `Look closely at ${p.node} ${osIf(t, p.node, p.interface)}. Is it up/up? What does the interface configuration say?`,
      `${p.node} ${osIf(t, p.node, p.interface)} is administratively shut down.`,
    ],
    solution: (t, p) => `On ${p.node}: interface ${osIf(t, p.node, p.interface)} -> no shutdown.`,
  },

  link_down: {
    family: "layer1",
    difficulty: 1,
    summary: "Take a link down at the Linux level on an FRR node (like a pulled cable). Not available when both ends are cEOS.",
    applies: (t) => linkEnds(t).some((e) => nodeByName(t, e.node).kind === "frr"),
    candidates: (t) => linkEnds(t).filter((e) => nodeByName(t, e.node).kind === "frr"),
    resolve: (t, p) => resolveLinkEnd(t, p, (e) => nodeByName(t, e.node).kind === "frr"),
    actions: (t, p) => [{ op: "link-state", node: p.node, interface: p.interface, state: "down" }],
    ticket: (t, p) => `The link between ${p.node} and ${p.peer} went down during the night. Nobody admits to changing anything.`,
    hints: (t, p) => [
      "Compare the interface state on both ends of the failing link.",
      `${p.peer} sees the link as down (no carrier). On ${p.node}, the interface is down although the configuration has no 'shutdown'.`,
      `${p.node} ${p.interface} was disabled outside of the routing configuration. 'no shutdown' on ${p.node} ${p.interface} re-enables it, or ask the tutor to repair the link.`,
    ],
    solution: (t, p) => `${p.node} ${p.interface} was brought down at the Linux level (ip link set down). Fix: on ${p.node}, interface ${p.interface} -> no shutdown (zebra re-enables the kernel link), or tutor: reset_exercise with this fault_id.`,
  },

  wrong_ip_address: {
    family: "ip",
    difficulty: 1,
    summary: "Re-address one end of a link into the wrong subnet (swapped octets).",
    applies: (t) => t.links.length > 0 && !isBare(t),
    candidates: (t) => linkEnds(t),
    resolve: (t, p) => {
      const end = resolveLinkEnd(t, p);
      const self = nodeByName(t, end.node).interfaces.find((i) => i.name === end.interface);
      const [o1, o2, o3, o4] = self.ip.split(".");
      return { ...end, old_ip: self.ip, new_ip: `${o1}.${o3}.${o2}.${o4}` };
    },
    actions: (t, p) => [frrOrCeos(t, p.node,
      [`interface ${p.interface}`, `no ip address ${p.old_ip}/30`, `ip address ${p.new_ip}/30`],
      [`interface ${osIf(t, p.node, p.interface)}`, `ip address ${p.new_ip}/30`])],
    ticket: (t, p) => `After a re-addressing change on ${p.node}, routing between ${p.node} and ${p.peer} has stopped working although the link is up.`,
    hints: (t, p) => [
      "The physical link is fine. Can the two directly connected routers ping each other's interface address?",
      `Compare the IP address and subnet on ${p.node} ${osIf(t, p.node, p.interface)} with the address on ${p.peer}.`,
      `${p.node} ${osIf(t, p.node, p.interface)} has ${p.new_ip}/30; the design says ${p.old_ip}/30.`,
    ],
    solution: (t, p) => `On ${p.node}: interface ${osIf(t, p.node, p.interface)} -> replace ${p.new_ip}/30 with ${p.old_ip}/30.`,
  },

  mtu_mismatch: {
    family: "ospf",
    difficulty: 3,
    settle_seconds: 10,
    summary: "Lower the MTU on one end of an OSPF link to 1400 so the adjacency sticks in ExStart/Exchange.",
    applies: (t) => usesOspf(t) && t.links.length > 0,
    candidates: (t) => linkEnds(t),
    resolve: (t, p) => resolveLinkEnd(t, p),
    actions: (t, p) => (nodeByName(t, p.node).kind === "frr"
      ? [{ op: "link-mtu", node: p.node, interface: p.interface, mtu: 1400 }]
      : [{ op: "configure", node: p.node, lines: [`interface ${osIf(t, p.node, p.interface)}`, "mtu 1400", "shutdown", "no shutdown"] }]),
    ticket: (t, p) => `After a link maintenance, routing between ${p.node} and ${p.peer} never recovered, although the link itself is up and pings across it work.`,
    hints: (t, p) => [
      "Interfaces are up and addressing is correct, yet the OSPF adjacency is not FULL. Which state is it stuck in?",
      "An adjacency stuck in ExStart/Exchange means the routers see each other's hellos but cannot exchange Database Description packets. What is carried in a DBD that must match?",
      `Compare the interface MTU on ${p.node} ${osIf(t, p.node, p.interface)} and ${p.peer} ${osIf(t, p.peer, p.peer_interface)}.`,
    ],
    solution: (t, p) => (nodeByName(t, p.node).kind === "frr"
      ? `${p.node} ${p.interface} has Linux MTU 1400 vs 1500 on ${p.peer}. Fix: tutor repairs the link MTU (reset_exercise with this fault_id), or workaround 'ip ospf mtu-ignore' on both ends.`
      : `On ${p.node}: interface ${osIf(t, p.node, p.interface)} -> no mtu (back to 1500).`),
  },

  ospf_area_mismatch: {
    family: "ospf",
    difficulty: 2,
    summary: "Move one end of a link into OSPF area 0.0.0.1.",
    applies: (t) => usesOspf(t) && t.links.length > 0,
    candidates: (t) => linkEnds(t),
    resolve: (t, p) => {
      const end = resolveLinkEnd(t, p);
      return { ...end, subnet: t.links[end.link].subnet };
    },
    actions: (t, p) => [frrOrCeos(t, p.node,
      ["router ospf", `no network ${p.subnet} area 0.0.0.0`, `network ${p.subnet} area 0.0.0.1`],
      ["router ospf 1", `no network ${p.subnet} area 0.0.0.0`, `network ${p.subnet} area 0.0.0.1`])],
    ticket: (t, p) => `The NOC sees one OSPF adjacency fewer than designed. ${p.node} was the last router changed.`,
    hints: (t, p) => [
      "Links and IP addressing are fine. Find which OSPF adjacency is missing.",
      "If two neighbours never even reach Init, they are discarding each other's hellos. Which hello fields must match?",
      `Compare 'show ip ospf interface' for ${p.node} ${osIf(t, p.node, p.interface)} and ${p.peer} ${osIf(t, p.peer, p.peer_interface)}, especially the area.`,
    ],
    solution: (t, p) => `On ${p.node}: router ospf -> no network ${p.subnet} area 0.0.0.1; network ${p.subnet} area 0.0.0.0.`,
  },

  ospf_hello_mismatch: {
    family: "ospf",
    difficulty: 2,
    settle_seconds: 45,
    summary: "Set the OSPF hello interval to 5s on one end of a link (adjacency drops when the dead timer expires).",
    applies: (t) => usesOspf(t) && t.links.length > 0,
    candidates: (t) => linkEnds(t),
    resolve: (t, p) => resolveLinkEnd(t, p),
    actions: (t, p) => [{ op: "configure", node: p.node, lines: [`interface ${osIf(t, p.node, p.interface)}`, "ip ospf hello-interval 5"] }],
    ticket: (t, p) => `An OSPF adjacency near ${p.node} went down about a minute after a tuning change and has not recovered.`,
    hints: (t, p) => [
      "Find which OSPF adjacency is missing, then compare the OSPF settings on both ends of that link.",
      "Neighbours must agree on area, subnet, authentication, and two timers to accept each other's hellos.",
      `Compare the hello/dead intervals on ${p.node} ${osIf(t, p.node, p.interface)} and ${p.peer} ${osIf(t, p.peer, p.peer_interface)}.`,
    ],
    solution: (t, p) => `On ${p.node}: interface ${osIf(t, p.node, p.interface)} -> no ip ospf hello-interval.`,
  },

  ospf_passive_interface: {
    family: "ospf",
    difficulty: 2,
    settle_seconds: 45,
    summary: "Make one end of an OSPF link passive.",
    applies: (t) => usesOspf(t) && t.links.length > 0,
    candidates: (t) => linkEnds(t),
    resolve: (t, p) => resolveLinkEnd(t, p),
    actions: (t, p) => [frrOrCeos(t, p.node,
      [`interface ${p.interface}`, "ip ospf passive"],
      ["router ospf 1", `passive-interface ${osIf(t, p.node, p.interface)}`])],
    ticket: (t, p) => `After a security hardening change on ${p.node}, one OSPF neighbour disappeared.`,
    hints: (t, p) => [
      "Find the missing adjacency. Is the link subnet still advertised even though there is no neighbour?",
      `Does ${p.node} send OSPF hellos on ${osIf(t, p.node, p.interface)} at all? Check 'show ip ospf interface'.`,
      `${p.node} ${osIf(t, p.node, p.interface)} is a passive OSPF interface.`,
    ],
    solution: (t, p) => (nodeByName(t, p.node).kind === "frr"
      ? `On ${p.node}: interface ${p.interface} -> no ip ospf passive.`
      : `On ${p.node}: router ospf 1 -> no passive-interface ${osIf(t, p.node, p.interface)}.`),
  },

  ospf_auth_mismatch: {
    family: "ospf",
    difficulty: 3,
    settle_seconds: 45,
    summary: "Enable OSPF MD5 authentication on only one end of a link.",
    applies: (t) => usesOspf(t) && t.links.length > 0,
    candidates: (t) => linkEnds(t),
    resolve: (t, p) => resolveLinkEnd(t, p),
    actions: (t, p) => [frrOrCeos(t, p.node,
      [`interface ${p.interface}`, "ip ospf authentication message-digest", "ip ospf message-digest-key 1 md5 Lab-Key-7"],
      [`interface ${osIf(t, p.node, p.interface)}`, "ip ospf authentication message-digest", "ip ospf message-digest-key 1 md5 0 Lab-Key-7"])],
    ticket: (t, p) => `Security asked for OSPF authentication to be rolled out. Shortly after work started on ${p.node}, an adjacency was lost.`,
    hints: (t, p) => [
      "Find the missing adjacency and compare the OSPF interface settings on both ends.",
      "Hellos can be silently dropped if the two ends do not agree on how packets are authenticated.",
      `${p.node} ${osIf(t, p.node, p.interface)} uses MD5 authentication; ${p.peer} does not.`,
    ],
    solution: (t, p) => `Either remove authentication on ${p.node} ${osIf(t, p.node, p.interface)} (no ip ospf authentication; no ip ospf message-digest-key 1), or configure the same MD5 key 1 'Lab-Key-7' on ${p.peer}.`,
  },

  static_blackhole: {
    family: "ip",
    difficulty: 2,
    summary: "Add a static /32 to Null0 for another router's loopback.",
    applies: (t) => t.nodes.length > 1 && !isBare(t),
    candidates: (t) => t.nodes.flatMap((n) => t.nodes.filter((o) => o !== n).map((o) => ({ node: n.name, target: o.name }))),
    resolve: (t, p) => {
      nodeByName(t, p.node);
      const wanted = p.target ?? p.peer;
      const target = wanted ? nodeByName(t, wanted) : t.nodes.find((n) => n.name !== p.node);
      if (target.name === p.node) throw new Error("static_blackhole target must be a different node");
      return { node: p.node, target: target.name, prefix: `${target.loopback}/32` };
    },
    actions: (t, p) => [{ op: "configure", node: p.node, lines: [`ip route ${p.prefix} Null0`] }],
    ticket: (t, p) => `Traffic from ${p.node} to ${loopbackLabel(nodeByName(t, p.target))} is failing. Other destinations seem fine and no routing alarms were raised.`,
    hints: (t, p) => [
      "Routing protocols look healthy. Look at what the routing table actually selects for the failing destination.",
      `Check 'show ip route ${p.prefix.replace("/32", "")}' on ${p.node}. Which protocol wins, and why?`,
      `${p.node} has a static route for ${p.prefix} to Null0, which beats the dynamic route on administrative distance.`,
    ],
    solution: (t, p) => `On ${p.node}: no ip route ${p.prefix} Null0.`,
  },

  bgp_neighbor_shutdown: {
    family: "bgp",
    difficulty: 1,
    summary: "Administratively shut down a BGP neighbour on one side.",
    applies: (t) => t.bgp_sessions.length > 0,
    candidates: (t) => bgpEnds(t),
    resolve: (t, p) => resolveBgpEnd(t, p),
    actions: (t, p) => [{ op: "configure", node: p.node, lines: [`router bgp ${nodeByName(t, p.node).asn}`, `neighbor ${p.peer_ip} shutdown`] }],
    ticket: (t, p) => `The BGP session between ${p.node} and ${p.peer} is down after a planned maintenance that should have been reverted.`,
    hints: (t, p) => [
      "Check the BGP summary on both routers. What state does each side report?",
      "Idle (Admin) or a peer that never even tries to connect is a strong clue.",
      `${p.node} has 'neighbor ${p.peer_ip} shutdown'.`,
    ],
    solution: (t, p) => `On ${p.node}: router bgp ${nodeByName(t, p.node).asn} -> no neighbor ${p.peer_ip} shutdown.`,
  },

  bgp_wrong_remote_as: {
    family: "bgp",
    difficulty: 2,
    summary: "Configure the wrong remote AS for a BGP neighbour.",
    applies: (t) => t.bgp_sessions.length > 0,
    candidates: (t) => bgpEnds(t),
    resolve: (t, p) => {
      const end = resolveBgpEnd(t, p);
      const correct = nodeByName(t, end.peer).asn;
      return { ...end, correct_as: correct, wrong_as: correct + 100 };
    },
    actions: (t, p) => [{ op: "configure", node: p.node, lines: [`router bgp ${nodeByName(t, p.node).asn}`, `neighbor ${p.peer_ip} remote-as ${p.wrong_as}`] }],
    ticket: (t, p) => `A BGP session involving ${p.node} keeps failing since the peering details were re-entered from a spreadsheet.`,
    hints: (t, p) => [
      "Which BGP session is not Established? Check the BGP summary on both ends.",
      "A session that reaches OpenSent/Active and then resets often means the OPEN message is rejected. What does each side expect in it?",
      `Compare the remote-as that ${p.node} configures for ${p.peer_ip} with the AS ${p.peer} actually uses.`,
    ],
    solution: (t, p) => `On ${p.node}: router bgp ${nodeByName(t, p.node).asn} -> neighbor ${p.peer_ip} remote-as ${p.correct_as}.`,
  },

  bgp_missing_network: {
    family: "bgp",
    difficulty: 2,
    summary: "Stop a router from advertising its service prefix in BGP.",
    applies: (t) => usesBgp(t),
    candidates: (t) => t.nodes.map((n) => ({ node: n.name })),
    resolve: (t, p) => ({ node: p.node, prefix: nodeByName(t, p.node).service_prefix }),
    actions: (t, p) => {
      const asn = nodeByName(t, p.node).asn;
      return [frrOrCeos(t, p.node,
        [`router bgp ${asn}`, "address-family ipv4 unicast", `no network ${p.prefix}`, "exit-address-family"],
        [`router bgp ${asn}`, `no network ${p.prefix}`])];
    },
    ticket: (t, p) => `Customers in ${p.prefix} (behind ${p.node}) cannot be reached from anywhere else, yet all BGP sessions are up.`,
    hints: (t, p) => [
      "Sessions are Established. Follow the prefix: who should originate it, and does anyone receive it?",
      `Does ${p.node} have ${p.prefix} in its own BGP table? Check 'show bgp' on ${p.node}.`,
      `${p.node} no longer has a 'network ${p.prefix}' statement.`,
    ],
    solution: (t, p) => `On ${p.node}: router bgp ${nodeByName(t, p.node).asn} -> network ${p.prefix}`
      + (nodeByName(t, p.node).kind === "frr" ? " (under address-family ipv4 unicast)." : "."),
  },

  bgp_inbound_filter: {
    family: "bgp",
    difficulty: 3,
    summary: "Apply a deny-all inbound route-map to one BGP neighbour.",
    applies: (t) => t.bgp_sessions.length > 0,
    candidates: (t) => bgpEnds(t),
    resolve: (t, p) => resolveBgpEnd(t, p),
    actions: (t, p) => {
      const asn = nodeByName(t, p.node).asn;
      return [frrOrCeos(t, p.node,
        ["route-map IMPORT-POLICY deny 10", `router bgp ${asn}`, "address-family ipv4 unicast", `neighbor ${p.peer_ip} route-map IMPORT-POLICY in`, "exit-address-family"],
        ["route-map IMPORT-POLICY deny 10", `router bgp ${asn}`, `neighbor ${p.peer_ip} route-map IMPORT-POLICY in`])];
    },
    checks: (t, p) => [{ type: "bgp_prefixes", node: p.node, peer: p.peer_ip, min: 1 }],
    ticket: (t, p) => `Since a policy change, ${p.node} no longer learns any routes from ${p.peer}, although the session is up.`,
    hints: (t, p) => [
      "The session is Established, so the problem is in what is accepted, not in the peering itself.",
      `Compare what ${p.peer} sends with what ${p.node} accepts from ${p.peer_ip}. Is any policy applied to that neighbour?`,
      `${p.node} applies route-map IMPORT-POLICY inbound on ${p.peer_ip}, and that route-map denies everything.`,
    ],
    solution: (t, p) => `On ${p.node}: remove 'neighbor ${p.peer_ip} route-map IMPORT-POLICY in' (or make IMPORT-POLICY permit).`,
  },

  packet_loss: {
    family: "quality",
    difficulty: 2,
    summary: "Add 25% packet loss on one end of a link (simulated bad cable/optic).",
    applies: (t) => t.links.length > 0 && !isBare(t),
    candidates: (t) => linkEnds(t).filter((e) => nodeByName(t, e.node).kind === "frr"),
    resolve: (t, p) => ({ ...resolveLinkEnd(t, p), loss_percent: p.loss_percent ?? 25 }),
    actions: (t, p) => [{ op: "netem", node: p.node, interface: p.interface, delay_ms: 0, jitter_ms: 0, loss_percent: p.loss_percent }],
    checks: (t, p) => [{ type: "ping_quality", from: p.node, to: p.peer, count: 20, max_loss_percent: 0 }],
    ticket: (t, p) => `Users report intermittent timeouts for traffic between ${loopbackLabel(nodeByName(t, p.node))} and ${loopbackLabel(nodeByName(t, p.peer))}. Routing has been stable all day.`,
    hints: (t, p) => [
      "Routing is stable. The problem is the quality of the path, not the path itself. Try longer pings (count 20).",
      "Ping hop by hop with large counts to find the segment where loss starts.",
      `Packets are being dropped on the ${linkLabel(t, p)} link.`,
    ],
    solution: (t, p) => `Simulated faulty link: ${p.loss_percent}% loss on ${p.node} ${p.interface}. Fix: tutor replaces the 'cable' (reset_exercise with this fault_id).`,
  },

  high_latency: {
    family: "quality",
    difficulty: 2,
    summary: "Add 200 ms of delay on one end of a link.",
    applies: (t) => t.links.length > 0 && !isBare(t),
    candidates: (t) => linkEnds(t).filter((e) => nodeByName(t, e.node).kind === "frr"),
    resolve: (t, p) => ({ ...resolveLinkEnd(t, p), delay_ms: p.delay_ms ?? 200 }),
    actions: (t, p) => [{ op: "netem", node: p.node, interface: p.interface, delay_ms: p.delay_ms, jitter_ms: 10, loss_percent: 0 }],
    checks: (t, p) => [{ type: "ping_quality", from: p.node, to: p.peer, count: 5, max_loss_percent: 20, max_avg_rtt_ms: 50 }],
    ticket: (t, p) => `Applications between ${loopbackLabel(nodeByName(t, p.node))} and ${loopbackLabel(nodeByName(t, p.peer))} have become very slow. Nothing is down.`,
    hints: (t, p) => [
      "Everything is reachable. Measure round-trip times between the routers involved.",
      "Use traceroute and per-hop pings to find which link adds the latency.",
      `The ${linkLabel(t, p)} link adds about ${p.delay_ms} ms.`,
    ],
    solution: (t, p) => `Simulated degraded link: ${p.delay_ms} ms delay on ${p.node} ${p.interface}. Fix: tutor repairs it (reset_exercise with this fault_id).`,
  },
};

export const FAULT_TYPES = Object.keys(FAULTS);
export const FAMILIES = ["layer1", "ip", "ospf", "bgp", "quality"];

/** Executes the low-level operations a fault is made of. */
export async function runActions(lab, actions) {
  const output = [];
  for (const a of actions) {
    switch (a.op) {
      case "configure":
        output.push(await remote("configure", [lab, a.node], { input: a.lines.join("\n") }));
        break;
      case "link-state":
        output.push(await remote("link-state", [lab, a.node, a.interface, a.state]));
        break;
      case "link-mtu":
        output.push(await remote("link-mtu", [lab, a.node, a.interface, a.mtu]));
        break;
      case "netem":
        output.push(await remote("netem", [lab, a.node, a.interface, "set", a.delay_ms, a.jitter_ms, a.loss_percent]));
        break;
      default:
        throw new Error(`unknown fault action ${a.op}`);
    }
  }
  return output.join("\n").trim();
}

export function nodesTouched(actions) {
  return [...new Set(actions.map((a) => a.node))];
}

/** Small deterministic PRNG so exercises can be reproduced with a seed. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

/** Turns a fault type plus (possibly partial) params into a fully resolved fault. */
export function planFault(topology, type, params, random) {
  const def = FAULTS[type];
  if (!def) throw new Error(`unknown fault type ${type}. Known: ${FAULT_TYPES.join(", ")}`);
  if (!def.applies(topology)) throw new Error(`fault ${type} does not apply to lab ${topology.name} (routing: ${topology.routing})`);
  let base = params ?? {};
  if (!base.node) {
    const candidates = def.candidates(topology);
    if (!candidates.length) throw new Error(`no valid target for ${type} in lab ${topology.name}`);
    base = { ...pick(random, candidates), ...base };
  }
  const resolved = def.resolve(topology, base);
  return {
    type,
    family: def.family,
    params: resolved,
    actions: def.actions(topology, resolved),
    checks: def.checks?.(topology, resolved) ?? [],
    settle_seconds: def.settle_seconds ?? 5,
  };
}

/** The tutor-only description of an injected fault. */
export function describeFault(topology, fault) {
  const def = FAULTS[fault.type];
  return {
    id: fault.id,
    type: fault.type,
    family: def.family,
    target: fault.params,
    what_was_done: def.summary,
    solution: def.solution(topology, fault.params),
  };
}

export function faultTicket(topology, fault) {
  return FAULTS[fault.type].ticket(topology, fault.params);
}

export function faultHints(topology, fault) {
  return FAULTS[fault.type].hints(topology, fault.params);
}

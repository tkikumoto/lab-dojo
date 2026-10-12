// Turns a template or a node/link list into a fully addressed topology model,
// and renders per-node startup configurations for FRR and Arista cEOS.
//
// Addressing plan (deterministic, so learners can reason about it):
//   node index i (1-based, in declaration order)
//   loopback         10.255.0.i/32
//   service prefix   172.16.i.0/24 (BGP modes only, on a loopback)
//   link i<->j       10.i.j.(4k)/30, lower index gets .1, k = parallel link number
//   ASN              65000+i for eBGP, 65000 everywhere for iBGP
// Routing "bare" is cabling only: no loopback and no link addresses. A bare cEOS
// link port stays a default switchport, so bare is also the layer 2 lab.

// A host is a Linux machine, not a router: it gets no generated addresses or
// routing, has no router CLI, and the person using the lab configures it.
export const KINDS = ["frr", "ceos", "host"];
export const TEMPLATES = ["line", "ring", "full-mesh", "star", "leaf-spine"];
export const ROUTING_MODES = ["ospf", "ebgp", "ibgp-ospf", "none", "bare"];
export const LIMITS = { nodes: 16, ceosPerLab: 6, fullMesh: 8, spines: 4, leaves: 8, links: 48 };

const NAME_RE = /^[a-z][a-z0-9-]{0,14}$/;
// 'all' and 'loopback' are tool keywords; the VM helper refuses config lines containing the other words.
const RESERVED_NAME_RE = /^(all|loopback)$|bash|shell|python|sudo/;
export const LAB_NAME_RE = /^[a-z][a-z0-9-]{0,19}$/;

export function usesOspf(topology) {
  return topology.routing === "ospf" || topology.routing === "ibgp-ospf";
}

export function usesBgp(topology) {
  return topology.routing === "ebgp" || topology.routing === "ibgp-ospf";
}

export function isBare(topology) {
  return topology.routing === "bare";
}

export function isRouter(node) {
  return node.kind !== "host";
}

/** Links with a router on both ends: the only ones routing, adjacencies and faults apply to. */
export function routerLinks(topology) {
  return topology.links.filter((l) => isRouter(nodeByName(topology, l.a.node)) && isRouter(nodeByName(topology, l.b.node)));
}

/** Maps eth1 / Ethernet1 / et1 to the Containerlab name eth1. */
export function toEth(name) {
  const match = /^(?:ethernet|eth|et)\s*(\d+)$/i.exec(String(name).trim());
  return match ? `eth${Number(match[1])}` : null;
}

export function osIfName(kind, eth) {
  return kind === "ceos" ? eth.replace(/^eth/, "Ethernet") : eth;
}

export function loopbackIfName(kind) {
  return kind === "ceos" ? "Loopback0" : "lo";
}

/** "r1 (lo 10.255.0.1)": names the exact address a check or ticket is about, since a node has several. */
export function loopbackLabel(node) {
  return `${node.name} (${loopbackIfName(node.kind)} ${node.loopback})`;
}

function templateNodes(input) {
  const kind = input.kind ?? "frr";
  const named = (prefix, count) => Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i + 1}`, kind }));
  const links = [];
  let nodes;
  switch (input.template) {
    case "line":
    case "ring":
    case "full-mesh":
    case "star": {
      const size = input.size ?? 3;
      const min = input.template === "ring" ? 3 : 2;
      if (size < min || size > LIMITS.nodes) throw new Error(`${input.template} needs ${min}-${LIMITS.nodes} nodes`);
      if (input.template === "full-mesh" && size > LIMITS.fullMesh) {
        throw new Error(`full-mesh is limited to ${LIMITS.fullMesh} nodes`);
      }
      nodes = named("r", size);
      if (input.template === "line" || input.template === "ring") {
        for (let i = 0; i + 1 < size; i += 1) links.push({ a: nodes[i].name, b: nodes[i + 1].name });
        if (input.template === "ring") links.push({ a: nodes[size - 1].name, b: nodes[0].name });
      } else if (input.template === "full-mesh") {
        for (let i = 0; i < size; i += 1) {
          for (let j = i + 1; j < size; j += 1) links.push({ a: nodes[i].name, b: nodes[j].name });
        }
      } else {
        for (let i = 1; i < size; i += 1) links.push({ a: nodes[0].name, b: nodes[i].name });
      }
      break;
    }
    case "leaf-spine": {
      const spines = input.spines ?? 2;
      const leaves = input.leaves ?? 3;
      if (spines < 1 || spines > LIMITS.spines) throw new Error(`leaf-spine supports 1-${LIMITS.spines} spines`);
      if (leaves < 1 || leaves > LIMITS.leaves) throw new Error(`leaf-spine supports 1-${LIMITS.leaves} leaves`);
      const spineNodes = named("spine", spines);
      const leafNodes = named("leaf", leaves);
      nodes = [...spineNodes, ...leafNodes];
      for (const leaf of leafNodes) for (const spine of spineNodes) links.push({ a: spine.name, b: leaf.name });
      break;
    }
    default:
      throw new Error(`unknown template ${input.template}`);
  }
  return { nodes, links };
}

/**
 * Validates the create_topology request and returns the full topology model.
 * Every input path ends here, so names, counts and kinds are checked once.
 */
export function buildTopology(input) {
  if (!LAB_NAME_RE.test(input.name ?? "")) {
    throw new Error("lab name must be 1-20 characters: lowercase letters, digits and '-', starting with a letter");
  }
  if (input.template && input.nodes) throw new Error("give either template or nodes, not both");
  if (!input.template && !input.nodes) throw new Error("give a template or an explicit nodes list");

  const base = input.template
    ? templateNodes(input)
    : { nodes: input.nodes.map((n) => ({ name: n.name, kind: n.kind ?? input.kind ?? "frr", image: n.image })), links: input.links ?? [] };

  for (const [name, kind] of Object.entries(input.node_kinds ?? {})) {
    const node = base.nodes.find((n) => n.name === name);
    if (!node) throw new Error(`node_kinds refers to unknown node ${name}`);
    node.kind = kind;
  }

  const routing = input.routing ?? "ospf";
  if (!ROUTING_MODES.includes(routing)) throw new Error(`routing must be one of ${ROUTING_MODES.join(", ")}`);
  if (base.nodes.length < 1 || base.nodes.length > LIMITS.nodes) throw new Error(`a lab needs 1-${LIMITS.nodes} nodes`);
  if (base.nodes.filter((n) => n.kind === "ceos").length > LIMITS.ceosPerLab) {
    throw new Error(`at most ${LIMITS.ceosPerLab} cEOS nodes per lab (each needs ~1.5 GB RAM)`);
  }
  if (base.links.length > LIMITS.links) throw new Error(`at most ${LIMITS.links} links per lab`);

  const bare = routing === "bare";
  const nodes = base.nodes.map((n, i) => {
    if (!NAME_RE.test(n.name)) throw new Error(`invalid node name ${n.name}: lowercase letters, digits and '-', max 15`);
    if (RESERVED_NAME_RE.test(n.name)) {
      throw new Error(`node name ${n.name} is reserved: not 'all' or 'loopback', and no bash, shell, python or sudo in the name`);
    }
    if (!KINDS.includes(n.kind)) throw new Error(`node ${n.name}: kind must be one of ${KINDS.join(", ")}`);
    const index = i + 1;
    if (n.kind === "host") {
      if (n.image != null && !LAB_NAME_RE.test(n.image)) throw new Error(`node ${n.name}: image is the name of a registered image (see check_setup), not ${n.image}`);
      if (input.extra_config?.[n.name]) throw new Error(`node ${n.name} is a host: it has no startup configuration`);
      return { name: n.name, kind: n.kind, index, ...(n.image ? { image: n.image } : {}), interfaces: [], extra_config: [] };
    }
    if (n.image != null) throw new Error(`node ${n.name}: only a host node takes an image`);
    return {
      name: n.name,
      kind: n.kind,
      index,
      loopback: bare ? undefined : `10.255.0.${index}`,
      asn: routing === "ebgp" ? 65000 + index : routing === "ibgp-ospf" ? 65000 : undefined,
      service_prefix: routing === "ebgp" || routing === "ibgp-ospf" ? `172.16.${index}.0/24` : undefined,
      interfaces: [],
      extra_config: input.extra_config?.[n.name] ?? [],
    };
  });
  const byName = new Map(nodes.map((n) => [n.name, n]));
  if (byName.size !== nodes.length) throw new Error("node names must be unique");
  for (const name of Object.keys(input.extra_config ?? {})) {
    if (!byName.has(name)) throw new Error(`extra_config refers to unknown node ${name}`);
  }

  const parallel = new Map();
  const links = base.links.map((link, id) => {
    let a = byName.get(link.a);
    let b = byName.get(link.b);
    if (!a || !b) throw new Error(`link ${link.a}-${link.b} refers to an unknown node`);
    if (a === b) throw new Error(`link ${link.a}-${link.b} connects a node to itself`);
    if (a.index > b.index) [a, b] = [b, a];
    const key = `${a.index}-${b.index}`;
    const k = parallel.get(key) ?? 0;
    parallel.set(key, k + 1);
    if (k >= 64) throw new Error(`too many parallel links between ${a.name} and ${b.name}`);
    const base4 = 4 * k;
    const subnet = bare ? undefined : `10.${a.index}.${b.index}.${base4}/30`;
    const ends = [[a, b, base4 + 1], [b, a, base4 + 2]].map(([node, , host]) => ({
      node: node.name,
      interface: `eth${node.interfaces.length + 1}`,
      // A host end stays unset: the subnet and the router's end are generated, the host's address is the user's.
      ip: bare || !isRouter(node) ? undefined : `10.${a.index}.${b.index}.${host}`,
    }));
    if (ends.some((end) => Number(end.interface.slice(3)) > 99)) throw new Error("too many links on one node");
    a.interfaces.push({ name: ends[0].interface, ip: ends[0].ip, prefix_len: ends[0].ip && 30, link: id, peer: ends[1] });
    b.interfaces.push({ name: ends[1].interface, ip: ends[1].ip, prefix_len: ends[1].ip && 30, link: id, peer: ends[0] });
    return { id, subnet, a: ends[0], b: ends[1] };
  });

  const bgp_sessions = [];
  const routers = nodes.filter(isRouter);
  if (routing === "ebgp") {
    for (const link of links) {
      if (link.a.ip && link.b.ip) bgp_sessions.push({ a: link.a.node, b: link.b.node, a_ip: link.a.ip, b_ip: link.b.ip, type: "ebgp" });
    }
  } else if (routing === "ibgp-ospf") {
    for (let i = 0; i < routers.length; i += 1) {
      for (let j = i + 1; j < routers.length; j += 1) {
        bgp_sessions.push({ a: routers[i].name, b: routers[j].name, a_ip: routers[i].loopback, b_ip: routers[j].loopback, type: "ibgp" });
      }
    }
  }

  return {
    name: input.name,
    template: input.template ?? "custom",
    routing,
    created_at: new Date().toISOString(),
    nodes,
    links,
    bgp_sessions,
  };
}

/** The line-oriented spec the VM helper turns into Containerlab YAML. */
export function helperSpec(topology) {
  return [
    ...topology.nodes.map((n) => `node ${n.name} ${n.kind}${n.image ? ` ${n.image}` : ""}`),
    ...topology.links.map((l) => `link ${l.a.node} ${l.a.interface} ${l.b.node} ${l.b.interface}`),
  ].join("\n") + "\n";
}

export function nodeByName(topology, name) {
  const node = topology.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`node ${name} is not in lab ${topology.name} (nodes: ${topology.nodes.map((n) => n.name).join(", ")})`);
  return node;
}

function bgpNeighbors(topology, node) {
  return topology.bgp_sessions
    .filter((s) => s.a === node.name || s.b === node.name)
    .map((s) => {
      const peerName = s.a === node.name ? s.b : s.a;
      return { ip: s.a === node.name ? s.b_ip : s.a_ip, peer: nodeByName(topology, peerName), type: s.type };
    });
}

function ospfNetworks(topology, node) {
  return [...node.interfaces.map((i) => topology.links[i.link].subnet), `${node.loopback}/32`];
}

function bgpNetworks(topology, node) {
  return topology.routing === "ebgp" ? [`${node.loopback}/32`, node.service_prefix] : [node.service_prefix];
}

function renderFrr(topology, node) {
  const out = ["frr defaults traditional", `hostname ${node.name}`, "service integrated-vtysh-config", "!"];
  if (node.loopback) {
    out.push("interface lo", ` ip address ${node.loopback}/32`);
    if (node.service_prefix) out.push(` ip address ${node.service_prefix.replace(/0\/24$/, "1/24")}`);
    out.push("exit", "!");
  }
  for (const intf of node.interfaces) {
    out.push(`interface ${intf.name}`, ` description to ${intf.peer.node} ${intf.peer.interface}`);
    if (intf.ip) out.push(` ip address ${intf.ip}/30`);
    if (usesOspf(topology)) out.push(" ip ospf network point-to-point");
    out.push("exit", "!");
  }
  if (usesOspf(topology)) {
    out.push("router ospf", ` ospf router-id ${node.loopback}`);
    for (const net of ospfNetworks(topology, node)) out.push(` network ${net} area 0.0.0.0`);
    out.push("exit", "!");
  }
  if (usesBgp(topology)) {
    out.push(`router bgp ${node.asn}`, ` bgp router-id ${node.loopback}`, " no bgp ebgp-requires-policy");
    for (const nbr of bgpNeighbors(topology, node)) {
      // A short connect-retry timer lets sessions recover within seconds after a fix
      // (FRR's default is 120 s).
      out.push(
        ` neighbor ${nbr.ip} remote-as ${nbr.peer.asn}`,
        ` neighbor ${nbr.ip} description ${nbr.peer.name}`,
        ` neighbor ${nbr.ip} timers connect 5`,
      );
      if (nbr.type === "ibgp") out.push(` neighbor ${nbr.ip} update-source lo`);
    }
    out.push(" address-family ipv4 unicast");
    for (const net of bgpNetworks(topology, node)) out.push(`  network ${net}`);
    out.push(" exit-address-family", "exit", "!");
  }
  out.push(...node.extra_config, "!");
  return out.join("\n");
}

function renderCeos(topology, node) {
  // Bare: no routing, and link ports stay default switchports (layer 2, STP runs).
  // A startup file replaces Containerlab's cEOS default whole, so its admin/admin login is repeated here.
  const out = [`hostname ${node.name}`, "username admin privilege 15 secret admin", ...(isBare(topology) ? [] : ["ip routing"]), "!"];
  if (node.loopback) out.push("interface Loopback0", `   ip address ${node.loopback}/32`, "!");
  if (node.service_prefix) out.push("interface Loopback1", `   ip address ${node.service_prefix.replace(/0\/24$/, "1/24")}`, "!");
  for (const intf of node.interfaces) {
    out.push(
      `interface ${osIfName("ceos", intf.name)}`,
      `   description to ${intf.peer.node} ${osIfName(nodeByName(topology, intf.peer.node).kind, intf.peer.interface)}`,
    );
    if (intf.ip) out.push("   no switchport", `   ip address ${intf.ip}/30`);
    if (usesOspf(topology)) out.push("   ip ospf network point-to-point");
    out.push("!");
  }
  if (usesOspf(topology)) {
    out.push("router ospf 1", `   router-id ${node.loopback}`);
    for (const net of ospfNetworks(topology, node)) out.push(`   network ${net} area 0.0.0.0`);
    out.push("   max-lsa 12000", "!");
  }
  if (usesBgp(topology)) {
    out.push(`router bgp ${node.asn}`, `   router-id ${node.loopback}`);
    for (const nbr of bgpNeighbors(topology, node)) {
      out.push(`   neighbor ${nbr.ip} remote-as ${nbr.peer.asn}`, `   neighbor ${nbr.ip} description ${nbr.peer.name}`);
      if (nbr.type === "ibgp") out.push(`   neighbor ${nbr.ip} update-source Loopback0`);
    }
    for (const net of bgpNetworks(topology, node)) out.push(`   network ${net}`);
    out.push("!");
  }
  out.push(...node.extra_config, "!");
  return out.join("\n");
}

/** The node's startup configuration, or null for a host, which has none. */
export function renderStartupConfig(topology, node) {
  if (!isRouter(node)) return null;
  return node.kind === "ceos" ? renderCeos(topology, node) : renderFrr(topology, node);
}

/** The command a human runs on the VM to open a node's CLI. */
export function cliCommand(topology, node) {
  // The built-in host image has bash; another registered image may only have sh.
  const cli = { ceos: "Cli", frr: "vtysh", host: node.image ? "sh" : "bash" }[node.kind];
  return `docker exec -it clab-${topology.name}-${node.name} ${cli}`;
}

/** A node's link interfaces with the neighbour and neighbour interface each one faces (vendor names). */
export function linkInterfaces(topology, node) {
  return node.interfaces.map((i) => ({
    interface: osIfName(node.kind, i.name),
    ip: i.ip && `${i.ip}/${i.prefix_len}`,
    peer: i.peer.node,
    peer_interface: osIfName(nodeByName(topology, i.peer.node).kind, i.peer.interface),
  }));
}

/**
 * How a human reaches each node of a deployed lab: management IP, CLI command
 * and which interface connects to which neighbour. `status` is inspectLab().
 */
export function describeAccess(topology, status, sshTarget) {
  return {
    vm: `ssh ${sshTarget}`,
    how: "Run the cli commands on the VM. Management IPs are reachable from the VM.",
    nodes: topology.nodes.map((n) => ({
      name: n.name,
      kind: n.kind,
      mgmt_ipv4: status[n.name]?.mgmt_ipv4 ?? "unknown",
      cli: cliCommand(topology, n),
      interfaces: linkInterfaces(topology, n).map((i) => `${i.interface} -> ${i.peer} ${i.peer_interface}`),
    })),
  };
}

/** Compact human-readable view for get_topology. */
export function describeTopology(topology) {
  return {
    name: topology.name,
    template: topology.template,
    routing: topology.routing,
    addressing_plan: isBare(topology)
      ? "none: cabling only, no IP addresses. cEOS link ports are default switchports (layer 2); FRR link ports are unconfigured."
      : "loopback 10.255.0.<i>/32; link between node i<j uses 10.<i>.<j>.0/30 (lower index .1)"
        + (usesBgp(topology) ? "; service prefix 172.16.<i>.0/24 on a loopback, advertised in BGP" : ""),
    nodes: topology.nodes.map((n) => ({
      name: n.name,
      kind: n.kind,
      ...(n.image ? { image: n.image } : {}),
      ...(n.loopback ? { loopback: `${n.loopback}/32` } : {}),
      ...(n.asn ? { asn: n.asn } : {}),
      ...(n.service_prefix ? { service_prefix: n.service_prefix } : {}),
    })),
    links: topology.links.map((l) => {
      const a = nodeByName(topology, l.a.node);
      const b = nodeByName(topology, l.b.node);
      // An end without an address (bare lab, or a host) shows its interface only.
      const end = (e, node) => `${e.node} ${osIfName(node.kind, e.interface)}${e.ip ? ` ${e.ip}` : ""}`;
      return `${end(l.a, a)}  <->  ${end(l.b, b)}${l.subnet ? `   (${l.subnet})` : ""}`;
    }),
    ...(topology.bgp_sessions.length
      ? { bgp_sessions: topology.bgp_sessions.map((s) => `${s.a} ${s.a_ip} <-> ${s.b} ${s.b_ip} (${s.type})`) }
      : {}),
  };
}

// Per-OS command mapping and normalisation. FRR and Arista EOS both emit JSON,
// but in different shapes; every reader here returns one vendor-neutral shape
// so validation logic and the model can treat both kinds the same way.
import { remote } from "./remote.mjs";
import { toEth } from "./topology.mjs";

const MGMT_INTERFACES = new Set(["eth0", "Management0", "Management1"]);

export async function showText(lab, node, command) {
  return (await remote("show", [lab, node.name, "text", command])).trimEnd();
}

export async function showJson(lab, node, command) {
  const out = (await remote("show", [lab, node.name, "json", command])).trim();
  if (!out) return {};
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${node.name} did not return JSON for "${command}": ${out.slice(0, 400)}`);
  }
}

function eosVrf(data) {
  return data?.vrfs?.default ?? {};
}

function eosInstances(data) {
  return Object.values(eosVrf(data).instList ?? {});
}

function normaliseOspfState(state) {
  const s = String(state ?? "").toLowerCase().replace(/\/.*$/, "");
  if (s === "2ways" || s === "2way") return "2-way";
  return s;
}

// ------------------------------------------------------------------ interfaces

export async function getInterfaces(lab, node) {
  if (node.kind === "frr") {
    const data = await showJson(lab, node, "show interface");
    return Object.entries(data)
      .filter(([name]) => !MGMT_INTERFACES.has(name))
      .map(([name, i]) => ({
        name,
        admin: i.administrativeStatus,
        oper: i.operationalStatus,
        mtu: i.mtu,
        addresses: (i.ipAddresses ?? []).map((a) => a.address).filter((a) => !a.startsWith("fe80")),
      }));
  }
  const data = await showJson(lab, node, "show interfaces");
  return Object.entries(data.interfaces ?? {})
    .filter(([name]) => !MGMT_INTERFACES.has(name))
    .map(([name, i]) => {
      const addresses = [];
      for (const entry of [i.interfaceAddress ?? []].flat()) {
        if (entry?.primaryIp?.maskLen) addresses.push(`${entry.primaryIp.address}/${entry.primaryIp.maskLen}`);
        for (const sec of entry?.secondaryIpsOrderedList ?? []) addresses.push(`${sec.address}/${sec.maskLen}`);
      }
      return {
        name,
        admin: i.interfaceStatus === "disabled" ? "down" : "up",
        oper: i.lineProtocolStatus === "up" ? "up" : "down",
        status: i.interfaceStatus,
        mtu: i.mtu,
        addresses,
      };
    });
}

// ---------------------------------------------------------------------- routes

function normaliseProtocol(type) {
  const t = String(type ?? "").toLowerCase();
  if (t.includes("ospf")) return "ospf";
  if (t.includes("bgp")) return "bgp";
  return t;
}

export async function getRoutes(lab, node, { destination } = {}) {
  const suffix = destination ? ` ${destination}` : "";
  const routes = [];
  if (node.kind === "frr") {
    const data = await showJson(lab, node, `show ip route${suffix}`);
    for (const entries of Object.values(data)) {
      if (!Array.isArray(entries)) continue;
      for (const r of entries) {
        if (!r.selected || r.protocol === "local") continue;
        const nexthops = (r.nexthops ?? []).filter((h) => h.active !== false).map((h) => {
          if (h.blackhole || h.unreachable) return "blackhole";
          return [h.ip, h.interfaceName && `via ${h.interfaceName}`].filter(Boolean).join(" ") || "directly connected";
        });
        if ((r.nexthops ?? []).length && r.nexthops.every((h) => MGMT_INTERFACES.has(h.interfaceName))) continue;
        routes.push({ prefix: r.prefix, protocol: r.protocol, distance: r.distance, metric: r.metric, nexthops });
      }
    }
  } else {
    const data = await showJson(lab, node, `show ip route${suffix}`);
    for (const [prefix, r] of Object.entries(eosVrf(data).routes ?? {})) {
      const vias = r.vias ?? [];
      if (vias.length && vias.every((v) => MGMT_INTERFACES.has(v.interface))) continue;
      const nexthops = r.routeAction === "drop"
        ? ["blackhole"]
        : vias.map((v) => [v.nexthopAddr, v.interface && `via ${v.interface}`].filter(Boolean).join(" ") || "directly connected");
      routes.push({ prefix, protocol: normaliseProtocol(r.routeType), type: r.routeType, distance: r.preference, metric: r.metric, nexthops });
    }
  }
  return routes;
}

// ------------------------------------------------------------------------ OSPF

export async function getOspfNeighbors(lab, node) {
  if (node.kind === "frr") {
    const data = await showJson(lab, node, "show ip ospf neighbor");
    const out = [];
    for (const [rid, entries] of Object.entries(data.neighbors ?? {})) {
      for (const n of entries) {
        const intf = String(n.ifaceName ?? "").split(":")[0];
        out.push({ neighbor_id: rid, address: n.ifaceAddress, interface: intf, eth: toEth(intf), state: normaliseOspfState(n.nbrState) });
      }
    }
    return out;
  }
  const data = await showJson(lab, node, "show ip ospf neighbor");
  return eosInstances(data).flatMap((inst) => (inst.ospfNeighborEntries ?? []).map((n) => ({
    neighbor_id: n.routerId,
    address: n.interfaceAddress,
    interface: n.interfaceName,
    eth: toEth(n.interfaceName),
    state: normaliseOspfState(n.adjacencyState),
  })));
}

export async function getOspfInterfaces(lab, node) {
  if (node.kind === "frr") {
    const data = await showJson(lab, node, "show ip ospf interface");
    return Object.entries(data.interfaces ?? {}).map(([name, i]) => ({
      interface: name,
      area: i.area,
      address: i.ipAddress ? `${i.ipAddress}/${i.ipAddressPrefixlen}` : undefined,
      network_type: String(i.networkType ?? "").toLowerCase(),
      state: String(i.state ?? "").toLowerCase(),
      hello: i.timerMsecs != null ? i.timerMsecs / 1000 : undefined,
      dead: i.timerDeadSecs,
      cost: i.cost,
      passive: Boolean(i.timerPassiveIface),
      mtu: i.mtuBytes,
      neighbors: i.nbrCount,
      adjacent: i.nbrAdjacentCount,
    }));
  }
  const data = await showJson(lab, node, "show ip ospf interface");
  return eosInstances(data).flatMap((inst) => Object.entries(inst.interfaces ?? {}).map(([name, i]) => ({
    interface: name,
    area: i.area,
    address: i.interfaceAddress ? `${i.interfaceAddress}/${i.interfaceMask}` : undefined,
    network_type: i.interfaceType,
    state: i.state,
    hello: i.helloInterval,
    dead: i.deadInterval,
    cost: i.cost,
    passive: Boolean(i.passive),
    neighbors: i.neighborCount,
  })));
}

// ------------------------------------------------------------------------- BGP

export async function getBgpSummary(lab, node) {
  if (node.kind === "frr") {
    const data = await showJson(lab, node, "show bgp ipv4 unicast summary");
    const af = data.ipv4Unicast ?? data;
    if (!af.peers) return { configured: false, peers: [] };
    return {
      configured: true,
      router_id: af.routerId,
      local_as: af.as,
      peers: Object.entries(af.peers).map(([peer, p]) => ({
        peer,
        description: p.desc ?? p.hostname,
        remote_as: p.remoteAs,
        state: String(p.state ?? "").toLowerCase(),
        prefixes_received: p.pfxRcd ?? 0,
        prefixes_sent: p.pfxSnt ?? 0,
        uptime: p.peerUptime,
      })),
    };
  }
  const data = await showJson(lab, node, "show ip bgp summary");
  const vrf = eosVrf(data);
  if (!vrf.peers) return { configured: false, peers: [] };
  const now = Date.now() / 1000;
  return {
    configured: true,
    router_id: vrf.routerId,
    local_as: Number(vrf.asn),
    peers: Object.entries(vrf.peers).map(([peer, p]) => ({
      peer,
      description: p.description,
      remote_as: Number(p.asn),
      state: String(p.peerState ?? "").toLowerCase(),
      prefixes_received: p.prefixReceived ?? 0,
      prefixes_accepted: p.prefixAccepted,
      prefixes_sent: p.prefixAdvertised,
      uptime_seconds: p.upDownTime ? Math.round(now - p.upDownTime) : undefined,
    })),
  };
}

export async function getBgpRoutes(lab, node) {
  if (node.kind === "frr") {
    const data = await showJson(lab, node, "show bgp ipv4 unicast");
    return Object.entries(data.routes ?? {}).map(([prefix, paths]) => ({
      prefix,
      paths: paths.map((p) => ({
        next_hop: !p.nexthops?.[0]?.ip || p.nexthops[0].ip === "0.0.0.0" ? "(self)" : p.nexthops[0].ip,
        as_path: p.path || "(empty)",
        best: Boolean(p.bestpath?.overall ?? p.bestpath),
        valid: Boolean(p.valid),
      })),
    }));
  }
  const data = await showJson(lab, node, "show ip bgp");
  return Object.entries(eosVrf(data).bgpRouteEntries ?? {}).map(([prefix, entry]) => ({
    prefix,
    paths: (entry.bgpRoutePaths ?? []).map((p) => ({
      next_hop: p.nextHop || "(self)",
      as_path: (p.asPathEntry?.asPath ?? "").replace(/\s*[ie?]$/, "") || "(empty)",
      best: Boolean(p.routeType?.active),
      valid: Boolean(p.routeType?.valid),
    })),
  }));
}

export async function getBgpNeighborDetail(lab, node, peer) {
  return showText(lab, node, node.kind === "frr" ? `show bgp neighbors ${peer}` : `show ip bgp neighbors ${peer}`);
}

// ----------------------------------------------------------- ping / traceroute

export function parsePing(text) {
  const sent = /(\d+) packets transmitted/.exec(text);
  const received = /(\d+) (?:packets )?received/.exec(text);
  const loss = /([\d.]+)% packet loss/.exec(text);
  const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(text);
  return {
    success: Boolean(received && Number(received[1]) > 0),
    sent: sent ? Number(sent[1]) : 0,
    received: received ? Number(received[1]) : 0,
    loss_percent: loss ? Number(loss[1]) : 100,
    ...(rtt ? { rtt_ms: { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]) } } : {}),
  };
}

export function parseTraceroute(text) {
  const hops = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)(?:\s+([\d.]+) ms)?/.exec(line);
    if (m) hops.push({ hop: Number(m[1]), address: m[2], ...(m[3] ? { rtt_ms: Number(m[3]) } : {}) });
  }
  return hops;
}

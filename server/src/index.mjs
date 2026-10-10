import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { remote } from "./remote.mjs";
import {
  buildTopology, describeTopology, helperSpec, KINDS, nodeByName, osIfName, renderStartupConfig, ROUTING_MODES,
  TEMPLATES, toEth,
} from "./topology.mjs";
import {
  getBgpNeighborDetail, getBgpRoutes, getBgpSummary, getInterfaces, getOspfInterfaces, getOspfNeighbors, getRoutes,
  parsePing, parseTraceroute, showText,
} from "./drivers.mjs";
import { collectSnapshot, evaluateHealth, summariseSnapshot } from "./health.mjs";
import { describeFault, FAMILIES, FAULTS, FAULT_TYPES } from "./faults.mjs";
import {
  createExercise, DIFFICULTIES, exerciseStatus, getHint, injectFault, resetExercise, validateExercise,
} from "./exercises.mjs";
import { checkLabName, emptyState, inspectLab, loadState, loadTopology, saveState, sleep } from "./lab.mjs";

const server = new McpServer(
  { name: "lab-dojo", version: "0.2.0" },
  {
    instructions: [
      "Containerlab network lab server (FRR and Arista cEOS routers on a remote VM).",
      "Layer 1 builds labs (create_topology -> deploy_topology), layer 2 inspects and changes routers, layer 3 runs troubleshooting exercises.",
      "Exercises are in tutor mode: a human learner troubleshoots. Anything under `tutor_only` must not be revealed to the learner unless they give up.",
      "Ask for explicit confirmation before destroy_topology. Router CLIs are reachable only through these tools; shell access is not available by design.",
    ].join(" "),
  },
);

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const CHANGES_LAB = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const lab = z.string().describe("Lab name, e.g. 'lab1'. See list_labs.");
const nodeName = z.string().describe("Node name, e.g. 'r1'. See list_nodes.");
const ipOrNode = z.string().describe("A literal IP address, or a node name (resolves to that node's loopback).");

function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function text(value) {
  return { content: [{ type: "text", text: value || "(no output)" }] };
}

function tool(name, description, inputSchema, annotations, handler) {
  server.registerTool(name, { description, inputSchema, annotations }, handler);
}

async function context(labName, node) {
  checkLabName(labName);
  const topology = await loadTopology(labName);
  return { topology, node: node ? nodeByName(topology, node) : undefined };
}

function resolveAddress(topology, value) {
  if (/^[0-9a-fA-F:.]+$/.test(value) && /[.:]/.test(value)) return value;
  return nodeByName(topology, value).loopback;
}

async function waitReady(labName, topology, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const status = {};
  for (;;) {
    await Promise.all(topology.nodes.map(async (n) => {
      if (status[n.name] === "ready") return;
      status[n.name] = await remote("ready", [labName, n.name]).then((s) => s.trim(), (e) => `error: ${e.message}`);
    }));
    if (Object.values(status).every((s) => s === "ready") || Date.now() > deadline) return status;
    await sleep(5_000);
  }
}

async function deployLab(labName, topology, { waitReady: wait = true, timeoutSeconds = 300 } = {}) {
  await remote("deploy", [labName], { timeout: 900_000 });
  await saveState(labName, emptyState());
  const result = { deployed: labName };
  if (wait) {
    result.readiness = await waitReady(labName, topology, timeoutSeconds * 1000);
    result.all_ready = Object.values(result.readiness).every((s) => s === "ready");
    result.note = result.all_ready
      ? "All routers have loaded their startup configuration. Routing converges within ~10-30 s."
      : "Some routers are still booting (cEOS can take a couple of minutes). Retry list_nodes or snapshot_state shortly.";
  }
  return result;
}

// ======================================================= Layer 1: lab management

tool("list_labs", "List lab definitions on the VM with node counts and how many containers are running.", {}, READ_ONLY,
  async () => json(JSON.parse(await remote("list-labs"))));

tool(
  "create_topology",
  [
    "Define a new lab from a template or an explicit node/link list. Addressing, OSPF/BGP configuration and Containerlab YAML are generated (raw YAML is not accepted, for safety).",
    `Templates: ${TEMPLATES.join(", ")}. Routing: ospf (area 0), ebgp (AS 65000+i per node), ibgp-ospf (OSPF underlay + iBGP full mesh AS 65000), none (addresses only, so the learner configures routing).`,
    "Addressing: loopback 10.255.0.<i>/32; link between nodes i<j = 10.<i>.<j>.0/30; BGP modes add service prefix 172.16.<i>.0/24.",
    "Kinds: frr (light, ~50 MB) or ceos (Arista cEOS, ~1.5 GB RAM each, max 6 per lab).",
  ].join(" "),
  {
    name: z.string().describe("New lab name: lowercase letters, digits, '-', max 20 chars."),
    template: z.enum(TEMPLATES).optional().describe("Generate nodes and links from a template. Omit to use `nodes` and `links`."),
    size: z.number().int().min(1).max(16).optional().describe("Node count for line/ring/full-mesh/star (default 3). Nodes are named r1..rN."),
    spines: z.number().int().min(1).max(4).optional().describe("leaf-spine only (default 2)."),
    leaves: z.number().int().min(1).max(8).optional().describe("leaf-spine only (default 3)."),
    kind: z.enum(KINDS).optional().describe("Default node kind (default frr)."),
    node_kinds: z.record(z.string(), z.enum(KINDS)).optional().describe("Per-node kind override, e.g. {\"r2\": \"ceos\"} for a mixed-vendor lab."),
    nodes: z.array(z.object({ name: z.string(), kind: z.enum(KINDS).optional() })).optional()
      .describe("Explicit nodes (instead of template)."),
    links: z.array(z.object({ a: z.string(), b: z.string() })).optional()
      .describe("Explicit links between node names; interfaces are assigned in order (eth1, eth2, ...)."),
    routing: z.enum(ROUTING_MODES).optional().describe("Routing design (default ospf)."),
    extra_config: z.record(z.string(), z.array(z.string())).optional()
      .describe("Extra startup-config lines per node, appended at the top level of that node's config (vendor syntax)."),
    replace: z.boolean().optional().describe("Replace an existing, non-deployed lab definition with the same name."),
    deploy: z.boolean().optional().describe("Also deploy it right away (default false)."),
  },
  CHANGES_LAB,
  async (args) => {
    const topology = buildTopology(args);
    const existing = JSON.parse(await remote("list-labs")).find((l) => l.name === topology.name);
    if (existing) {
      if (!args.replace) throw new Error(`lab ${topology.name} already exists. Pass replace: true (after destroy_topology if it is deployed).`);
      if (existing.running_containers > 0) throw new Error(`lab ${topology.name} is deployed. Destroy it first.`);
      await remote("delete-lab", [topology.name]);
    }
    await remote("create-lab", [topology.name], { input: helperSpec(topology) });
    try {
      for (const node of topology.nodes) {
        await remote("put-config", [topology.name, node.name], { input: renderStartupConfig(topology, node) });
      }
      await remote("meta-put", [topology.name, "topology"], { input: JSON.stringify(topology) });
      await saveState(topology.name, emptyState());
    } catch (error) {
      await remote("delete-lab", [topology.name]).catch(() => {});
      throw error;
    }
    const result = { created: describeTopology(topology) };
    if (args.deploy) result.deployment = await deployLab(topology.name, topology);
    else result.next_step = `deploy_topology with lab: "${topology.name}"`;
    return json(result);
  },
);

tool(
  "deploy_topology",
  "Start a defined lab's containers and links, then wait until every router has loaded its startup configuration. FRR takes seconds; cEOS can take 1-3 minutes.",
  {
    lab,
    wait_ready: z.boolean().optional().describe("Wait for routers to finish booting (default true)."),
    timeout_seconds: z.number().int().min(10).max(900).optional().describe("Readiness wait limit (default 300)."),
  },
  CHANGES_LAB,
  async ({ lab: labName, wait_ready: wait, timeout_seconds: timeoutSeconds }) => {
    const { topology } = await context(labName);
    return json(await deployLab(labName, topology, { waitReady: wait ?? true, timeoutSeconds: timeoutSeconds ?? 300 }));
  },
);

tool(
  "destroy_topology",
  "Stop and remove a lab's containers and links. Optionally also delete its definition. Ask the user for explicit confirmation first.",
  {
    lab,
    delete_definition: z.boolean().optional().describe("Also delete the lab definition so the name can be reused (default false)."),
  },
  DESTRUCTIVE,
  async ({ lab: labName, delete_definition: del }) => {
    checkLabName(labName);
    await remote("destroy", [labName], { timeout: 300_000 });
    if (del) {
      await remote("delete-lab", [labName]);
      return json({ destroyed: labName, definition_deleted: true });
    }
    await saveState(labName, emptyState()).catch(() => {});
    return json({ destroyed: labName, definition_kept: true });
  },
);

tool("get_topology", "Show a lab's design: nodes, kinds, loopbacks, ASNs, every link with its addresses, BGP sessions, and whether each node is running.",
  { lab }, READ_ONLY, async ({ lab: labName }) => {
    const { topology } = await context(labName);
    const status = await inspectLab(labName);
    const view = describeTopology(topology);
    view.nodes = view.nodes.map((n) => ({ ...n, state: status[n.name]?.state ?? "not deployed" }));
    return json(view);
  });

tool("list_nodes", "List a lab's nodes with container state, management IP, loopback and link interfaces (vendor names).",
  { lab }, READ_ONLY, async ({ lab: labName }) => {
    const { topology } = await context(labName);
    const status = await inspectLab(labName);
    return json(topology.nodes.map((n) => ({
      name: n.name,
      kind: n.kind,
      state: status[n.name]?.state ?? "not deployed",
      mgmt_ipv4: status[n.name]?.mgmt_ipv4,
      loopback: n.loopback,
      interfaces: n.interfaces.map((i) => `${osIfName(n.kind, i.name)} ${i.ip}/30 -> ${i.peer.node}`),
    })));
  });

// ==================================================== Layer 2: device interaction

tool(
  "exec_cli",
  "Run a read-only 'show ...' command on one node or on all nodes (vtysh on FRR, EOS CLI on cEOS). Pipes, redirects and non-show commands are refused. Use `include` to filter output lines by regex.",
  {
    lab,
    node: z.string().describe("Node name, or 'all' to run on every node."),
    command: z.string().describe("A show command, e.g. 'show ip ospf neighbor'. Vendor syntax applies."),
    json: z.boolean().optional().describe("Request JSON output (appends 'json' on FRR, '| json' on EOS)."),
    include: z.string().optional().describe("Case-insensitive regex; only matching lines are returned (text output only)."),
  },
  READ_ONLY,
  async ({ lab: labName, node, command, json: asJson, include }) => {
    const { topology } = await context(labName);
    const cmd = command.trim().replace(/\s+/g, " ");
    if (!/^show( |$)/.test(cmd)) throw new Error("only 'show ...' commands are allowed; use configure_device for changes");
    if (/[|<>;`$]/.test(cmd)) throw new Error("pipes, redirects and special characters are not allowed; use the include parameter to filter");
    const filter = include ? new RegExp(include, "i") : null;
    const targets = node === "all" ? topology.nodes : [nodeByName(topology, node)];
    const results = await Promise.all(targets.map(async (n) => {
      try {
        let out = await remote("show", [labName, n.name, asJson ? "json" : "text", cmd]);
        if (filter && !asJson) out = out.split("\n").filter((l) => filter.test(l)).join("\n");
        return [n.name, out.trimEnd()];
      } catch (error) {
        return [n.name, `ERROR: ${error.message}`];
      }
    }));
    if (targets.length === 1) return text(results[0][1]);
    return text(results.map(([n, out]) => `===== ${n} (${nodeByName(topology, n).kind}) =====\n${out}`).join("\n\n"));
  },
);

tool(
  "configure_device",
  "Apply configuration lines to one router, as if typed after 'configure terminal' (vendor syntax: FRR vtysh or Arista EOS). Do not include 'configure', 'end', 'exit' or 'do'. Top-level commands work from any sub-mode. Leaving config mode, shell access, writing/copying files and EOS event-handler/alias/schedule are refused by the VM. Changes are not saved; reset_exercise restores the startup config. Returns the device output and the diff against the startup config.",
  {
    lab,
    node: nodeName,
    lines: z.array(z.string()).min(1).max(200).describe("Configuration lines in order, e.g. [\"interface eth1\", \"no shutdown\"]."),
  },
  CHANGES_LAB,
  async ({ lab: labName, node, lines }) => {
    const { node: n } = await context(labName, node);
    const input = lines.map((l) => l.replace(/\t/g, "  ")).join("\n");
    const output = await remote("configure", [labName, n.name], { input });
    const diff = await remote("config-diff", [labName, n.name]).catch((e) => `diff unavailable: ${e.message}`);
    return json({ node: n.name, kind: n.kind, device_output: output.trim() || "(accepted, no output)", diff_vs_startup: diff.trim() || "(no differences)" });
  },
);

tool(
  "get_running_config",
  "Show a router's running configuration, optionally only the top-level sections whose header contains `section` (e.g. 'router ospf', 'interface eth1', 'router bgp').",
  { lab, node: nodeName, section: z.string().optional() },
  READ_ONLY,
  async ({ lab: labName, node, section }) => {
    const { node: n } = await context(labName, node);
    const config = await showText(labName, n, "show running-config");
    if (!section) return text(config);
    const wanted = section.toLowerCase();
    const out = [];
    let keep = false;
    for (const line of config.split("\n")) {
      if (/^\S/.test(line) && line !== "!") keep = line.toLowerCase().includes(wanted);
      if (keep) out.push(line);
    }
    return text(out.join("\n") || `(no section matching '${section}')`);
  },
);

tool("get_interfaces", "Interfaces of a router in a vendor-neutral shape: admin/oper state, MTU, IP addresses. Management interface omitted.",
  { lab, node: nodeName }, READ_ONLY, async ({ lab: labName, node }) => {
    const { node: n } = await context(labName, node);
    return json({ node: n.name, kind: n.kind, interfaces: await getInterfaces(labName, n) });
  });

tool(
  "get_routes",
  "Selected IPv4 routes of a router (vendor-neutral): prefix, protocol, distance, metric, next hops. Management routes omitted. Give `destination` for a longest-match lookup.",
  {
    lab,
    node: nodeName,
    destination: z.string().optional().describe("IP address or node name to look up (longest match)."),
    protocol: z.enum(["connected", "static", "ospf", "bgp"]).optional().describe("Only routes from this protocol."),
  },
  READ_ONLY,
  async ({ lab: labName, node, destination, protocol }) => {
    const { topology, node: n } = await context(labName, node);
    let routes = await getRoutes(labName, n, { destination: destination ? resolveAddress(topology, destination) : undefined });
    if (protocol) routes = routes.filter((r) => r.protocol === protocol);
    return json({ node: n.name, kind: n.kind, count: routes.length, routes });
  },
);

tool(
  "get_bgp",
  "BGP state of a router (vendor-neutral). view=summary (default): router id, local AS and each peer's state and prefix counts. view=routes: BGP table with paths. view=neighbor: full text detail for one peer.",
  {
    lab,
    node: nodeName,
    view: z.enum(["summary", "routes", "neighbor"]).optional(),
    peer: z.string().optional().describe("Peer IP or node name, required for view=neighbor."),
  },
  READ_ONLY,
  async ({ lab: labName, node, view = "summary", peer }) => {
    const { topology, node: n } = await context(labName, node);
    if (view === "routes") return json({ node: n.name, routes: await getBgpRoutes(labName, n) });
    if (view === "neighbor") {
      if (!peer) throw new Error("view=neighbor needs peer");
      let ip = peer;
      if (!/[.:]/.test(peer)) {
        const s = topology.bgp_sessions.find((x) => (x.a === n.name && x.b === peer) || (x.b === n.name && x.a === peer));
        if (!s) throw new Error(`${n.name} has no designed BGP session with ${peer}`);
        ip = s.a === n.name ? s.b_ip : s.a_ip;
      }
      return text(await getBgpNeighborDetail(labName, n, ip));
    }
    return json({ node: n.name, kind: n.kind, ...(await getBgpSummary(labName, n)) });
  },
);

tool(
  "get_ospf",
  "OSPF state of a router (vendor-neutral). view=neighbors (default): neighbor id, interface, state. view=interfaces: area, network type, hello/dead timers, cost, passive, MTU per interface. view=database: LSDB summary (text).",
  { lab, node: nodeName, view: z.enum(["neighbors", "interfaces", "database"]).optional() },
  READ_ONLY,
  async ({ lab: labName, node, view = "neighbors" }) => {
    const { node: n } = await context(labName, node);
    if (view === "database") return text(await showText(labName, n, "show ip ospf database"));
    if (view === "interfaces") return json({ node: n.name, kind: n.kind, interfaces: await getOspfInterfaces(labName, n) });
    return json({ node: n.name, kind: n.kind, neighbors: await getOspfNeighbors(labName, n) });
  },
);

tool(
  "ping",
  "Ping from a router. Destination and source may be IPs or node names (node name = its loopback). Returns parsed loss/RTT plus raw output.",
  {
    lab,
    node: nodeName,
    destination: ipOrNode,
    source: z.string().optional().describe("Source IP, a node name, or 'loopback' for this node's own loopback."),
    count: z.number().int().min(1).max(20).optional().describe("Packets to send (default 3)."),
  },
  READ_ONLY,
  async ({ lab: labName, node, destination, source, count = 3 }) => {
    const { topology, node: n } = await context(labName, node);
    const dest = resolveAddress(topology, destination);
    const src = source === "loopback" ? n.loopback : source ? resolveAddress(topology, source) : undefined;
    const out = await remote("ping", [labName, n.name, dest, count, ...(src ? [src] : [])], { timeout: 60_000 });
    return json({ from: n.name, destination: dest, ...(src ? { source: src } : {}), ...parsePing(out), raw: out.trim() });
  },
);

tool(
  "traceroute",
  "Traceroute from a router (numeric, 1 probe per hop, max 15 hops). Destination and source may be IPs or node names.",
  { lab, node: nodeName, destination: ipOrNode, source: z.string().optional().describe("Source IP, node name, or 'loopback'.") },
  READ_ONLY,
  async ({ lab: labName, node, destination, source }) => {
    const { topology, node: n } = await context(labName, node);
    const dest = resolveAddress(topology, destination);
    const src = source === "loopback" ? n.loopback : source ? resolveAddress(topology, source) : undefined;
    const out = await remote("traceroute", [labName, n.name, dest, ...(src ? [src] : [])], { timeout: 60_000 });
    const hops = parseTraceroute(out);
    return json({
      from: n.name,
      destination: dest,
      hops: hops.map((h) => {
        const owner = topology.nodes.find((x) => x.loopback === h.address || x.interfaces.some((i) => i.ip === h.address));
        return owner ? { ...h, node: owner.name } : h;
      }),
      raw: out.trim(),
    });
  },
);

tool(
  "snapshot_state",
  "One-call overview of a whole lab: per-node interface states, OSPF neighbors, BGP peers and route counts, plus outcome-based health checks against the design (links up, adjacencies full, sessions established, BGP routes present, loopback-to-loopback pings). Ideal first step when troubleshooting.",
  { lab, include_health: z.boolean().optional().describe("Run the health checks too (default true; adds a few seconds of pings).") },
  READ_ONLY,
  async ({ lab: labName, include_health: includeHealth = true }) => {
    const { topology } = await context(labName);
    if (!includeHealth) return json({ nodes: summariseSnapshot(topology, await collectSnapshot(labName, topology)) });
    const { snapshot, summary } = await evaluateHealth(labName, topology);
    return json({ health: summary, nodes: summariseSnapshot(topology, snapshot) });
  },
);

tool(
  "diff_config",
  "Show what changed in a router's running configuration compared with its startup configuration (FRR: frr-reload commands to restore; EOS: unified diff). node='all' checks every router.",
  { lab, node: z.string().describe("Node name or 'all'.") },
  READ_ONLY,
  async ({ lab: labName, node }) => {
    const { topology } = await context(labName);
    const targets = node === "all" ? topology.nodes : [nodeByName(topology, node)];
    const results = await Promise.all(targets.map(async (n) => {
      const diff = await remote("config-diff", [labName, n.name]).catch((e) => `ERROR: ${e.message}`);
      return [n.name, diff.trim() || "(no differences)"];
    }));
    return text(results.map(([n, d]) => `===== ${n} =====\n${d}`).join("\n\n"));
  },
);

// ================================================ Layer 3: exercise management

const faultCatalog = FAULT_TYPES.map((t) => `${t} [${FAULTS[t].family}, level ${FAULTS[t].difficulty}]: ${FAULTS[t].summary}`).join("\n");

tool(
  "create_exercise",
  [
    "Start a troubleshooting exercise on a deployed, healthy lab (tutor mode: a human learner fixes it).",
    "Picks fault(s) by difficulty/focus (or uses fault_types), injects them, waits for symptoms, and returns a learner_briefing (show this) and tutor_only details (never reveal).",
    "easy: 1 level-1 fault and all failing checks shown; medium: 1 level-2 fault, only end-to-end symptoms; hard: 2 faults, ticket text only. Takes up to ~1 minute.",
  ].join(" "),
  {
    lab,
    difficulty: z.enum(Object.keys(DIFFICULTIES)).optional().describe("Default medium."),
    focus: z.enum(["any", ...FAMILIES]).optional().describe("Restrict to one fault family (default any)."),
    fault_types: z.array(z.enum(FAULT_TYPES)).max(3).optional().describe("Explicit fault types instead of a random choice; targets are still random."),
    seed: z.number().int().optional().describe("Random seed to reproduce an exercise."),
  },
  CHANGES_LAB,
  async ({ lab: labName, ...opts }) => {
    const { topology } = await context(labName);
    const state = await loadState(labName);
    return json(await createExercise(labName, topology, state, opts));
  },
);

tool(
  "inject_fault",
  `Inject one specific fault into a deployed lab (instructor use, or to add a fault to the active exercise). Targets not given are picked at random. Returns tutor-only details including the fault id needed to revert it.\nFault types:\n${faultCatalog}`,
  {
    lab,
    type: z.enum(FAULT_TYPES),
    node: z.string().optional().describe("Router to break."),
    interface: z.string().optional().describe("Link interface on that router (eth1 / Ethernet1) for link faults."),
    peer: z.string().optional().describe("Peer node name, for BGP faults and static_blackhole (the unreachable target)."),
    add_to_exercise: z.boolean().optional().describe("Attach to the active exercise so validate_exercise covers it (default true when one is active)."),
  },
  CHANGES_LAB,
  async ({ lab: labName, type, node, interface: intf, peer, add_to_exercise: attach }) => {
    const { topology } = await context(labName);
    const state = await loadState(labName);
    const params = node ? { node, ...(intf ? { interface: toEth(intf) ?? intf } : {}), ...(peer ? { peer } : {}) } : undefined;
    const ex = state.exercise?.status === "active" && attach !== false ? state.exercise : null;
    const fault = await injectFault(labName, topology, state, { type, params, exerciseId: ex?.id });
    if (ex) ex.faults.push({ ...fault });
    await saveState(labName, state);
    return json({
      fault_id: fault.id,
      ...(ex ? { added_to_exercise: ex.id } : {}),
      symptoms_appear_within_seconds: fault.settle_seconds,
      tutor_only: describeFault(topology, fault),
    });
  },
);

tool(
  "validate_exercise",
  "Grade the active exercise: re-runs the design health checks plus fault-specific checks. Outcome-based, so any correct fix passes. Records the attempt and marks the exercise solved when everything passes.",
  { lab },
  CHANGES_LAB,
  async ({ lab: labName }) => {
    const { topology } = await context(labName);
    return json(await validateExercise(labName, topology, await loadState(labName)));
  },
);

tool(
  "reset_exercise",
  "Restore routers. mode=baseline (default): every node back to its startup config, links up, impairments removed, exercise closed. mode=retry: same, then re-inject the same exercise faults for another attempt. fault_id: revert only that fault (e.g. a 'physical' fault the learner diagnosed); manual changes on that node are reverted too. Works on any lab, with or without an exercise.",
  {
    lab,
    mode: z.enum(["baseline", "retry"]).optional(),
    fault_id: z.string().optional().describe("Revert just this fault, e.g. 'f2'."),
  },
  DESTRUCTIVE,
  async ({ lab: labName, mode, fault_id: faultId }) => {
    const { topology } = await context(labName);
    return json(await resetExercise(labName, topology, await loadState(labName), { mode, fault_id: faultId }));
  },
);

tool(
  "get_exercise_status",
  "Current exercise of a lab: status, briefing, attempts, hints used, plus tutor_only fault details and solutions. Also lists manually injected faults.",
  { lab },
  READ_ONLY,
  async ({ lab: labName }) => {
    const { topology } = await context(labName);
    return json(exerciseStatus(labName, topology, await loadState(labName)));
  },
);

tool(
  "get_hint",
  "Give the learner the next progressive hint (3 levels per fault, from 'where to look' to nearly the answer). Hint usage is recorded.",
  { lab, fault_id: z.string().optional().describe("Hint for a specific fault of a multi-fault exercise.") },
  CHANGES_LAB,
  async ({ lab: labName, fault_id: faultId }) => {
    const { topology } = await context(labName);
    return json(await getHint(labName, topology, await loadState(labName), faultId));
  },
);

// ========================================================================= prompts

server.registerPrompt(
  "tutor_exercise",
  {
    description: "Run a guided troubleshooting exercise with Claude as the tutor.",
    argsSchema: {
      lab: z.string().describe("Lab name (created if missing)."),
      difficulty: z.string().optional().describe("easy, medium or hard."),
    },
  },
  ({ lab: labName, difficulty }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Act as my network troubleshooting tutor using the containerlab tools on lab "${labName}".`,
          `1. If the lab does not exist or is not deployed, propose a small topology (e.g. a 4-router ring with OSPF), create and deploy it after I agree.`,
          `2. Call create_exercise (difficulty ${difficulty || "medium"}). Show me only learner_briefing; keep tutor_only to yourself.`,
          "3. Let me drive the investigation. When I ask you to run commands, run them and show the output. When I ask for help, use get_hint and Socratic questions; do not give the answer away.",
          "4. When I say I fixed it (or ask you to apply my fix with configure_device), call validate_exercise and tell me the result.",
          "5. If I identify a physical/link-quality fault correctly, 'repair' it with reset_exercise fault_id.",
          "6. After it is solved, debrief: root cause, the fastest diagnostic path, and what to remember.",
        ].join("\n"),
      },
    }],
  }),
);

server.registerPrompt(
  "troubleshoot_lab",
  {
    description: "Systematically diagnose a lab and explain the findings.",
    argsSchema: { lab: z.string().describe("Lab name.") },
  },
  ({ lab: labName }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Troubleshoot lab "${labName}" bottom-up and explain your reasoning as you go:`,
          "1. snapshot_state for the overall picture and failing health checks.",
          "2. For each failure: layer 1 (get_interfaces), layer 3 addressing (get_running_config section interface), then the routing protocol (get_ospf interfaces/neighbors, get_bgp summary/routes), then forwarding (get_routes, traceroute).",
          "3. Use diff_config to see what changed from the startup configuration.",
          "4. Propose fixes and wait for my confirmation before using configure_device.",
        ].join("\n"),
      },
    }],
  }),
);

await server.connect(new StdioServerTransport());

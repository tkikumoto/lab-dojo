// Lab metadata lives on the VM next to the lab (meta/topology.json and
// meta/state.json), so it survives MCP server restarts and is removed with it.
import { remote } from "./remote.mjs";
import { LAB_NAME_RE } from "./topology.mjs";

export function checkLabName(lab) {
  if (!LAB_NAME_RE.test(lab ?? "")) throw new Error(`invalid lab name: ${lab}`);
  return lab;
}

export async function loadTopology(lab) {
  checkLabName(lab);
  const raw = (await remote("meta-get", [lab, "topology"])).trim();
  if (!raw) throw new Error(`lab ${lab} has no topology metadata; recreate it with create_topology`);
  return JSON.parse(raw);
}

export function emptyState() {
  return { next_fault_id: 1, faults: [], exercise: null, history: [] };
}

export async function loadState(lab) {
  const raw = (await remote("meta-get", [lab, "state"])).trim();
  return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState();
}

export async function saveState(lab, state) {
  await remote("meta-put", [lab, "state"], { input: JSON.stringify(state) });
}

/** Container status per node name, from the VM. Empty when not deployed. */
export async function inspectLab(lab) {
  const out = await remote("inspect", [lab]);
  const status = {};
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [node, state, started, mgmt] = line.split("\t");
    status[node] = { state, started_at: started, mgmt_ipv4: mgmt || undefined };
  }
  return status;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

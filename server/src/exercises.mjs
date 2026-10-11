// Exercise lifecycle for tutor mode: the human learner troubleshoots, Claude
// creates faults, hands out hints and grades. Fault details are returned to
// Claude under `tutor_only` and must not be shown to the learner.
import { remote } from "./remote.mjs";
import { evaluateHealth } from "./health.mjs";
import {
  describeFault, FAULTS, FAULT_TYPES, faultHints, faultTicket, nodesTouched, pick, planFault, rng, runActions,
} from "./faults.mjs";
import { saveState, sleep } from "./lab.mjs";

export const DIFFICULTIES = {
  easy: { count: 1, levels: [1], symptoms: "all" },
  medium: { count: 1, levels: [2], symptoms: "end-to-end" },
  hard: { count: 2, levels: [2, 3], symptoms: "none" },
};

const TUTOR_NOTE = "TUTOR ONLY: do not reveal fault details or solutions to the learner unless they explicitly give up. "
  + "Guide them with questions and get_hint; let them type the fixes when possible.";

export async function waitHealthy(lab, topology, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let result;
  for (;;) {
    result = await evaluateHealth(lab, topology);
    if (result.summary.healthy || Date.now() > deadline) return result.summary;
    await sleep(5_000);
  }
}

export async function injectFault(lab, topology, state, { type, params, random = Math.random, exerciseId }) {
  const plan = planFault(topology, type, params, random);
  await runActions(lab, plan.actions);
  const fault = {
    id: `f${state.next_fault_id}`,
    ...plan,
    injected_at: new Date().toISOString(),
    ...(exerciseId ? { exercise_id: exerciseId } : {}),
  };
  state.next_fault_id += 1;
  state.faults.push(fault);
  return fault;
}

/**
 * Hard-resets the given BGP sessions on both ends. After a repair FRR can sit in
 * idle-hold backoff or a stale OpenSent for minutes; a clear makes the session
 * re-form in seconds. It never repairs a configuration error by itself.
 */
export async function kickBgpSessions(lab, sessions) {
  await Promise.all(sessions.flatMap((s) => [
    remote("bgp-clear", [lab, s.a, s.b_ip]).catch(() => {}),
    remote("bgp-clear", [lab, s.b, s.a_ip]).catch(() => {}),
  ]));
}

const sessionsOf = (topology, nodes) => topology.bgp_sessions.filter((s) => nodes.includes(s.a) || nodes.includes(s.b));

/**
 * Removes one fault: restore the nodes it touched to their startup state, then
 * re-apply any other active fault on those nodes.
 */
export async function revertFault(lab, topology, state, faultId) {
  const fault = state.faults.find((f) => f.id === faultId);
  if (!fault) {
    throw new Error(`no active fault ${faultId}. Active: ${state.faults.map((f) => f.id).join(", ") || "none"}`);
  }
  const nodes = nodesTouched(fault.actions);
  state.faults = state.faults.filter((f) => f !== fault);
  await Promise.all(nodes.map((n) => remote("restore-node", [lab, n], { timeout: 120_000 })));
  const reapplied = state.faults.filter((f) => nodesTouched(f.actions).some((n) => nodes.includes(n)));
  for (const f of reapplied) await runActions(lab, f.actions);
  await kickBgpSessions(lab, sessionsOf(topology, nodes));
  return {
    reverted: faultId,
    restored_nodes: nodes,
    reapplied_faults: reapplied.map((f) => f.id),
    note: "Restoring a node also reverts any manual changes made on it since deployment.",
  };
}

export async function restoreAll(lab, topology, state) {
  await Promise.all(topology.nodes.map((n) => remote("restore-node", [lab, n.name], { timeout: 120_000 })));
  await kickBgpSessions(lab, topology.bgp_sessions);
  state.faults = [];
}

function chooseFaultTypes(topology, { difficulty, focus, fault_types: explicit }, random) {
  if (explicit?.length) {
    for (const t of explicit) if (!FAULTS[t]) throw new Error(`unknown fault type ${t}`);
    return explicit;
  }
  const cfg = DIFFICULTIES[difficulty];
  const usable = (levels) => FAULT_TYPES.filter((t) => {
    const def = FAULTS[t];
    return def.applies(topology) && def.candidates(topology).length > 0 && levels.includes(def.difficulty)
      && (focus === "any" || def.family === focus);
  });
  let pool = usable(cfg.levels);
  if (!pool.length) pool = usable([1, 2, 3]);
  if (!pool.length) throw new Error(`no fault type matches focus '${focus}' for routing '${topology.routing}'`);
  const chosen = [];
  for (let i = 0; i < cfg.count; i += 1) {
    const remaining = pool.filter((t) => !chosen.includes(t));
    chosen.push(pick(random, remaining.length ? remaining : pool));
  }
  return chosen;
}

function symptomsFor(level, failed) {
  if (level === "none") return [];
  const endToEnd = /^(reach|quality|bgp-route|bgp-prefixes):/;
  return failed
    .filter((c) => level === "all" || endToEnd.test(c.id))
    .map((c) => `NOT OK: ${c.description}`)
    .slice(0, 12);
}

export async function createExercise(lab, topology, state, opts) {
  if (state.exercise?.status === "active") {
    throw new Error(`lab ${lab} already has active exercise ${state.exercise.id}. Validate it, or call reset_exercise first.`);
  }
  if (state.faults.length) {
    throw new Error(`lab ${lab} has active faults (${state.faults.map((f) => f.id).join(", ")}). Call reset_exercise first.`);
  }
  const difficulty = opts.difficulty ?? "medium";
  const focus = opts.focus ?? "any";
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const random = rng(seed);

  const before = await waitHealthy(lab, topology, 90_000);
  if (!before.healthy) {
    return {
      error: "The lab is not healthy yet, so symptoms would be ambiguous. Wait for convergence or reset_exercise, then retry.",
      failing_checks: before.failed,
    };
  }

  const id = `ex-${Date.now().toString(36)}`;
  const types = chooseFaultTypes(topology, { difficulty, focus, fault_types: opts.fault_types }, random);
  const faults = [];
  const usedNodes = new Set();
  for (const type of types) {
    // Prefer a fresh node for each fault so multi-fault exercises do not overlap.
    let plan;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      plan = planFault(topology, type, undefined, random);
      if (!nodesTouched(plan.actions).some((n) => usedNodes.has(n))) break;
    }
    const fault = await injectFault(lab, topology, state, { type, params: plan.params, exerciseId: id });
    // Record it at once: if a later step fails, the fault is still known and can be reverted.
    await saveState(lab, state);
    nodesTouched(fault.actions).forEach((n) => usedNodes.add(n));
    faults.push(fault);
  }

  const settleSeconds = Math.max(...faults.map((f) => f.settle_seconds));
  await sleep(settleSeconds * 1000);
  const after = await evaluateHealth(lab, topology, { extraChecks: faults.flatMap((f) => f.checks) });

  const exercise = {
    id,
    status: "active",
    difficulty,
    focus,
    seed,
    created_at: new Date().toISOString(),
    faults: faults.map((f) => ({ ...f })),
    briefing: {
      tickets: faults.map((f) => faultTicket(topology, f)),
      observed_symptoms: symptomsFor(DIFFICULTIES[difficulty].symptoms, after.summary.failed),
    },
    hints_given: {},
    attempts: [],
    retries: 0,
  };
  state.exercise = exercise;
  await saveState(lab, state);

  return {
    exercise_id: id,
    lab,
    difficulty,
    learner_briefing: {
      ...exercise.briefing,
      task: "Find and fix the root cause. Use show commands to investigate. Ask for a hint at any time. Say when you think it is fixed and it will be validated.",
    },
    tutor_only: {
      note: TUTOR_NOTE,
      faults: faults.map((f) => describeFault(topology, f)),
      symptoms_visible_now: after.summary.failed.length,
      seed,
    },
  };
}

export async function validateExercise(lab, topology, state) {
  const ex = state.exercise;
  if (!ex) throw new Error(`lab ${lab} has no exercise. Create one with create_exercise.`);
  const extraChecks = ex.faults.flatMap((f) => f.checks ?? []);
  let { summary } = await evaluateHealth(lab, topology, { extraChecks });
  if (!summary.healthy) {
    // A fix applied seconds ago may still be converging; give it one grace period,
    // and restart BGP sessions that are down so FRR's retry backoff does not count
    // against a correct fix.
    const down = new Set(summary.failed.filter((c) => c.id.startsWith("bgp:")).map((c) => c.id));
    await kickBgpSessions(lab, topology.bgp_sessions.filter((s) => down.has(`bgp:${s.a}:${s.b_ip}`)));
    await sleep(10_000);
    ({ summary } = await evaluateHealth(lab, topology, { extraChecks }));
  }
  const now = new Date();
  ex.attempts.push({ at: now.toISOString(), passed: summary.passed, total: summary.total });
  if (summary.healthy && ex.status === "active") {
    ex.status = "solved";
    ex.solved_at = now.toISOString();
    // The learner fixed them; the faults are no longer active.
    state.faults = state.faults.filter((f) => f.exercise_id !== ex.id);
  }
  await saveState(lab, state);
  const minutes = Math.round((now - new Date(ex.created_at)) / 60_000);
  return {
    exercise_id: ex.id,
    status: ex.status,
    solved: summary.healthy,
    score: `${summary.passed}/${summary.total} checks passing`,
    failed_checks: summary.failed,
    attempts: ex.attempts.length,
    hints_used: Object.values(ex.hints_given).reduce((a, b) => a + b, 0),
    elapsed_minutes: minutes,
    tutor_note: summary.healthy
      ? "Solved. Debrief: ask the learner to explain the root cause and how they found it, then compare with tutor_only.faults from get_exercise_status."
      : "Not solved yet. Use failed_checks to steer the learner with questions; do not list them verbatim if that gives the answer away.",
  };
}

export async function getHint(lab, topology, state, faultId) {
  const ex = state.exercise;
  if (!ex || ex.status !== "active") throw new Error(`lab ${lab} has no active exercise.`);
  const index = faultId
    ? ex.faults.findIndex((f) => f.id === faultId)
    : Math.max(0, ex.faults.findIndex((f) => (ex.hints_given[f.id] ?? 0) < 3));
  const fault = ex.faults[index];
  if (!fault) throw new Error(`exercise ${ex.id} has no fault ${faultId}`);
  const hints = faultHints(topology, fault);
  const level = Math.min((ex.hints_given[fault.id] ?? 0) + 1, hints.length);
  ex.hints_given[fault.id] = level;
  await saveState(lab, state);
  return {
    exercise_id: ex.id,
    problem: `${index + 1} of ${ex.faults.length}`,
    hint_level: `${level} of ${hints.length}`,
    hint: hints[level - 1],
    ...(level === hints.length ? { tutor_note: "That was the last hint. The full solution is in get_exercise_status tutor_only." } : {}),
  };
}

export async function resetExercise(lab, topology, state, { mode = "baseline", fault_id: faultId }) {
  if (faultId) {
    const result = await revertFault(lab, topology, state, faultId);
    await saveState(lab, state);
    return result;
  }
  await restoreAll(lab, topology, state);
  const ex = state.exercise;
  if (mode === "retry") {
    if (!ex) throw new Error(`lab ${lab} has no exercise to retry.`);
    for (const f of ex.faults) {
      await runActions(lab, f.actions);
      state.faults.push({ ...f, injected_at: new Date().toISOString() });
    }
    ex.status = "active";
    ex.retries += 1;
    await saveState(lab, state);
    return {
      exercise_id: ex.id,
      status: "active",
      note: `All nodes restored and the same ${ex.faults.length} fault(s) re-injected. Allow up to ${Math.max(...ex.faults.map((f) => f.settle_seconds))}s for symptoms to return.`,
      learner_briefing: ex.briefing,
    };
  }
  if (ex) {
    if (ex.status === "active") ex.status = "abandoned";
    state.history = [...(state.history ?? []), { id: ex.id, status: ex.status, difficulty: ex.difficulty, created_at: ex.created_at }].slice(-20);
    state.exercise = null;
  }
  await saveState(lab, state);
  return {
    status: "baseline restored",
    restored_nodes: topology.nodes.map((n) => n.name),
    note: "All nodes are back to their startup configuration with links up and no impairments. Routing needs a few seconds to reconverge.",
  };
}

export function exerciseStatus(lab, topology, state) {
  const ex = state.exercise;
  const manual = state.faults.filter((f) => !f.exercise_id);
  return {
    lab,
    exercise: ex
      ? {
        id: ex.id,
        status: ex.status,
        difficulty: ex.difficulty,
        focus: ex.focus,
        created_at: ex.created_at,
        ...(ex.solved_at ? { solved_at: ex.solved_at } : {}),
        attempts: ex.attempts,
        hints_given: ex.hints_given,
        retries: ex.retries,
        learner_briefing: ex.briefing,
        tutor_only: { note: TUTOR_NOTE, faults: ex.faults.map((f) => describeFault(topology, f)) },
      }
      : null,
    active_faults: state.faults.map((f) => ({ id: f.id, type: f.type, exercise_id: f.exercise_id ?? null })),
    ...(manual.length ? { manual_faults_tutor_only: manual.map((f) => describeFault(topology, f)) } : {}),
    recent_exercises: state.history ?? [],
  };
}

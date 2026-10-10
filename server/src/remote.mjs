import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const sshTarget = process.env.CONTAINERLAB_SSH_TARGET ?? "containerlab-server@orb";
const remoteHelper = process.env.CONTAINERLAB_REMOTE_HELPER ?? "/usr/local/libexec/clab-mcp-remote";
// Reusing one SSH connection keeps multi-node snapshots fast. The socket path
// must stay short (Unix sockets are limited to ~104 bytes on macOS).
const controlPath = process.env.CONTAINERLAB_SSH_CONTROL_PATH
  ?? path.join(os.homedir(), ".ssh", "cm-clab-mcp-%C");
const MAX_PARALLEL = 6;

/** Error raised by the remote helper itself (bad request), not by transport. */
export class RemoteRefusal extends Error {}

let active = 0;
const waiting = [];

async function withSlot(fn) {
  if (active >= MAX_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** Single-quotes a value for a POSIX shell. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Runs one allowlisted helper action on the VM. No local shell is involved.
 * ssh joins its remote arguments into one string that the VM's login shell
 * re-parses, so every argument is single-quoted to reach the helper as exactly
 * one argv value (e.g. "show ip route"). `input` is written to the helper's
 * stdin.
 */
export function remote(action, args = [], { input, timeout = 60_000 } = {}) {
  const sshArgs = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=120",
    sshTarget,
    "--",
    [remoteHelper, action, ...args].map(shellQuote).join(" "),
  ];
  return withSlot(() => new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Containerlab request timed out after ${timeout / 1000}s (${action}).`));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const cleanErr = stripAnsi(stderr).trim();
      if (code === 0) {
        resolve(stripAnsi(stdout));
        return;
      }
      const helperMessage = cleanErr.split("\n").find((line) => line.startsWith("clab-mcp-remote: "));
      if (code === 2 && helperMessage) {
        reject(new RemoteRefusal(helperMessage.replace("clab-mcp-remote: ", "")));
        return;
      }
      const detail = [cleanErr, stripAnsi(stdout).trim()].filter(Boolean).join("\n").slice(-4000);
      reject(new Error(`Containerlab request failed (${action}, exit ${code}). ${detail}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  }));
}

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

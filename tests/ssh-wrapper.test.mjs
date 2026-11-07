import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { shellQuote } from "../server/src/remote.mjs";

// remote/clab-mcp-ssh is the forced command of lab-dojo's own SSH key: it must
// turn exactly what remote() sends back into the helper's arguments, and refuse
// everything else. Windows has no bash of its own, so it is skipped there.
const skip = process.platform === "win32" && "needs bash; run npm test on Linux or macOS";
const wrapper = fileURLToPath(new URL("../remote/clab-mcp-ssh", import.meta.url));
const HELPER = "/usr/local/libexec/clab-mcp-remote";

/** The helper arguments the wrapper would run for this SSH_ORIGINAL_COMMAND, or null if refused. */
function parse(request) {
  const run = spawnSync("bash", ["-c", 'source "$1" && parse_request "$2" && printf "%s\\0" "${WORDS[@]}"', "_", wrapper, request],
    { encoding: "utf8" });
  return run.status === 0 ? run.stdout.split("\0").slice(0, -1) : null;
}

const sent = (...args) => [HELPER, ...args].map(shellQuote).join(" ");

test("the SSH wrapper passes on exactly what the server sends", { skip }, () => {
  for (const args of [
    ["doctor"],
    ["show", "lab1", "r1", "text", "show ip route"],
    ["ping", "lab1", "h1", "10.0.0.1", "3"],
    ["show", "lab1", "r1", "text", "it's a 'quoted' $(id); `x` | y > z"],
    ["meta-put", "lab1", ""],
  ]) assert.deepEqual(parse(sent(...args)), args);
});

test("the SSH wrapper refuses anything else", { skip }, () => {
  for (const request of [
    "",
    "true",
    "bash",
    "rm -rf /",
    `${sent("doctor")}; id`,
    `${sent("doctor")} && id`,
    `${sent("doctor")} $(id)`,
    `${sent("doctor")}'`,
    `'${HELPER}' doctor`,
    `'${HELPER}'`,
    `${sent("doctor")}  'x'`,
    "'/bin/sh' '-c' 'id'",
    `'${HELPER}x' 'doctor'`,
    `"${HELPER}" "doctor"`,
  ]) assert.equal(parse(request), null, request);
});

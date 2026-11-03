import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

// The filter is bash, run on the Linux lab host. Windows has no bash of its own
// (`bash` there may be WSL, which cannot read this path), so it is skipped.
const skip = process.platform === "win32" && "needs bash; run npm test on Linux or macOS";

test("helper config-line filter (tests/check-line.sh)", { skip }, () => {
  const run = spawnSync("bash", [fileURLToPath(new URL("check-line.sh", import.meta.url))], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}${run.error?.message ?? ""}`);
});

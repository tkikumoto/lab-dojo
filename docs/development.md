# Development

## Local checks

```bash
npm install
npm run check   # node --check on every module + bash -n on the remote scripts
npm test        # topology, fault targeting and ping parsing, then the helper's config-line filter
```

`npm run check` needs bash and python3, so run it on macOS or Linux. On Windows `npm test` skips the filter test.

The filter test (`tests/check-line.sh`) needs bash 4 or newer. macOS ships bash 3.2, so there it reruns itself on the lab host over SSH: set `CONTAINERLAB_SSH_TARGET` in your shell first. The lab host must see this folder at the same path (OrbStack machines do); otherwise run the test on Linux. It reads the helper from this folder, so it tests your working copy and not the installed helper.

`npm start` waits for MCP JSON-RPC on stdin; this is expected.

After changing server code, reconnect the server in your client (in Claude Code: `/mcp`) so it loads the new code.

## End-to-end test sequence

1. `create_topology` with `{"name":"mix","template":"ring","size":4,"routing":"ibgp-ospf","node_kinds":{"r3":"ceos"},"deploy":true}`
2. `snapshot_state` with `lab: "mix"`. All 38 checks should pass.
3. `create_exercise` with `lab: "mix"` and `difficulty: "easy"`, then fix the fault, then `validate_exercise`.
4. `reset_exercise` with `lab: "mix"`.
5. After explicit confirmation, `destroy_topology` with `lab: "mix"` and `delete_definition: true`.

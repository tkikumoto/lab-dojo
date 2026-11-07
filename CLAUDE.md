# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

lab-dojo is an MCP server (Node, no build step) that lets Claude build, inspect and break Containerlab network labs (FRR, optional Arista cEOS, Linux hosts) on a remote Linux "lab host" (a VM or bare metal), and run troubleshooting exercises where Claude tutors a human learner.

## Commands

```bash
npm install
npm test                 # node --test "tests/*.test.mjs"; Node 22+
npm run check            # node --check on every module, bash -n on remote scripts, python ast on lab-netdev-sync (macOS/Linux only)
node --test --test-name-pattern="checklist" tests/server.test.mjs   # one test
```

- `tests/server.test.mjs` is pure logic and never touches a lab host.
- `tests/check-line.sh` (run by `tests/check-line.test.mjs`) tests the helper's config-line filter and needs bash 4+. macOS ships bash 3.2, so there it reruns itself on the lab host over SSH and fails unless `CONTAINERLAB_SSH_TARGET` is set, e.g. `CONTAINERLAB_SSH_TARGET=<user>@<host> npm test`. The lab host must see this folder at the same path (OrbStack does). It is skipped on Windows. It needs a shell over SSH, so use your own key, not a restricted lab-dojo key.
- After changing server code, the MCP client must reconnect (`/mcp` in Claude Code) to load it.

## Architecture

Two halves, split by a trust boundary:

1. **Local Node server** (`server/src/`), launched by the MCP client. It validates input, then calls the lab host only through `remote(action, args, { input })` in `remote.mjs`, which runs `ssh <target> -- /usr/local/libexec/clab-mcp-remote <action> <args...>` (each arg single-quoted, larger payloads on stdin). No local shell is involved.
2. **Helper on the lab host** (`remote/clab-mcp-remote`, bash). This is the trust boundary: lab nodes run privileged, so a shell in a router is root on the host. It re-validates every argument, dispatches on an allowlist of actions (the `case` at the bottom), screens every config line (`check_line`), renders Containerlab YAML itself from a line-oriented spec (never raw YAML from the server), and never pulls images. Exit code 2 with a `clab-mcp-remote: ` message is a refusal; `remote.mjs` turns it into `RemoteRefusal`.

The server is stateless: lab metadata (`meta/topology.json`, `meta/state.json`, holding faults and the active exercise) lives on the lab host under `/var/lib/containerlab-mcp/labs/<lab>/`, read and written through the `meta-get`/`meta-put` actions (`lab.mjs`).

Server modules, in the order a request flows:
- `index.mjs` registers the tools in three layers (lab building, device access, exercises) and the prompts that become the slash commands (`/mcp__lab-dojo__init`, `build_lab`, `exercise`, …). The server `instructions` and tool descriptions are how Claude is told to behave (ask before building, never reveal `tutor_only`, show access tables), so behavioral changes often go there.
- `topology.mjs` turns a template or node/link list into a topology with the fixed addressing plan (loopback `10.255.0.i`, link `10.i.j.0/30`, AS `65000+i`), renders startup configs, and builds `helperSpec` for the helper.
- `drivers.mjs` gives a vendor-neutral view of FRR and cEOS state (interfaces, routes, OSPF, BGP, ping/traceroute parsing) from `show` output.
- `health.mjs` derives outcome-based checks from the design (what should be true), so any correct fix passes. `designChecks` is pure and tested. Each check has an `id` whose prefix is its group, a `name` (passing phrasing, shown in the ✅/❌ checklist), a `description` (failure phrasing, used as a symptom) and a `detail` (measured state, for Claude only).
- `faults.mjs` holds the `FAULTS` catalogue. Each fault has family, difficulty, `applies`/`candidates`/`resolve`, `actions` (ops such as `configure`, `link-state`, `link-mtu`, `netem` run by `runActions`), optional extra `checks`, hints and a ticket.
- `exercises.mjs` runs tutor mode: pick and inject faults, build the learner briefing (how much is shown depends on difficulty), validate, hint, reset. Anything under `tutor_only` must stay hidden from the learner.
- `setup.mjs` backs `check_setup`: it parses the helper's `doctor` facts and returns ordered checks, each failure with a `fix` command for the user to run.

On the lab host:
- `remote/install-remote.sh` (run by the user) installs the helper, `clab-mcp-admin` and `clab-mcp-ssh`, builds the FRR and host images, and pulls the Containerlab image when `clab` is not installed. It reads the image tags `FRR_IMAGE`, `HOST_IMAGE` and `CLAB_IMAGE` from `clab-mcp-remote`, so the helper is the one place to change them.
- The helper's `clab()` function uses an installed `clab`, or else runs `CLAB_IMAGE` as a sibling container with the lab folder mounted at the same path.
- `remote/frr/` adds `lab-start` (kernel settings) and `lab-netdev-sync` (Python; creates the VRRP macvlans, subinterfaces and dummies that FRR config implies) to the stock FRR image.
- `remote/clab-mcp-ssh` is the forced command for a lab-dojo-only SSH key (`command="...",restrict` in `authorized_keys`): it splits `SSH_ORIGINAL_COMMAND`, which must be the helper's path and single-quoted arguments as `remote.mjs` sends them, without a shell and runs the helper. Keep it bash 3.2 compatible; `tests/ssh-wrapper.test.mjs` sources it. The helper's `doctor` reports `ssh_access=restricted` when reached this way.
- `remote/clab-mcp-admin` is for a person with sudo only (registering extra images in the root-owned `/etc/containerlab-mcp/images`); the server never calls it.

## Rules for changes

- **Helper version:** when a helper action or its output changes, raise `HELPER_VERSION` in both `remote/clab-mcp-remote` and `server/src/setup.mjs` (a test enforces they match). `check_setup` then tells users to rerun the install.
- **Validate twice:** a new capability means a new allowlisted helper action that re-validates its arguments, plus the Node call. Never pass raw YAML, shell or file paths through.
- **Images:** never add code that pulls or installs images on the lab host from the server or helper. Images get there only through commands the user runs.
- **Public repo:** no personal paths, hostnames or image tags. `labs/` and `.mcp.json` are git-ignored; lab topologies, lab configs and exercises do not belong in the repo.
- **Line endings:** `.gitattributes` forces LF, because the `remote/` scripts run under bash on the lab host.
- User-facing text says "lab host", not "VM".

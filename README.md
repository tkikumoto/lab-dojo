# Lab Dojo

An MCP server that lets Claude build, inspect and break network labs on a Containerlab VM, and run guided troubleshooting exercises with Claude as the tutor. Routers are FRR (`quay.io/frrouting/frr:10.7.1`) and Arista cEOS (`ceos:4.36.2F`), and a single lab can mix both.

Claude Code launches the local Node server (`server/src/index.mjs`). The server reaches the Debian VM over SSH (`containerlab-server@orb`, OrbStack) and calls one allowlisted helper there: `/usr/local/libexec/clab-mcp-remote`.

## Security model

The VM helper is the trust boundary. It re-validates every request, even though the Node server validates first. Containerlab runs nodes as **privileged** containers, so a shell inside a router is a shell on the VM. The design therefore never lets a request reach a shell:

- **No raw Containerlab YAML.** `create_topology` takes a template or a node/link list. The helper renders the YAML itself with fixed images and fixed bind mounts, so there are no host paths, `exec:` hooks or host networking.
- **FRR's `daemons` file is generated, never accepted.** FRR's init script sources it as shell.
- **`exec_cli` accepts plain `show …` only:** `^show( [A-Za-z0-9./:_,=+-]+)*$`. Pipes and redirects are refused. Testing showed that `show version | bash id` really executes on cEOS.
- **`configure_device` lines are screened by first word, abbreviations included.** Both CLIs accept abbreviations, so `ev` (for `event-handler`), `st`, `en` and `wr` are refused too. Refused words: `do`, `end`, `exit`, `start-shell`, `write`, `copy`, `bash`, `event-handler`, `alias`, `schedule`, `daemon`, `extension`, `python…` and similar. Lines containing `bash`, `shell`, `python` or `/bin/`, and any `|`, `>`, `<`, backtick, `;` or `$(`, are also refused.
- **Strict argument validation.** Names, interfaces (`eth1+`; `eth0` is management), IP literals and numeric ranges are all validated, so option injection such as `ping -f` is impossible.
- **Resource caps.** At most 16 nodes per lab, 6 cEOS per lab, 8 cEOS running on the VM, and 6 lab definitions.

Tool annotations mark read-only tools (`readOnlyHint`) and destructive ones (`destroy_topology`, `reset_exercise`). You can auto-approve the read-only tools and keep prompts for the rest.

## Tools

| Layer | Tool | Purpose |
|---|---|---|
| 1 Lab | `list_labs` | Lab definitions and running container counts |
| | `create_topology` | Template (`line`, `ring`, `full-mesh`, `star`, `leaf-spine`) or explicit nodes/links; routing `ospf`, `ebgp`, `ibgp-ospf` or `none`; FRR, cEOS or mixed (`node_kinds`) |
| | `deploy_topology` | Deploy and wait until every router has loaded its config |
| | `destroy_topology` | Remove containers; optionally delete the definition (confirm first) |
| | `get_topology` | Design view: addressing, links, BGP sessions, node state |
| | `list_nodes` | Container state, management IP, loopback, interfaces |
| 2 Device | `exec_cli` | Read-only `show` on one node or `all`, optional JSON, regex `include` filter |
| | `configure_device` | Apply config lines (guarded); returns device output + diff vs startup |
| | `get_running_config` | Full config or just matching sections |
| | `get_interfaces` / `get_routes` / `get_bgp` / `get_ospf` | Vendor-neutral JSON for FRR and EOS alike |
| | `ping` / `traceroute` | Destinations/sources may be node names (= loopbacks) |
| | `snapshot_state` | Whole-lab summary + health checks (links, OSPF, BGP, BGP routes, loopback pings) |
| | `diff_config` | What changed since startup (one node or `all`) |
| 3 Exercises | `create_exercise` | Pick + inject faults by difficulty/focus, return learner briefing + tutor-only notes |
| | `inject_fault` | One specific fault (15 types, see below) |
| | `validate_exercise` | Outcome-based grading; any correct fix passes |
| | `get_hint` | Progressive hints (3 levels per fault) |
| | `reset_exercise` | `baseline`, `retry` (same faults again) or revert a single `fault_id` |
| | `get_exercise_status` | Status, attempts, hints used, tutor-only solutions |

MCP prompts appear as slash commands in Claude Code: `/mcp__lab-dojo__tutor_exercise` and `/mcp__lab-dojo__troubleshoot_lab`.

### Addressing plan

Every generated lab uses the same scheme, so learners can reason about addresses without looking them up:

- **Node index:** i = position of the node, starting at 1.
- **Loopback:** `10.255.0.<i>/32`.
- **Links:** a link between nodes i<j uses `10.<i>.<j>.0/30`. The lower-index node gets `.1`.
- **BGP modes:**
  - each node also has a service prefix `172.16.<i>.0/24`;
  - eBGP uses AS `65000+i` per node, and iBGP uses AS 65000 on every node.
- **OSPF:** OSPF links are point-to-point.
- **MTU:** every link is set to MTU 1500, so FRR and cEOS adjacencies come up.

### Fault catalogue

| Family | Faults |
|---|---|
| layer1 | `interface_shutdown`, `link_down` (Linux-level, FRR end only) |
| ip | `wrong_ip_address` (swapped octets), `static_blackhole` |
| ospf | `ospf_area_mismatch`, `ospf_hello_mismatch`, `ospf_passive_interface`, `ospf_auth_mismatch`, `mtu_mismatch` |
| bgp | `bgp_neighbor_shutdown`, `bgp_wrong_remote_as`, `bgp_missing_network`, `bgp_inbound_filter` |
| quality | `packet_loss`, `high_latency` (netem, FRR end) |

Difficulty controls how much the learner is told:

| Difficulty | Faults | Learner sees |
|---|---|---|
| `easy` | one level-1 fault | every failing check |
| `medium` | one level-2 fault | end-to-end symptoms only |
| `hard` | two faults on different routers | the ticket text only |

### Tutor mode

You, the human, are the learner. Claude reads the `tutor_only` sections and should not reveal them. Physical and quality faults (`link_down`, Linux MTU, netem) can't be fixed from a router CLI. Once you diagnose one, Claude "replaces the cable" with `reset_exercise` and that fault's `fault_id`.

## One-time VM installation

From the project folder on the Mac:

```bash
scp -r remote/. containerlab-server@orb:/tmp/containerlab-mcp-remote
ssh containerlab-server@orb 'cd /tmp/containerlab-mcp-remote && bash ./install-remote.sh'
```

The install script uses `sudo` for two things only:

- installing the helper under `/usr/local/libexec`;
- creating `/var/lib/containerlab-mcp/labs`, owned by your user. Lab definitions, generated configs and lab metadata live there.

It does not change SSH, Docker or Containerlab configuration. The VM account must already be able to run `docker` and `clab`, and both images must be present: `docker images` should list `quay.io/frrouting/frr:10.7.1` and `ceos:4.36.2F`.

## Claude Code connection

`.mcp.json` registers the server as `lab-dojo`. Its target is `containerlab-server@orb`, not `containerlab@orb`: that name selects a different OrbStack environment without Containerlab. The Node entry path is absolute; update it if you move the project. SSH connections are multiplexed through `~/.ssh/cm-clab-mcp-*` (override with `CONTAINERLAB_SSH_CONTROL_PATH`).

After changing server code, reconnect the server from `/mcp` so Claude Code picks it up.

Example prompts:

```text
Build a 4-router OSPF ring where r3 is Arista cEOS, and deploy it.
Show me the health of lab ring4.
Give me a medium OSPF troubleshooting exercise on ring4.
I think r2's hello timer is wrong — check it.
Validate my fix.
```

## Local checks

```bash
npm install
npm run check   # node --check on every module + bash -n on the remote scripts
```

`npm start` waits for MCP JSON-RPC on stdin; this is expected.

## End-to-end test sequence

1. `create_topology` with `{"name":"mix","template":"ring","size":4,"routing":"ibgp-ospf","node_kinds":{"r3":"ceos"},"deploy":true}`
2. `snapshot_state` with `lab: "mix"`. All 38 checks should pass.
3. `create_exercise` with `lab: "mix"` and `difficulty: "easy"`, then fix the fault, then `validate_exercise`.
4. `reset_exercise` with `lab: "mix"`.
5. After explicit confirmation, `destroy_topology` with `lab: "mix"` and `delete_definition: true`.

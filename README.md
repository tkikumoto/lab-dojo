# Lab Dojo

An MCP server that lets Claude build, inspect and break network labs on a Containerlab VM, and run guided troubleshooting exercises with Claude as the tutor. Routers are FRR (`lab-dojo/frr:10.7.1`, the stock `quay.io/frrouting/frr:10.7.1` plus the [lab additions](#frr-lab-image) below) and, optionally, Arista cEOS. A single lab can mix both.

Your MCP client (for example Claude Code) launches the local Node server (`server/src/index.mjs`). The server reaches a Linux VM over SSH and calls one allowlisted helper there: `/usr/local/libexec/clab-mcp-remote`.

## Requirements

On your own machine:

- Node.js 20 or newer, and an MCP client such as Claude Code.
- SSH access to the VM with a key, so `ssh <user>@<vm> true` works without a password prompt.

On the VM (any Linux machine or virtual machine you control):

- Docker, usable by your account without `sudo`.
- [Containerlab](https://containerlab.dev/install/), usable by your account as `clab`.
- `sudo` once, for the install script.

Router images:

| Image | Needed | How it gets there |
|---|---|---|
| FRR lab image | Yes | The install script builds it from the public FRR image. |
| Arista cEOS | No | Arista images need a sign-in, so you import one yourself: download cEOS-lab from arista.com, copy it to the VM and run `docker import cEOS64-lab-<version>.tar.xz ceos:<version>`. Any version works; the newest one present is used. |

Without cEOS you can build every FRR lab and run every exercise. Arista nodes and layer 2 labs need it.

## Setup

1. **Install the helper on the VM.** From this folder:

   ```bash
   scp -r remote/. <user>@<vm>:/tmp/containerlab-mcp-remote
   ssh <user>@<vm> 'cd /tmp/containerlab-mcp-remote && bash ./install-remote.sh'
   ```

2. **Register the server with your MCP client.** For Claude Code:

   ```bash
   claude mcp add lab-dojo --env CONTAINERLAB_SSH_TARGET=<user>@<vm> -- node /absolute/path/to/lab-dojo/server/src/index.mjs
   ```

   Or copy `.mcp.example.json` to `.mcp.json` in this folder and fill in the two values. `.mcp.json` is not tracked, so your own path and VM name stay local.

3. **Run the first-time check.** In Claude Code: `/mcp__lab-dojo__init`. It checks SSH, the helper and its version, Docker, Containerlab, lab storage and the images, and gives you the exact command for anything that is missing. It installs nothing itself. Run it again after an upgrade: it tells you when the helper on the VM is older than the server.

## Security model

The VM helper is the trust boundary. It re-validates every request, even though the Node server validates first. Containerlab runs nodes as **privileged** containers, so a shell inside a router is a shell on the VM. The design therefore never lets a request reach a shell:

- **No raw Containerlab YAML.** `create_topology` takes a template or a node/link list. The helper renders the YAML itself with fixed images and fixed bind mounts, so there are no host paths, `exec:` hooks or host networking.
- **FRR's `daemons` file is generated, never accepted.** FRR's init script sources it as shell.
- **`exec_cli` accepts plain `show …` only:** `^show( [A-Za-z0-9./:_,=+-]+)*$`. Pipes and redirects are refused. Testing showed that `show version | bash id` really executes on cEOS.
- **`configure_device` lines are screened by first word, abbreviations included.** Both CLIs accept abbreviations, so `ev` (for `event-handler`), `st`, `en` and `wr` are refused too. Refused words: `do`, `end`, `exit`, `start-shell`, `write`, `copy`, `bash`, `event-handler`, `alias`, `schedule`, `daemon`, `extension`, `python…` and similar. Lines containing `bash`, `shell`, `python` or `/bin/`, any `|`, `>`, `<`, `&`, backtick, `;` or `$(`, and any file path (an argument that starts with `/`) are also refused.
- **Strict argument validation.** Names, interfaces (`eth1+`; `eth0` is management), IP literals and numeric ranges are all validated, so option injection such as `ping -f` is impossible.
- **The FRR device watcher stays inside the node.** It creates devices only in that router's own network namespace, from interface names it validates, never through a shell and never on the management interface `eth0`.
- **Resource caps.** At most 16 nodes per lab, 6 cEOS per lab, 8 cEOS running on the VM, and 6 lab definitions.

Tool annotations mark read-only tools (`readOnlyHint`) and destructive ones (`destroy_topology`, `reset_exercise`). You can auto-approve the read-only tools and keep prompts for the rest.

## Tools

| Layer | Tool | Purpose |
|---|---|---|
| Setup | `check_setup` | Is the VM ready, which images are present, and the command to run for anything missing |
| 1 Lab | `list_labs` | Lab definitions and running container counts |
| | `create_topology` | Template (`line`, `ring`, `full-mesh`, `star`, `leaf-spine`) or explicit nodes/links; routing `ospf`, `ebgp`, `ibgp-ospf`, `none` (addresses only) or `bare` (cabling only); FRR, cEOS or mixed (`node_kinds`) |
| | `deploy_topology` | Deploy and wait until every router has loaded its config; returns the access details below |
| | `destroy_topology` | Remove containers; optionally delete the definition (confirm first) |
| | `get_topology` | Design view: addressing, links, BGP sessions, node state |
| | `list_nodes` | Container state, management IP, CLI command, loopback, and each link interface with the neighbour interface it faces |
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

### Slash commands

MCP prompts appear as slash commands in Claude Code. Claude Code adds the `mcp__lab-dojo__` prefix; type `/` and the first letters to pick one.

| Command | Argument | What it does |
|---|---|---|
| `/mcp__lab-dojo__init` | none | First-time check of the VM and its images; gives the command for anything missing. |
| `/mcp__lab-dojo__build_lab` | what you want, in your own words | Builds and deploys a lab. Claude first asks about anything the description leaves open, shows the plan, and waits for your go-ahead. |
| `/mcp__lab-dojo__exercise` | a lab name or a lab description, and optionally `easy`, `medium` or `hard` | Runs a troubleshooting exercise with Claude as tutor, on an existing lab or one built the same way as `build_lab`. |
| `/mcp__lab-dojo__troubleshoot_lab` | lab name | Claude diagnoses the lab bottom-up and explains what it finds. |

```text
/mcp__lab-dojo__build_lab "4 routers in a full mesh, I will do the routing"
/mcp__lab-dojo__build_lab "I want to practice STP"
/mcp__lab-dojo__exercise "eBGP lab with 4 routers, medium"
/mcp__lab-dojo__exercise "mix easy"
```

Put the request in quotes. Claude Code splits unquoted text on spaces and passes only the first word; the commands tell Claude to read the full text you typed in that case, so a forgotten quote still works in Claude Code.

Nothing is assumed to be running: every flow starts by listing the labs on the VM. The same rules apply when you ask in plain words without a slash command.

### Access details

Every deploy (`deploy_topology`, or `create_topology` with `deploy: true`) returns an `access` section, and Claude is instructed to show it to you as a table. For each node it gives:

- the management IP;
- the command that opens its CLI on the VM, e.g. `docker exec -it clab-ring4-r1 vtysh` for FRR or `docker exec -it clab-ring4-r3 Cli` for cEOS (a cEOS node also takes SSH on its management IP, with Containerlab's default login `admin` / `admin`);
- each link interface and the neighbour interface it connects to, e.g. `eth2 -> r3 Ethernet1`.

Run the commands on the VM, after `ssh <user>@<vm>`. `list_nodes` returns the same details at any time.

### FRR lab image

FRR configures interfaces but never creates them, and a container's kernel defaults are not a router's. FRR nodes therefore run `lab-dojo/frr:10.7.1`, built on the VM from `remote/frr/`, which adds:

- **A device watcher** (`lab-netdev-sync`). Every two seconds it reads the running configuration and creates the Linux devices it implies, so these need only FRR configuration:
  - `vrrp <vrid> ip <address>` or `vrrp <vrid> ipv6 <address>`: a macvlan on that interface with the VRRP virtual MAC and the virtual address. Without it `show vrrp` stays at `Initialize`. The address brings no subnet route, so a Master still sends its own traffic from its real address.
  - `interface <parent>.<vid>`, e.g. `eth2.10`: an 802.1Q subinterface, for router-on-a-stick.
  - `interface loopback<N>` or `dummy<N>`: a dummy interface.
- **Kernel settings** (`lab-start`): IPv6 forwarding on; `arp_ignore=1` and `arp_announce=2`, so a VRRP virtual IP resolves to the virtual MAC and not to each router's own MAC; `ignore_routes_with_linkdown=1`, so a VRRP backup does not route through its held-down virtual interface. It also removes the management network's default route: that route would outrank any default route the router learns and carry lab traffic out of the lab. The VM still reaches the node on the management subnet.
- **More daemons**: OSPFv2, OSPFv3, BGP, IS-IS, RIP, BFD, VRRP and static routing all run.
- **Tools**: `tcpdump` and `mtr`.

The watcher removes a device once the configuration that asked for it is gone, and recreates everything from the saved configuration when a node restarts. A subinterface or dummy is created when its stanza holds at least one line, and removed when the stanza is empty again; FRR refuses `no interface` while the device exists. `docker logs clab-<lab>-<node>` shows what it did.

Limits:

- A link-local IPv6 VRRP address (`vrrp 1 ipv6 fe80::1`) is not installed, because a second link-local on the macvlan breaks FRR's advertisement checksums. Use a global address as the gateway.
- VRF devices are not created automatically.
- Nothing is created on the management interface `eth0`, which sits on a bridge shared by every lab.
- What the kernel lacks, no container can use. For example the OrbStack kernel has no MPLS, no GRE and no IPv6 multicast routing, so LDP, MPLS and GRE tunnels cannot work on an OrbStack machine.

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

Routing `none` keeps this addressing and configures no routing protocol. Routing `bare` configures no addresses at all: only the cabling and interface descriptions. A bare cEOS link port stays a default switchport, so a bare lab of cEOS nodes is the layer 2 lab (STP, VLANs). Health checks on a bare lab cover the links only, and exercises offer only cable faults.

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

## What the install script does

It uses `sudo` for two things only:

- installing the helper under `/usr/local/libexec`;
- creating `/var/lib/containerlab-mcp/labs`, owned by your user. Lab definitions, generated configs and lab metadata live there.

Before that it builds the FRR lab image from `remote/frr/`, pulling the stock FRR image if it is missing. The tag and FRR release both come from `FRR_IMAGE` in `clab-mcp-remote`, so that is the one place to change the version.

It does not change SSH, Docker or Containerlab configuration. Rerun it after changing anything under `remote/`, and after pulling a new version of lab-dojo: the helper carries a version number, and `check_setup` reports a helper that is older than the server.

## Configuration

| Variable | Meaning |
|---|---|
| `CONTAINERLAB_SSH_TARGET` | `<user>@<vm>` of the lab VM. Required. |
| `CONTAINERLAB_REMOTE_HELPER` | Path of the helper on the VM. Default `/usr/local/libexec/clab-mcp-remote`. |
| `CONTAINERLAB_SSH_CONTROL_PATH` | Where SSH keeps its shared connection. Default `~/.ssh/cm-clab-mcp-*`. |

After changing server code, reconnect the server in your client (in Claude Code: `/mcp`) so it loads the new code.

Example requests in plain words:

```text
Build a 4-router OSPF ring and deploy it.
Show me the health of lab ring4.
Give me a medium OSPF troubleshooting exercise on ring4.
I think r2's hello timer is wrong — check it.
Validate my fix.
```

## Local checks

```bash
npm install
npm run check   # node --check on every module + bash -n on the remote scripts
npm test        # topology, fault targeting and ping parsing, then the helper's config-line filter
```

The filter test (`tests/check-line.sh`) needs bash 4 or newer. macOS ships bash 3.2, so there it reruns itself on the VM over SSH: set `CONTAINERLAB_SSH_TARGET` in your shell first. The VM must see this folder at the same path (OrbStack machines do); otherwise run the test on Linux. It reads the helper from this folder, so it tests your working copy and not the installed helper.

`npm start` waits for MCP JSON-RPC on stdin; this is expected.

## End-to-end test sequence

1. `create_topology` with `{"name":"mix","template":"ring","size":4,"routing":"ibgp-ospf","node_kinds":{"r3":"ceos"},"deploy":true}`
2. `snapshot_state` with `lab: "mix"`. All 38 checks should pass.
3. `create_exercise` with `lab: "mix"` and `difficulty: "easy"`, then fix the fault, then `validate_exercise`.
4. `reset_exercise` with `lab: "mix"`.
5. After explicit confirmation, `destroy_topology` with `lab: "mix"` and `delete_definition: true`.

## Licence

MIT. See [LICENSE](LICENSE).

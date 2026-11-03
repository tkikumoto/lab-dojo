# Lab Dojo

An MCP server that lets Claude build, inspect and break network labs on a Containerlab host, and run guided troubleshooting exercises with Claude as the tutor. Routers are FRR (`lab-dojo/frr:10.7.1`, the stock `quay.io/frrouting/frr:10.7.1` plus the [lab additions](#frr-lab-image) below) and, optionally, Arista cEOS. Labs can also hold Linux hosts. A single lab can mix all three.

Your MCP client (for example Claude Code) launches the local Node server (`server/src/index.mjs`). The server reaches a Linux lab host (a VM or a bare-metal machine) over SSH and calls one allowlisted helper there: `/usr/local/libexec/clab-mcp-remote`.

## Requirements

On your own machine:

- Node.js 22 or newer, and an MCP client such as Claude Code.
- SSH access to the lab host with a key, so `ssh <user>@<host> true` works without a password prompt.

macOS, Linux and Windows all work. On Windows, use the built-in OpenSSH client (`ssh` in PowerShell or cmd); it cannot share one connection between calls, so multi-router checks are a little slower there.

On the lab host (a Linux VM or a bare-metal Linux machine you control):

- Docker, usable by your account without `sudo`.
- [Containerlab](https://containerlab.dev/install/), either installed and usable by your account as `clab`, or not installed at all. Without it, the install script pulls the official image `ghcr.io/srl-labs/clab`, and the helper runs Containerlab from it as a short-lived container for each command. That container drives the host's Docker, so the lab routers run next to it as ordinary containers, not inside it.
- `sudo` once, for the install script.

Router images:

| Image | Needed | How it gets there |
|---|---|---|
| FRR lab image | Yes | The install script builds it from the public FRR image. |
| Linux host image | Yes | The install script builds it from public Alpine Linux. |
| Arista cEOS | No | Arista images need a sign-in, so you import one yourself: download cEOS-lab from arista.com, copy it to the lab host and run `docker import cEOS64-lab-<version>.tar.xz ceos:<version>`. Any version works; the newest one present is used. |

Without cEOS you can build every FRR lab and run every exercise. Arista nodes and layer 2 labs need it. Other public Linux images can be added later; see [Hosts and extra images](#hosts-and-extra-images).

## Setup

1. **Install the helper on the lab host.** From this folder:

   ```bash
   scp -r remote/. <user>@<host>:/tmp/containerlab-mcp-remote
   ssh <user>@<host> "cd /tmp/containerlab-mcp-remote && bash ./install-remote.sh"
   ```

2. **Register the server with your MCP client.** For Claude Code:

   ```bash
   claude mcp add lab-dojo --env CONTAINERLAB_SSH_TARGET=<user>@<host> -- node /absolute/path/to/lab-dojo/server/src/index.mjs
   ```

   On Windows, write the path with forward slashes, e.g. `C:/Users/me/lab-dojo/server/src/index.mjs`.

   Or copy `.mcp.example.json` to `.mcp.json` in this folder and fill in the two values. `.mcp.json` is not tracked, so your own path and lab host name stay local.

3. **Run the first-time check.** In Claude Code: `/mcp__lab-dojo__init`. It checks SSH, the helper and its version, Docker, Containerlab, lab storage and the images, and gives you the exact command for anything that is missing. It installs nothing itself. Run it again after an upgrade: it tells you when the helper on the lab host is older than the server.

## Security model

The helper on the lab host is the trust boundary. It re-validates every request, even though the Node server validates first. Containerlab runs nodes as **privileged** containers, so a shell inside a router is a shell on the lab host. The design therefore never lets a request reach a shell:

- **No raw Containerlab YAML.** `create_topology` takes a template or a node/link list. The helper renders the YAML itself with fixed images and fixed bind mounts, so there are no host paths, `exec:` hooks or host networking.
- **FRR's `daemons` file is generated, never accepted.** FRR's init script sources it as shell.
- **`exec_cli` accepts plain `show …` only:** `^show( [A-Za-z0-9./:_,=+-]+)*$`. Pipes and redirects are refused. Testing showed that `show version | bash id` really executes on cEOS.
- **`configure_device` lines are screened by first word, abbreviations included.** Both CLIs accept abbreviations, so `ev` (for `event-handler`), `st`, `en` and `wr` are refused too. Refused words: `do`, `end`, `exit`, `start-shell`, `write`, `copy`, `bash`, `event-handler`, `alias`, `schedule`, `daemon`, `extension`, `python…` and similar. Lines containing `bash`, `shell`, `python` or `/bin/`, any `|`, `>`, `<`, `&`, backtick, `;` or `$(`, and any file path (an argument that starts with `/`) are also refused.
- **Strict argument validation.** Names, interfaces (`eth1+`; `eth0` is management), IP literals and numeric ranges are all validated, so option injection such as `ping -f` is impossible.
- **The FRR device watcher stays inside the node.** It creates devices only in that router's own network namespace, from interface names it validates, never through a shell and never on the management interface `eth0`.
- **Fixed images.** A node runs the FRR image, a cEOS image, the built-in Linux host, or an image on a list that root owns on the lab host. Nodes are privileged, so an image is as trusted as root there. The helper cannot write that list and never pulls an image; only a person adds one, with `sudo clab-mcp-admin`.
- **Resource caps.** At most 16 nodes per lab, 6 cEOS per lab, 8 cEOS running on the lab host, and 6 lab definitions.

Tool annotations mark read-only tools (`readOnlyHint`) and destructive ones (`destroy_topology`, `reset_exercise`). You can auto-approve the read-only tools and keep prompts for the rest.

## Tools

| Layer | Tool | Purpose |
|---|---|---|
| Setup | `check_setup` | Is the lab host ready, which images are present, and the command to run for anything missing |
| 1 Lab | `list_labs` | Lab definitions and running container counts |
| | `create_topology` | Template (`line`, `ring`, `full-mesh`, `star`, `leaf-spine`) or explicit nodes/links; routing `ospf`, `ebgp`, `ibgp-ospf`, `none` (addresses only) or `bare` (cabling only); node kinds `frr`, `ceos` and `host`, mixed freely |
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
| `/mcp__lab-dojo__init` | none | First-time check of the lab host and its images; gives the command for anything missing. |
| `/mcp__lab-dojo__add_image` | the image you want, in your own words | Tells you how to make an image available: the command to run on the lab host, or why it cannot be done. Claude never adds an image itself. |
| `/mcp__lab-dojo__build_lab` | what you want, in your own words | Builds and deploys a lab. Claude first asks about anything the description leaves open, shows the plan, and waits for your go-ahead. |
| `/mcp__lab-dojo__exercise` | a lab name or a lab description, and optionally `easy`, `medium` or `hard` | Runs a troubleshooting exercise with Claude as tutor, on an existing lab or one built the same way as `build_lab`. |
| `/mcp__lab-dojo__validate` | lab name (optional when one lab is running) | Checks your work: grades the active exercise, or runs the lab's health checks when there is none. Shows every check with ✅ or ❌. |
| `/mcp__lab-dojo__troubleshoot_lab` | lab name | Claude diagnoses the lab bottom-up and explains what it finds. |

```text
/mcp__lab-dojo__build_lab "4 routers in a full mesh, I will do the routing"
/mcp__lab-dojo__build_lab "I want to practice STP"
/mcp__lab-dojo__exercise "eBGP lab with 4 routers, medium"
/mcp__lab-dojo__exercise "mix easy"
/mcp__lab-dojo__validate
```

Put the request in quotes. Claude Code splits unquoted text on spaces and passes only the first word; the commands tell Claude to read the full text you typed in that case, so a forgotten quote still works in Claude Code.

Nothing is assumed to be running: every flow starts by listing the labs on the lab host. The same rules apply when you ask in plain words without a slash command.

### Access details

Every deploy (`deploy_topology`, or `create_topology` with `deploy: true`) returns an `access` section, and Claude is instructed to show it to you as a table. For each node it gives:

- the management IP;
- the command that opens its CLI on the lab host, e.g. `docker exec -it clab-ring4-r1 vtysh` for FRR or `docker exec -it clab-ring4-r3 Cli` for cEOS (a cEOS node also takes SSH on its management IP, with Containerlab's default login `admin` / `admin`);
- each link interface and the neighbour interface it connects to, e.g. `eth2 -> r3 Ethernet1`.

Run the commands on the lab host, after `ssh <user>@<host>`. `list_nodes` returns the same details at any time.

### Hosts and extra images

A `host` node is a Linux machine: Alpine with `bash`, `ip`, `ping`, `traceroute`, `mtr`, `tcpdump`, `dig`, `curl` and `iperf3`. It is not a router:

- It gets no generated addresses and no startup configuration. You configure it by hand, e.g. `docker exec -it clab-<lab>-host1 bash`, then `ip addr add ...`. What you set is gone after a redeploy.
- On a link between a router and a host, the router's end keeps its generated address, so the gateway is ready.
- Router tools (`exec_cli`, `configure_device`, `get_routes` and so on) refuse a host. `ping` and `traceroute` from a host work.
- Health checks expect nothing of a host: no adjacency, no ping. A link to a host is judged from the router's end. Faults never land on a host or on a link towards one.

A host node can run another image instead, by name. Register a public image on the lab host first:

```bash
sudo /usr/local/libexec/clab-mcp-admin add-image web nginx:alpine   # pulls it and registers it as "web"
/usr/local/libexec/clab-mcp-admin list-images
sudo /usr/local/libexec/clab-mcp-admin remove-image web
```

Then a node `{ "name": "web1", "kind": "host", "image": "web" }` runs it. `check_setup` lists the registered images. The image must keep running by itself, and it needs `ping` and `traceroute` for those two tools to work from it.

When a lab needs an image the lab host does not have, Claude does not add it. It tells you which case applies:

| What is missing | What happens |
|---|---|
| A public Linux image | Claude gives you the `add-image` command to run, then continues. |
| An image behind a sign-in (Arista cEOS, Cisco and the like) | No command can pull it. Claude gives the manual steps where it knows them. |
| A router system other than FRR and cEOS | Not supported: every router tool needs code for that system. |

### FRR lab image

FRR configures interfaces but never creates them, and a container's kernel defaults are not a router's. FRR nodes therefore run `lab-dojo/frr:10.7.1`, built on the lab host from `remote/frr/`, which adds:

- **A device watcher** (`lab-netdev-sync`). Every two seconds it reads the running configuration and creates the Linux devices it implies, so these need only FRR configuration:
  - `vrrp <vrid> ip <address>` or `vrrp <vrid> ipv6 <address>`: a macvlan on that interface with the VRRP virtual MAC and the virtual address. Without it `show vrrp` stays at `Initialize`. The address brings no subnet route, so a Master still sends its own traffic from its real address.
  - `interface <parent>.<vid>`, e.g. `eth2.10`: an 802.1Q subinterface, for router-on-a-stick.
  - `interface loopback<N>` or `dummy<N>`: a dummy interface.
- **Kernel settings** (`lab-start`): IPv6 forwarding on; `arp_ignore=1` and `arp_announce=2`, so a VRRP virtual IP resolves to the virtual MAC and not to each router's own MAC; `ignore_routes_with_linkdown=1`, so a VRRP backup does not route through its held-down virtual interface. It also removes the management network's default route: that route would outrank any default route the router learns and carry lab traffic out of the lab. The lab host still reaches the node on the management subnet.
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

The briefing lists every check the lab must pass (`checks_to_pass`). `validate_exercise` returns them as a checklist, marked like test cases:

```text
BGP sessions (5/6)
  ✅ BGP session r1 <-> r2 (ibgp) is established
  ❌ BGP session r2 <-> r3 (ibgp) is established
  ...
Reachability (12/12)
  ✅ Ping from r1 (lo 10.255.0.1) to r2 (lo 10.255.0.2) succeeds
  ...

Not solved yet: 37/38
```

`snapshot_state` returns the same checklist for any lab, so a lab you configure yourself, without an exercise, can be checked the same way (`/mcp__lab-dojo__validate`).

On `hard` the briefing leaves out the checks a fault adds (they would point at it) and only says how many there are; `validate_exercise` shows them, and shows which checks fail.

### Tutor mode

You, the human, are the learner. Claude reads the `tutor_only` sections and should not reveal them. Physical and quality faults (`link_down`, Linux MTU, netem) can't be fixed from a router CLI. Once you diagnose one, Claude "replaces the cable" with `reset_exercise` and that fault's `fault_id`.

## What the install script does

It uses `sudo` for three things only:

- installing the helper and the admin script under `/usr/local/libexec`;
- creating `/var/lib/containerlab-mcp/labs`, owned by your user. Lab definitions, generated configs and lab metadata live there;
- creating `/etc/containerlab-mcp/images`, owned by root: the list of extra images. An existing list is kept.

Before that it builds the FRR lab image from `remote/frr/` and the Linux host image from `remote/host/`, pulling the public base images if they are missing. The tag and FRR release both come from `FRR_IMAGE` in `clab-mcp-remote`, so that is the one place to change the version. When Containerlab is not installed, it also pulls the Containerlab image named by `CLAB_IMAGE` there.

It does not change SSH, Docker or Containerlab configuration. Rerun it after changing anything under `remote/`, and after pulling a new version of lab-dojo: the helper carries a version number, and `check_setup` reports a helper that is older than the server.

## Configuration

| Variable | Meaning |
|---|---|
| `CONTAINERLAB_SSH_TARGET` | `<user>@<host>` of the lab host. Required. |
| `CONTAINERLAB_REMOTE_HELPER` | Path of the helper on the lab host. Default `/usr/local/libexec/clab-mcp-remote`. |
| `CONTAINERLAB_SSH_CONTROL_PATH` | Where SSH keeps its shared connection. Default `~/.ssh/cm-clab-mcp-*`. Not used on Windows, which has no connection sharing. |

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

`npm run check` needs bash and python3, so run it on macOS or Linux. On Windows `npm test` skips the filter test.

The filter test (`tests/check-line.sh`) needs bash 4 or newer. macOS ships bash 3.2, so there it reruns itself on the lab host over SSH: set `CONTAINERLAB_SSH_TARGET` in your shell first. The lab host must see this folder at the same path (OrbStack machines do); otherwise run the test on Linux. It reads the helper from this folder, so it tests your working copy and not the installed helper.

`npm start` waits for MCP JSON-RPC on stdin; this is expected.

## End-to-end test sequence

1. `create_topology` with `{"name":"mix","template":"ring","size":4,"routing":"ibgp-ospf","node_kinds":{"r3":"ceos"},"deploy":true}`
2. `snapshot_state` with `lab: "mix"`. All 38 checks should pass.
3. `create_exercise` with `lab: "mix"` and `difficulty: "easy"`, then fix the fault, then `validate_exercise`.
4. `reset_exercise` with `lab: "mix"`.
5. After explicit confirmation, `destroy_topology` with `lab: "mix"` and `delete_definition: true`.

## Licence

MIT. See [LICENSE](LICENSE).

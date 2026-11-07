# Reference

Details behind the [README](../README.md): the tools, how labs are built, and how exercises work.

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
| | `host_command` | On a host node: allowlisted `ip` and `ethtool` commands (addresses, routes, bonds/LACP, VLAN subinterfaces, link state) |
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

## Access details

Every deploy (`deploy_topology`, or `create_topology` with `deploy: true`) returns an `access` section, and Claude is instructed to show it to you as a table. For each node it gives:

- the management IP;
- the command that opens its CLI on the lab host, e.g. `docker exec -it clab-ring4-r1 vtysh` for FRR or `docker exec -it clab-ring4-r3 Cli` for cEOS (a cEOS node also takes SSH on its management IP, with Containerlab's default login `admin` / `admin`);
- each link interface and the neighbour interface it connects to, e.g. `eth2 -> r3 Ethernet1`.

Run the commands on the lab host, after `ssh <user>@<host>`. `list_nodes` returns the same details at any time.

## Hosts and extra images

A `host` node is a Linux machine: Alpine with `bash`, `ip`, `ping`, `traceroute`, `mtr`, `tcpdump`, `dig`, `curl` and `iperf3`. It is not a router:

- It gets no generated addresses and no startup configuration. You configure it by hand, e.g. `docker exec -it clab-<lab>-host1 bash`, then `ip addr add ...`, or Claude does with `host_command`. What you set is gone after a redeploy, and `reset_exercise` leaves it alone.
- `host_command` runs only exact forms of `ip` (link, addr, route, neigh; bond, VLAN and dummy devices), `ethtool` and `cat /proc/net/bonding/bondN`, never on `eth0` and never through a shell. An LACP bond needs the `bonding` module in the lab host's kernel; if creating one fails with `Unknown device type`, run `sudo modprobe bonding` on the lab host.
- On a link between a router and a host, the router's end keeps its generated address, so the gateway is ready.
- Router tools (`exec_cli`, `configure_device`, `get_routes` and so on) refuse a host, and `host_command` refuses a router. `ping` and `traceroute` from a host work.
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

## FRR lab image

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

## Addressing plan

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

## Faults and exercises

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

## Tutor mode

You, the human, are the learner. Claude reads the `tutor_only` sections and should not reveal them. Physical and quality faults (`link_down`, Linux MTU, netem) can't be fixed from a router CLI. Once you diagnose one, Claude "replaces the cable" with `reset_exercise` and that fault's `fault_id`.

## Configuration

| Variable | Meaning |
|---|---|
| `CONTAINERLAB_SSH_TARGET` | `<user>@<host>` of the lab host. Required. |
| `CONTAINERLAB_REMOTE_HELPER` | Path of the helper on the lab host. Default `/usr/local/libexec/clab-mcp-remote`. |
| `CONTAINERLAB_SSH_CONTROL_PATH` | Where SSH keeps its shared connection. Default `~/.ssh/cm-clab-mcp-*`. Not used on Windows, which has no connection sharing. |

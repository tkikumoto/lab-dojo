# Lab Dojo

An MCP server that lets Claude build, inspect and break network labs, and tutor you while you troubleshoot them. Labs run in [Containerlab](https://containerlab.dev) on a Linux lab host, either a VM or a bare-metal machine. They hold FRR routers, optionally Arista cEOS routers, and Linux hosts.

```text
Your machine                                Lab host (Linux)
Claude Code -> lab-dojo server  --SSH-->    helper -> Docker + Containerlab -> lab routers
```

## Before you start

**On your machine** (macOS, Linux or Windows):

- Node.js 22 or newer, and Claude Code (or another MCP client).
- An `ssh` client. On Windows, use the built-in OpenSSH client.
- This repository with its dependencies:
  ```bash
  git clone https://github.com/tkikumoto/lab-dojo.git
  cd lab-dojo && npm install
  ```

**On the lab host:**

- Linux with Docker. Your account must run `docker ps` without `sudo` (add it to the `docker` group). Without Docker, the install sets it up with Docker's own script (Debian, Ubuntu, Fedora or the RHEL family) and adds your account to the `docker` group.
- `sudo` rights, once, for the install.
- Containerlab is optional. Without it, lab-dojo runs Containerlab from its official image.
- Arista cEOS is optional. It needs an Arista sign-in, so you import it yourself: download cEOS-lab from arista.com in the build for the lab host's CPU (amd64 or arm64; `uname -m` on the lab host says `x86_64` or `aarch64`), copy it to the lab host, and run `docker import <downloaded file>.tar.xz ceos:<version>`. Without it, every FRR lab and exercise still works.

**Between the two:**

- SSH key login: `ssh <user>@<host> true` must work without a password prompt.
- Connect once by hand with `ssh <user>@<host>` and answer `yes` to accept the host key. lab-dojo connects without a terminal, so it cannot answer that question itself.

## First-time setup

1. **Register the server with Claude Code**, from the `lab-dojo` folder:

   ```bash
   claude mcp add lab-dojo --env CONTAINERLAB_SSH_TARGET=<user>@<host> -- node "$PWD/server/src/index.mjs"
   ```

   On Windows, give the full path with forward slashes, e.g. `node C:/Users/me/lab-dojo/server/src/index.mjs`. You can also copy `.mcp.example.json` to `.mcp.json` and fill it in; that file is not tracked.

2. **Run the setup check:** `/mcp__lab-dojo__init`. On a new lab host, it reports that lab-dojo's helper is missing and gives you the install command to run from the `lab-dojo` folder:

   ```bash
   scp -r remote/. <user>@<host>:/tmp/containerlab-mcp-remote
   ssh <user>@<host> "cd /tmp/containerlab-mcp-remote && bash ./install-remote.sh"
   ```

   This installs the helper, builds the FRR and Linux host images, and pulls the Containerlab image if Containerlab is not installed. `init` first asks where your labs should live on the lab host (default `~/labs`) and adds that folder to the end of the install command. To move your labs later, rerun the install with a new, empty folder; it refuses while a lab is deployed.

3. **Run `/mcp__lab-dojo__init` again.** When every check passes, you are ready.

4. **Recommended: give lab-dojo its own SSH key** that can only run the helper. `init` shows the steps under "Restricted SSH key". Without it, lab-dojo's key, which is your own, opens a full shell on the lab host, and so does Claude's Bash tool. See [Security](docs/security.md#a-key-that-can-only-run-the-helper).

`init` only checks; it never installs anything itself. It tells you when SSH or Docker is the problem, but you fix those yourself. After you update lab-dojo, reconnect the server (`/mcp` in Claude Code) and run `init` again: it tells you when the lab host needs the install again.

## Commands

Type `/` and the first letters of a command. Put the request in quotes. You can also just ask in plain words, e.g. "build me a 3-router OSPF ring"; the same rules apply.

**`/mcp__lab-dojo__init`**: check that the lab host is ready, and get the command for anything missing.

```text
/mcp__lab-dojo__init
```

**`/mcp__lab-dojo__build_lab`**: build and start a lab from a description. Claude asks about anything left open (number of routers, how they connect, router type, what is pre-configured, lab name), shows a plan, and waits for your go-ahead.

```text
/mcp__lab-dojo__build_lab "3 routers in a ring running OSPF"
/mcp__lab-dojo__build_lab "2 routers, addresses only, I will add static routes"
/mcp__lab-dojo__build_lab "4 cEOS switches, I want to practice STP"
```

**`/mcp__lab-dojo__exercise`**: a troubleshooting exercise with Claude as your tutor. Claude breaks something in a working lab (an existing one, or one it builds from your description) and gives you a ticket and the checks to pass. Difficulty is `easy`, `medium` (default) or `hard`.

```text
/mcp__lab-dojo__exercise "eBGP lab with 4 routers, medium"
/mcp__lab-dojo__exercise "ring4 hard"
```

**`/mcp__lab-dojo__validate`**: check your work. It grades the active exercise, or runs the lab's health checks when there is no exercise. The lab name is optional when one lab is running.

```text
/mcp__lab-dojo__validate
/mcp__lab-dojo__validate static2
```

```text
Links (1/1)
  ✅ Link r1 eth1 <-> r2 eth1 is up
Reachability (1/2)
  ✅ Ping from r1 (lo 10.255.0.1) to r2 (lo 10.255.0.2) succeeds
  ❌ Ping from r2 (lo 10.255.0.2) to r1 (lo 10.255.0.1) succeeds

Not solved yet: 2/3
```

**`/mcp__lab-dojo__troubleshoot_lab`**: Claude diagnoses a lab layer by layer and explains what it finds. It asks before changing anything.

```text
/mcp__lab-dojo__troubleshoot_lab ring4
```

**`/mcp__lab-dojo__add_image`**: find out how to use another Linux image as a host node. Claude gives you the command to run on the lab host, or explains why it cannot be done. It never adds an image itself.

```text
/mcp__lab-dojo__add_image "an nginx web server"
```

## Good to know

- After a lab starts, Claude shows a table with each node's management IP and the command that opens its CLI on the lab host, e.g. `docker exec -it clab-ring4-r1 vtysh` (FRR) or `docker exec -it clab-ring4-r3 Cli` (cEOS). cEOS also accepts SSH with `admin` / `admin`.
- Configuration changes are not saved. Resetting an exercise or redeploying a lab returns the routers to their starting configuration.
- Limits: 16 nodes and 6 cEOS per lab, 8 cEOS running at once, 6 labs defined.
- Claude asks before it destroys a lab.

## More

- [Reference](docs/reference.md): every tool, the addressing plan, faults and difficulty levels, host nodes and extra images, the FRR lab image, configuration variables.
- [Security model](docs/security.md): how the lab host is protected, and what the install script does.
- [Development](docs/development.md): tests and checks.

## Licence

MIT. See [LICENSE](LICENSE).

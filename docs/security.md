# Security model

The helper on the lab host is the trust boundary. It re-validates every request, even though the Node server validates first. Containerlab runs nodes as **privileged** containers, so a shell inside a router is a shell on the lab host. The design therefore never lets a request reach a shell:

- **No raw Containerlab YAML.** `create_topology` takes a template or a node/link list. The helper renders the YAML itself with fixed images and fixed bind mounts, so there are no host paths, `exec:` hooks or host networking.
- **FRR's `daemons` file is generated, never accepted.** FRR's init script sources it as shell.
- **`exec_cli` accepts plain `show …` only:** `^show( [A-Za-z0-9./:_,=+-]+)*$`. Pipes and redirects are refused. Testing showed that `show version | bash id` really executes on cEOS.
- **`configure_device` lines are screened by first word, abbreviations included.** Both CLIs accept abbreviations, so `ev` (for `event-handler`), `st`, `en` and `wr` are refused too. Refused words: `do`, `end`, `exit`, `start-shell`, `write`, `copy`, `bash`, `event-handler`, `alias`, `schedule`, `daemon`, `extension`, `python…` and similar. Lines containing `bash`, `shell`, `python` or `/bin/`, any `|`, `>`, `<`, `&`, backtick, `;` or `$(`, and any file path (an argument that starts with `/`) are also refused.
- **Host nodes get no shell.** A host has no CLI to screen, so `host_command` accepts only exact forms of `ip` (link, addr, route and neigh; bond, VLAN and dummy devices), `ethtool <if>` and `cat /proc/net/bonding/bondN`. The helper parses each word against that grammar and runs it with `docker exec` without a shell. `eth0`, `netns`, `-batch`, XDP, macvlan and bridge devices are refused.
- **Strict argument validation.** Names, interfaces (`eth1+`; `eth0` is management), IP literals and numeric ranges are all validated, so option injection such as `ping -f` is impossible.
- **The FRR device watcher stays inside the node.** It creates devices only in that router's own network namespace, from interface names it validates, never through a shell and never on the management interface `eth0`.
- **Fixed images.** A node runs the FRR image, a cEOS image, the built-in Linux host, or an image on a list that root owns on the lab host. Nodes are privileged, so an image is as trusted as root there. The helper cannot write that list and never pulls an image; only a person adds one, with `sudo clab-mcp-admin`.
- **Resource caps.** At most 16 nodes per lab, 6 cEOS per lab, 8 cEOS running on the lab host, and 6 lab definitions.

Tool annotations mark read-only tools (`readOnlyHint`) and destructive ones (`destroy_topology`, `reset_exercise`). You can auto-approve the read-only tools and keep prompts for the rest.

## A key that can only run the helper

The helper limits what lab-dojo's *tools* can do. The SSH key behind them is a separate question: if it is your own key, it opens a full shell on the lab host, and anything that can use it gets that shell, including Claude's own Bash tool. A non-sudo account does not fix this: lab-dojo needs Docker, and the `docker` group is root on the lab host.

So give lab-dojo a key of its own, locked in `~/.ssh/authorized_keys` on the lab host:

```text
command="/usr/local/libexec/clab-mcp-ssh",restrict ssh-ed25519 AAAA... lab-dojo
```

sshd then runs `clab-mcp-ssh` for every connection with that key, whatever was asked, and `restrict` turns off port, agent and X11 forwarding and terminals. `clab-mcp-ssh` accepts only the request the server sends (the helper's path and single-quoted arguments), splits it without a shell and runs the helper; anything else is refused. It is installed root-owned, so the key cannot change it. `check_setup` reports whether the server came in through such a key and prints the steps when it did not.

What this does not cover:

- **Your own key.** Claude's Bash tool runs as you, so it can use your personal key too. Make that key ask before each use (an SSH agent with Touch ID per use, such as Secretive or 1Password), or deny `ssh` and `scp` to Claude's Bash in Claude Code's settings.
- **OrbStack.** OrbStack gives your Mac user root on its machines through its own `orb` command and SSH, with no key involved, so no key can limit it. Treat an OrbStack lab host as disposable; if it breaks, recreate the machine.
- **The switch-over.** The server reuses one SSH connection for up to two minutes. Reconnect the server after changing `CONTAINERLAB_SSH_TARGET`, and wait two minutes or run `ssh -O exit -o ControlPath=~/.ssh/cm-clab-mcp-%C <old target>` to close the old connection.

## What the install script does

Apart from setting up Docker (below), it uses `sudo` for three things only:

- installing the helper, the admin script and the SSH wrapper (`clab-mcp-ssh`) under `/usr/local/libexec`;
- creating `/var/lib/containerlab-mcp/labs`, owned by your user. Lab definitions, generated configs and lab metadata live there;
- creating `/etc/containerlab-mcp/images`, owned by root: the list of extra images. An existing list is kept.

Before that it builds the FRR lab image from `remote/frr/` and the Linux host image from `remote/host/`, pulling the public base images if they are missing. The tag and FRR release both come from `FRR_IMAGE` in `clab-mcp-remote`, so that is the one place to change the version. When Containerlab is not installed, it also pulls the Containerlab image named by `CLAB_IMAGE` there.

First, when `docker` is missing, it runs Docker's install script from https://get.docker.com as root, and when your account cannot use Docker, it adds the account to the `docker` group. Otherwise it does not change SSH, Docker or Containerlab configuration. Rerun it after changing anything under `remote/`, and after pulling a new version of lab-dojo: the helper carries a version number, and `check_setup` reports a helper that is older than the server.

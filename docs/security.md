# Security model

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

## What the install script does

It uses `sudo` for three things only:

- installing the helper and the admin script under `/usr/local/libexec`;
- creating `/var/lib/containerlab-mcp/labs`, owned by your user. Lab definitions, generated configs and lab metadata live there;
- creating `/etc/containerlab-mcp/images`, owned by root: the list of extra images. An existing list is kept.

Before that it builds the FRR lab image from `remote/frr/` and the Linux host image from `remote/host/`, pulling the public base images if they are missing. The tag and FRR release both come from `FRR_IMAGE` in `clab-mcp-remote`, so that is the one place to change the version. When Containerlab is not installed, it also pulls the Containerlab image named by `CLAB_IMAGE` there.

It does not change SSH, Docker or Containerlab configuration. Rerun it after changing anything under `remote/`, and after pulling a new version of lab-dojo: the helper carries a version number, and `check_setup` reports a helper that is older than the server.

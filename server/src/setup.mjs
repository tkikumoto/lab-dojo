// First-run check of the lab host, also useful after an upgrade. It only reads:
// every fix is a command for the user to run, never something this server does.
import { remote, RemoteRefusal, sshTarget } from "./remote.mjs";

/** Must equal HELPER_VERSION in remote/clab-mcp-remote. */
export const HELPER_VERSION = 6;

const installSteps = (target) => [
  "Run from the lab-dojo folder:",
  `scp -r remote/. ${target}:/tmp/containerlab-mcp-remote`,
  `ssh ${target} "cd /tmp/containerlab-mcp-remote && bash ./install-remote.sh"`,
].join("\n");

const CEOS_STEPS = "Arista images need a sign-in, so no command can pull one. Download cEOS-lab from arista.com, "
  + "picking the build for the lab host's CPU (`uname -m` there: x86_64 means amd64, aarch64 means arm64), "
  + "copy the file to the lab host and run there: docker import <downloaded file>.tar.xz ceos:<version>";

// A key that can only run the helper (clab-mcp-ssh as its forced command), so
// whoever holds it gets no shell on the lab host. All steps are the user's.
const restrictedKeySteps = (target) => [
  "1. On this machine, make a key for lab-dojo only. It needs no passphrase: it will only be able to run the helper.",
  "ssh-keygen -t ed25519 -N '' -C lab-dojo -f ~/.ssh/lab-dojo",
  "2. Allow it on the lab host, locked to the helper (this uses your current key once):",
  // The leading echo starts a new line, in case the file does not end with one.
  `(echo; echo "command=\\"/usr/local/libexec/clab-mcp-ssh\\",restrict $(cat ~/.ssh/lab-dojo.pub)") | ssh ${target} 'cat >> ~/.ssh/authorized_keys'`,
  "3. Add to ~/.ssh/config on this machine:",
  "Host lab-dojo-<name>\n  HostName <lab host address>\n  User <your user there>\n  IdentityFile ~/.ssh/lab-dojo\n  IdentitiesOnly yes",
  "4. Set CONTAINERLAB_SSH_TARGET=lab-dojo-<name> in this server's MCP configuration and reconnect it. `ssh lab-dojo-<name> true` must now be refused.",
].join("\n");

// For the user to run on the lab host; the server never runs it. It pulls a public
// image and registers it under a short name that a host node can then use.
const ADD_IMAGE_COMMAND = "sudo /usr/local/libexec/clab-mcp-admin add-image <name> <image-ref>";

/** The helper's "key=value" lines as an object. */
export function parseFacts(text) {
  return Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => {
    const at = l.indexOf("=");
    return [l.slice(0, at), l.slice(at + 1).trim()];
  }));
}

/**
 * Builds the report from what the helper said (`facts`), or from the error of
 * asking it (`failure`: exitCode, refused, message). Checks run in the order a
 * new user hits them, and stop at the first one that blocks the rest.
 */
export function setupReport(target, facts, failure) {
  const checks = [];
  const add = (check, ok, detail, fix) => checks.push({ check, ok, detail, ...(!ok && fix ? { fix } : {}) });
  const report = (extra) => ({ ready: checks.every((c) => c.ok || c.optional), checks, ...extra });

  if (!target) {
    add("Lab host address", false, "CONTAINERLAB_SSH_TARGET is not set",
      "Set CONTAINERLAB_SSH_TARGET to <user>@<address> of the lab host in this server's MCP configuration, then reconnect the server.");
    return report();
  }
  // ssh itself exits 255; a timeout or a failed spawn has no exit code at all.
  if (failure && !failure.refused && (failure.exitCode === 255 || failure.exitCode == null)) {
    add("SSH to the lab host", false, failure.message, `This must work without a password prompt: ssh ${target} true`);
    return report();
  }
  add("SSH to the lab host", true, target);

  if (failure?.exitCode === 127) {
    add("Helper on the lab host", false, "not installed", installSteps(target));
    return report();
  }
  // A helper from before the doctor action answers "invalid action".
  const version = failure?.refused ? "an older version" : `version ${facts?.helper_version}`;
  if (failure && !failure.refused) {
    add("Helper on the lab host", false, failure.message);
    return report();
  }
  if (failure || Number(facts.helper_version) !== HELPER_VERSION) {
    add("Helper on the lab host", false, `${version} is installed, this server needs version ${HELPER_VERSION}`, installSteps(target));
    return report();
  }
  add("Helper on the lab host", true, version);

  add("Docker", Boolean(facts.docker), facts.docker || "not usable",
    "Your account on the lab host must be able to run `docker` without sudo.");
  // Containerlab is either installed, or run from its image as a container next to the labs.
  const image = facts.containerlab_runs_as?.match(/^container (.+)/)?.[1];
  add("Containerlab", Boolean(facts.containerlab),
    facts.containerlab ? `${facts.containerlab}${image ? `, run from the image ${image}` : ""}` : "not usable",
    image
      ? `It is not installed, and its image ${image} is missing. Install Containerlab (https://containerlab.dev/install/), or rerun the install, which pulls the image:\n${installSteps(target)}`
      : "Install Containerlab on the lab host (https://containerlab.dev/install/) and make sure this account can run `clab`.");
  add("Lab storage", facts.lab_storage === "ok", facts.lab_storage === "ok" ? "writable" : "missing", installSteps(target));
  add("FRR router image", Boolean(facts.frr_image), facts.frr_image || "not built", installSteps(target));
  add("Linux host image", Boolean(facts.host_image), facts.host_image || "not built", installSteps(target));
  const restricted = facts.ssh_access === "restricted";
  const orbstack = facts.orbstack === "yes";
  checks.push({
    check: "Restricted SSH key (recommended)",
    ok: restricted,
    optional: true,
    detail: restricted
      ? "this server's key can only run the helper"
      : orbstack
        ? "not possible here: OrbStack gives your Mac user root on its machines without any key, so treat this lab host as disposable"
        : "this server's key opens a full shell on the lab host",
    ...(restricted || orbstack ? {} : { fix: restrictedKeySteps(target) }),
  });
  checks.push({
    check: "Arista cEOS image (optional)",
    ok: Boolean(facts.ceos_image),
    optional: true,
    detail: facts.ceos_image || "not present",
    ...(facts.ceos_image ? {} : { fix: CEOS_STEPS }),
  });

  const ready = checks.every((c) => c.ok || c.optional);
  return report({
    memory_available_mb: Number(facts.memory_available_mb),
    labs_defined: `${facts.labs_defined} of ${facts.labs_max}`,
    can_build: ready
      ? [
        "routed labs and exercises with FRR routers",
        "Linux host nodes (Alpine with network tools)",
        ...(facts.ceos_image ? ["Arista cEOS nodes, and layer 2 labs (routing `bare`)"] : []),
      ]
      : [],
    not_available: facts.ceos_image ? [] : ["Arista cEOS nodes and layer 2 labs: the lab host has no ceos image"],
    // Images a person registered for host nodes, as "name=image". "(missing)" marks one that is registered but not on the lab host.
    extra_images: (facts.extra_images ?? "").split(",").filter(Boolean),
    add_image_command: ADD_IMAGE_COMMAND,
  });
}

export async function checkSetup() {
  if (!sshTarget) return setupReport(sshTarget);
  try {
    return setupReport(sshTarget, parseFacts(await remote("doctor")));
  } catch (error) {
    return setupReport(sshTarget, null, { exitCode: error.exitCode, refused: error instanceof RemoteRefusal, message: error.message });
  }
}

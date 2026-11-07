#!/usr/bin/env bash
set -euo pipefail

# Run on the lab host (a Linux VM or bare-metal machine) as the account that
# owns Docker access:  bash ./install-remote.sh [lab folder]
# It installs the reviewed helper and the admin script, builds the FRR and host
# images, and creates the lab folder, owned by that account so generated labs
# can be written without sudo. The list of extra images is owned by root: only
# clab-mcp-admin, run with sudo by a person, changes it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OWNER="$(id -un)"
fail() { echo "$*" >&2; exit 1; }

# A fresh lab host may have no Docker: install it with Docker's own script
# (Debian, Ubuntu, Fedora, RHEL family), then give this account access. The new
# group only applies to a new login, so rerun this script once under `sg docker`.
type -P docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh
if ! docker info >/dev/null 2>&1; then
  [[ -z ${LAB_DOJO_REGROUPED:-} ]] || { echo "Docker is installed but $OWNER still cannot use it. Is it running? sudo systemctl status docker" >&2; exit 1; }
  sudo usermod -aG docker "$OWNER"
  exec sg docker -c "LAB_DOJO_REGROUPED=1 bash $(printf '%q ' "$SCRIPT_DIR/install-remote.sh" "$@")"
fi

# The lab folder: the argument, else the one an earlier install recorded, else
# ~/labs. Installs before helper version 8 kept labs in /var/lib/containerlab-mcp/labs
# without recording it, so that folder stays when it holds labs. The helper
# reads the choice from a root-owned file and checks it with LABS_DIR_RE.
LABS_DIR_FILE="$(sed -n 's/^LABS_DIR_FILE=//p' "$SCRIPT_DIR/clab-mcp-remote")"
LABS_DIR_RE="$(sed -n "s/^LABS_DIR_RE='\(.*\)'$/\1/p" "$SCRIPT_DIR/clab-mcp-remote")"
[[ -n $LABS_DIR_FILE && -n $LABS_DIR_RE ]] || fail "LABS_DIR_FILE or LABS_DIR_RE not found in clab-mcp-remote"
OLD_LABS=/var/lib/containerlab-mcp/labs
CURRENT_LABS="$(head -n 1 "$LABS_DIR_FILE" 2>/dev/null || true)"
[[ -n $CURRENT_LABS || -z $(ls -A "$OLD_LABS" 2>/dev/null) ]] || CURRENT_LABS=$OLD_LABS
LABS_DIR="$(realpath -m -- "${1:-${CURRENT_LABS:-$HOME/labs}}")"
[[ $LABS_DIR =~ $LABS_DIR_RE ]] || fail "The lab folder must be an absolute path of letters, digits, '.', '_' and '-' (no hidden folders): $LABS_DIR"
shopt -s nullglob
MOVE_LABS=()
if [[ $LABS_DIR != "$CURRENT_LABS" ]]; then
  [[ -z $(ls -A "$LABS_DIR" 2>/dev/null) ]] || fail "$LABS_DIR is not empty. Choose a new or empty folder for labs."
  [[ -z $CURRENT_LABS ]] || MOVE_LABS=("$CURRENT_LABS"/*/)
  for lab in "${MOVE_LABS[@]}"; do
    lab="$(basename "$lab")"
    [[ -z $(docker ps -q --filter "label=containerlab=$lab") ]] ||
      fail "Lab $lab is deployed. Destroy it before moving labs from $CURRENT_LABS to $LABS_DIR."
  done
fi

# The helper names the FRR image it deploys. Build exactly that one, on the
# matching FRR release, before the helper that depends on it is installed.
FRR_IMAGE="$(sed -n 's/^FRR_IMAGE=//p' "$SCRIPT_DIR/clab-mcp-remote")"
[[ $FRR_IMAGE == */frr:* ]] || { echo "FRR_IMAGE not found in clab-mcp-remote" >&2; exit 1; }
docker build -q --build-arg "FRR_VERSION=${FRR_IMAGE##*:}" -t "$FRR_IMAGE" "$SCRIPT_DIR/frr" >/dev/null
HOST_IMAGE="$(sed -n 's/^HOST_IMAGE=//p' "$SCRIPT_DIR/clab-mcp-remote")"
[[ $HOST_IMAGE == */host:* ]] || { echo "HOST_IMAGE not found in clab-mcp-remote" >&2; exit 1; }
docker build -q -t "$HOST_IMAGE" "$SCRIPT_DIR/host" >/dev/null
# A rebuild leaves the build it replaces without a tag. Remove those, and only
# those: the label limits this to images built from this folder.
docker image prune -f --filter label=org.lab-dojo.image >/dev/null
# Without an installed Containerlab, the helper runs it from this image.
CLAB_IMAGE="$(sed -n 's/^CLAB_IMAGE=//p' "$SCRIPT_DIR/clab-mcp-remote")"
[[ $CLAB_IMAGE == */clab:* ]] || { echo "CLAB_IMAGE not found in clab-mcp-remote" >&2; exit 1; }
if type -P clab >/dev/null; then
  CLAB_NOTE="Containerlab: installed ($(type -P clab))"
else
  docker pull -q "$CLAB_IMAGE" >/dev/null
  CLAB_NOTE="Containerlab: not installed, so it runs from the image $CLAB_IMAGE"
fi

sudo install -d -m 0755 /etc/containerlab-mcp
[[ -d $LABS_DIR ]] || mkdir -p -- "$LABS_DIR" 2>/dev/null || sudo install -d -m 0755 -o "$OWNER" -g "$(id -gn)" "$LABS_DIR"
[[ -O $LABS_DIR && -w $LABS_DIR ]] || fail "$LABS_DIR must be owned and writable by $OWNER"
# Lab files use relative paths, so a lab that is not deployed can move as is.
# sudo, because Containerlab leaves root-owned files inside each lab.
for lab in "${MOVE_LABS[@]}"; do sudo mv -- "${lab%/}" "$LABS_DIR/"; done
printf '%s\n' "$LABS_DIR" | sudo tee "$LABS_DIR_FILE" >/dev/null
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 "$SCRIPT_DIR/clab-mcp-remote" /usr/local/libexec/clab-mcp-remote
sudo install -m 0755 "$SCRIPT_DIR/clab-mcp-admin" /usr/local/libexec/clab-mcp-admin
# Forced command for a lab-dojo-only SSH key; root-owned, so that key cannot change it.
sudo install -m 0755 "$SCRIPT_DIR/clab-mcp-ssh" /usr/local/libexec/clab-mcp-ssh
[[ -e /etc/containerlab-mcp/images ]] || sudo install -m 0644 /dev/null /etc/containerlab-mcp/images

echo "Installed allowlisted Containerlab MCP helper at /usr/local/libexec/clab-mcp-remote"
echo "Built FRR lab image $FRR_IMAGE and host image $HOST_IMAGE"
echo "$CLAB_NOTE"
echo "Recommended: give lab-dojo its own SSH key that can only run the helper. check_setup (/mcp__<server>__init) shows the steps."
echo "Extra images: sudo /usr/local/libexec/clab-mcp-admin add-image <name> <image-ref>"
echo "Labs live in $LABS_DIR (owner: $OWNER)${MOVE_LABS:+; moved ${#MOVE_LABS[@]} lab(s) there from $CURRENT_LABS}"

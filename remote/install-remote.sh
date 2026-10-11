#!/usr/bin/env bash
set -euo pipefail

# Run on the Debian VM as the account that owns Containerlab/Docker access.
# It installs the reviewed helper and the admin script, builds the FRR and host
# images, and creates the lab state directory, owned by that account so
# generated labs can be written without sudo. The list of extra images is owned
# by root: only clab-mcp-admin, run with sudo by a person, changes it.
STATE_ROOT=/var/lib/containerlab-mcp
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OWNER="$(id -un)"

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

sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 "$SCRIPT_DIR/clab-mcp-remote" /usr/local/libexec/clab-mcp-remote
sudo install -m 0755 "$SCRIPT_DIR/clab-mcp-admin" /usr/local/libexec/clab-mcp-admin
sudo install -d -m 0755 -o "$OWNER" -g "$(id -gn)" "$STATE_ROOT" "$STATE_ROOT/labs"
sudo install -d -m 0755 /etc/containerlab-mcp
[[ -e /etc/containerlab-mcp/images ]] || sudo install -m 0644 /dev/null /etc/containerlab-mcp/images

echo "Installed allowlisted Containerlab MCP helper at /usr/local/libexec/clab-mcp-remote"
echo "Built FRR lab image $FRR_IMAGE and host image $HOST_IMAGE"
echo "Extra images: sudo /usr/local/libexec/clab-mcp-admin add-image <name> <image-ref>"
echo "Lab definitions live in $STATE_ROOT/labs (owner: $OWNER)"

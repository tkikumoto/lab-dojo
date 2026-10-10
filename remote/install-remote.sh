#!/usr/bin/env bash
set -euo pipefail

# Run on the Debian VM as the account that owns Containerlab/Docker access.
# It installs the reviewed helper and creates the lab state directory, owned by
# that account so generated labs can be written without sudo.
STATE_ROOT=/var/lib/containerlab-mcp
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OWNER="$(id -un)"

sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 "$SCRIPT_DIR/clab-mcp-remote" /usr/local/libexec/clab-mcp-remote
sudo install -d -m 0755 -o "$OWNER" -g "$(id -gn)" "$STATE_ROOT" "$STATE_ROOT/labs"

echo "Installed allowlisted Containerlab MCP helper at /usr/local/libexec/clab-mcp-remote"
echo "Lab definitions live in $STATE_ROOT/labs (owner: $OWNER)"

#!/usr/bin/env bash
# Table test for check_line in remote/clab-mcp-remote: the filter every router
# configuration line passes before it reaches a privileged container.
# The helper needs bash 4+. macOS ships 3.2, so there this re-runs itself on the
# lab VM, which sees the Mac's files at the same path (OrbStack).
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ((BASH_VERSINFO[0] < 4)); then
  exec ssh -n -T -o BatchMode=yes "${CONTAINERLAB_SSH_TARGET:-containerlab-server@orb}" bash "$(printf %q "$here/check-line.sh")"
fi

source "$here/../remote/clab-mcp-remote"
set +e
fails=0

# expect <allowed|refused> <session|startup>, lines on stdin
expect() {
  local line got
  while IFS= read -r line; do
    got=allowed
    (check_line "$line" "$2") 2>/dev/null || got=refused
    [[ $got == "$1" ]] && continue
    printf 'FAIL (%s): [%s] was %s, expected %s\n' "$2" "$line" "$got" "$1"
    fails=$((fails + 1))
  done
}

expect allowed session <<'EOF'
interface eth1
 shutdown
no shutdown
description to r2 eth1
ip address 10.1.2.1/30
interface Ethernet1/1
network 10.1.2.0/30 area 0.0.0.0
ip route 10.255.0.3/32 Null0
ipv6 route ::/0 2001:db8::1
router bgp 65001
neighbor 10.1.2.2 route-map IMPORT-POLICY in
exit-address-family
ip ospf message-digest-key 1 md5 Lab-Key-7
vrrp 1 ip 10.0.0.254
set metric 5
! a comment

EOF

expect refused session <<'EOF'
do show running-config
end
exit
en
wr
st
ev foo
write memory
copy running-config startup-config
event-handler x
alias x show version
bash id
python-shell
action bash id
hostname shell1
show version | bash id
description x; reload
description a & reboot
description $(id)
description `id`
log file /etc/frr/daemons
dump bgp all /tmp/x
/etc/frr/daemons
EOF

expect allowed startup <<'EOF'
frr defaults traditional
service integrated-vtysh-config
 exit-address-family
exit
end
quit
EOF

expect refused startup <<'EOF'
write memory
do show running-config
log file /etc/frr/daemons
description a & reboot
EOF

if ((fails)); then
  echo "check_line: $fails case(s) failed"
  exit 1
fi
echo "check_line: all cases pass (bash $BASH_VERSION)"

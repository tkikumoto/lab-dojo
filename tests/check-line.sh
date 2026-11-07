#!/usr/bin/env bash
# Table test for check_line in remote/clab-mcp-remote: the filter every router
# configuration line passes before it reaches a privileged container.
# The helper needs bash 4+. macOS ships 3.2, so there this re-runs itself on the
# lab host, which must see this folder at the same path (OrbStack machines do).
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ((BASH_VERSINFO[0] < 4)); then
  : "${CONTAINERLAB_SSH_TARGET:?this test needs bash 4+. Set CONTAINERLAB_SSH_TARGET to rerun it on the lab host, or run it on Linux}"
  exec ssh -n -T -o BatchMode=yes "$CONTAINERLAB_SSH_TARGET" bash "$(printf %q "$here/check-line.sh")"
fi

source "$here/../remote/clab-mcp-remote"
set +e
fails=0

# expect <allowed|refused> <session|startup>, lines on stdin
expect() {
  local line got
  while IFS= read -r line; do
    got=allowed
    if [[ $2 == host ]]; then
      (check_host_line "$line") 2>/dev/null || got=refused
    else
      (check_line "$line" "$2") 2>/dev/null || got=refused
    fi
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

# Host nodes: exact ip/ethtool forms only, never eth0, never a shell.
expect allowed host <<'EOF'
ip link
ip -br link
ip -d link show bond0
ip addr show dev eth1
ip -br -4 addr show eth2.10
ip route
ip neigh show
ethtool eth1
ethtool -S eth2
cat /proc/net/bonding/bond0
ip link add bond0 type bond mode 802.3ad miimon 100 lacp_rate fast xmit_hash_policy layer3+4
ip link set bond0 type bond lacp_rate slow
ip link add link bond0 name bond0.10 type vlan id 10
ip link add dummy0 type dummy
ip link del bond0.10
ip link delete dev dummy0
ip link set eth1 down
ip link set dev eth1 master bond0
ip link set eth2 nomaster up
ip link set bond0 up mtu 9000
ip addr add 10.0.10.100/24 dev bond0
ip address del 2001:db8::1/64 dev bond0.10
ip addr flush dev eth1
ip route replace default via 10.0.10.1
ip route add 10.9.0.0/16 via 10.0.10.1 dev bond0
ip route del 10.9.0.0/16 dev bond0
ip neigh flush dev bond0
EOF

expect refused host <<'EOF'
ip link set eth0 down
ip addr add 10.0.0.1/24 dev eth0
ip route add default via 10.0.0.1 dev eth0
ip link set eth1 netns 1
ip netns exec x sh
ip -batch /tmp/x
ip -force link
ip link set eth1 xdp obj /tmp/x.o
ip link add macv0 link eth1 type macvlan
ip link add br0 type bridge
ip link del eth1
ip link add link eth1 name eth1.10 type vlan id 11
ip link add link eth1 name eth1.5000 type vlan id 5000
ip link add bond0 type bond mode foo
ip link set eth1 mtu 99999
ip link set eth1
ip addr add 10.0.0.300/24 dev bond0
ip route add default
ip -s link set eth1 down
ip link show $(id)
ip link set eth1 down; reboot
ethtool -s eth1 speed 10
cat /etc/shadow
cat /proc/net/bonding/../../../etc/shadow
sh -c id
bash
tcpdump -i eth1
EOF

# clab(): without an installed Containerlab, the pinned image runs, never
# pulled here, with the lab folder at the same path on both sides.
got=$(docker() { printf '%s ' "$@"; }; PATH=/nonexistent; clab version)
for want in "--pull never" "-v $STATE_ROOT:$STATE_ROOT" "$CLAB_IMAGE containerlab version"; do
  [[ $got == *"$want"* ]] && continue
  printf 'FAIL clab(): [%s] missing from: %s\n' "$want" "$got"
  fails=$((fails + 1))
done

if ((fails)); then
  echo "check_line: $fails case(s) failed"
  exit 1
fi
echo "check_line: all cases pass (bash $BASH_VERSION)"

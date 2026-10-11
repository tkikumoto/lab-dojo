# Linux host for lab-dojo labs: Alpine plus the usual network tools.
# install-remote.sh builds it, tagged from HOST_IMAGE in clab-mcp-remote.
# iputils ping and traceroute are needed: the MCP helper runs and parses them.
FROM alpine:3.22

RUN apk add --no-cache \
      bash tini \
      iproute2 iputils net-tools ethtool \
      traceroute mtr tcpdump \
      bind-tools curl iperf3

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]

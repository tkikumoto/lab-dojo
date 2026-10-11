# FRR for lab-dojo: the stock image plus what hands-on labs need.
# install-remote.sh builds it, tagged and versioned from FRR_IMAGE in clab-mcp-remote.
# ping and traceroute stay the stock BusyBox ones; the MCP helper parses them.
ARG FRR_VERSION=10.7.1
FROM quay.io/frrouting/frr:${FRR_VERSION}
# install-remote.sh removes superseded builds by this label.
LABEL org.lab-dojo.image="frr"

RUN apk add --no-cache tcpdump mtr

COPY --chmod=0755 lab-start lab-netdev-sync /usr/local/sbin/

CMD ["/usr/local/sbin/lab-start"]

# Caddy built with the DuckDNS DNS provider so TLS works via the DNS-01 challenge
# (no need to forward port 80; only 443 needs to reach this container).
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

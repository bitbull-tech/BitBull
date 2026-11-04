# Small helper image for the sandbox network:
#   egress  → squid allowlist proxy (the agent's only way out)
#   gateway → socat forwarder publishing the UI on 127.0.0.1 (the agent's network has no ports)
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends squid socat curl \
    && rm -rf /var/lib/apt/lists/*
COPY squid.conf /etc/squid/squid.conf
# Asks BitBob about hosts that aren't on the allowlist (approvals made in the UI)
COPY bitbob-approved.sh /usr/local/bin/bitbob-approved
RUN chmod 755 /usr/local/bin/bitbob-approved
USER proxy
EXPOSE 3128
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]

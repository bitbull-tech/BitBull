# Base images are pinned by digest so two builds of the same source produce the same image.
# To move to a newer base: docker buildx imagetools inspect <image> and take the top "Digest:",
# then update the tag in the FROM line to match (the tag is for humans, the digest is what builds).
# Small helper image for the sandbox network:
#   egress  → squid allowlist proxy (the agent's only way out)
#   gateway → socat forwarder publishing the UI on 127.0.0.1 (the agent's network has no ports)
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends squid socat curl \
    && rm -rf /var/lib/apt/lists/*
COPY squid.conf /etc/squid/squid.conf
# Asks BitBull about hosts that aren't on the allowlist (approvals made in the UI)
COPY bitbull-approved.sh /usr/local/bin/bitbull-approved
RUN chmod 755 /usr/local/bin/bitbull-approved
USER proxy
EXPOSE 3128
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]

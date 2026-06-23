# All-in-one image: SteamCMD + Palworld Linux dedicated server + the Node manager.
# The manager runs as the container's main process and spawns/stops the game
# server process inside this same container (no Docker socket required).
FROM cm2network/steamcmd:root

# Runtime deps: Node 20, procps (pkill for force-kill fallback), and the bits the
# Palworld server expects.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates procps xdg-user-dirs \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Defaults for running inside the container. Secrets/tunables come from the
# environment (docker-compose env_file/environment) at runtime.
ENV PAL_SERVER_EXE=/palworld/PalServer.sh \
    PAL_SERVER_CWD=/palworld \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=8080 \
    REST_API_BASE=http://127.0.0.1:8212 \
    REST_API_USER=admin \
    NODE_ENV=production

# Install the manager app.
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/configure-settings.sh /usr/local/bin/configure-settings.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/configure-settings.sh

# Game install dir (mounted as a named volume in compose so saves persist).
RUN mkdir -p /palworld && chown -R steam:steam /palworld /app

USER steam

# 8080 = web UI (internal, proxied by Caddy); 8211/udp = game traffic;
# 8212 = REST API (internal to this container only — do not publish).
EXPOSE 8080 8211/udp 8212

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

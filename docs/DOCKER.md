# Running in Docker

This runs the whole thing as a container stack:

- **`palworld-manager`** — one image containing SteamCMD, the Linux Palworld
  dedicated server, and the Node manager. The manager starts/stops the game
  process *inside this container* on demand (no Docker socket needed), keeps the
  auto-save/shutdown behaviour, and serves the web UI.
- **`caddy`** — a Caddy build with the DuckDNS plugin that terminates HTTPS and
  reverse-proxies to the manager.

It targets **Docker Desktop on Windows (WSL2)** but the same files work on a
Linux host.

> Why is the game server in the container too? The manager has to be able to
> *start* a stopped server, and the REST API can only talk to a server that's
> already running. So process/container control is required — bundling them in
> one image is the simplest, socket-free way to do that.

## 1. Configure

```powershell
copy .env.docker.example .env
```

Edit `.env`:

- `REST_API_PASSWORD` — becomes the server AdminPassword **and** the manager's
  REST credential (one value keeps them in sync).
- `SESSION_SECRET` — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `ADMIN_PASSWORD_HASH` — generate it inside the image:

  ```powershell
  docker compose run --rm palworld-manager npm run hash-password -- "your web ui password"
  ```

- `DUCKDNS_DOMAIN`, `DUCKDNS_TOKEN`, and `SERVER_NAME`.

Then set your domain in `docker/caddy/Caddyfile` is **not** needed — it reads
`DUCKDNS_DOMAIN` from the environment automatically.

## 2. Build and start

```powershell
docker compose up -d --build
```

This starts **only the manager** — it does **not** publish ports 80/443, so it
coexists with any existing reverse proxy. First boot downloads the Palworld
server via SteamCMD into the `palworld-data` volume (a few GB) — give it a few
minutes. Watch progress with:

```powershell
docker compose logs -f palworld-manager
```

The manager listens on the `palworld-net` Docker network as `palworld-manager:8080`
(not published to the host). Next, put a reverse proxy in front of it.

## 3. HTTPS — pick one

### Option A: use your existing Caddy (recommended if 80/443 are already taken)

Your own Caddy keeps owning 80/443 and just gains the Palworld domain. See
[`docker/external-caddy.Caddyfile`](../docker/external-caddy.Caddyfile) for the
copy-paste block. In short:

```powershell
# 1) let your Caddy reach the manager by name
docker network connect palworld-net <your-caddy-container-name>
# 2) add the site block to your Caddyfile (reverse_proxy palworld-manager:8080),
#    then reload your Caddy
docker exec <your-caddy-container-name> caddy reload --config /etc/caddy/Caddyfile
```

> The `docker network connect` above is one-off and is lost if you recreate your
> Caddy. To make it permanent, add the `palworld-net` external network to your
> Caddy's own `docker-compose.yml` instead — see
> [`docker/external-caddy.compose.yml`](../docker/external-caddy.compose.yml).
> (Bring the manager stack up first so the network exists.)

Your Caddy already has the DuckDNS module + `DUCKDNS_TOKEN` (you use it for your
other domain), and the same DuckDNS token covers this new subdomain. No ports
conflict because only your existing Caddy binds 443.

### Option B: the bundled Caddy (only if nothing else uses 80/443)

```powershell
docker compose --profile bundled-caddy up -d --build
```

Set your subdomain via `DUCKDNS_DOMAIN` in `.env`; the bundled Caddy publishes
443 and proxies to the manager automatically.

## 4. Use it

Reach the UI at `https://<your-subdomain>.duckdns.org` once DNS + the cert are
ready. Log in with your web UI password and use Turn On / Turn Off — the server
only launches when you turn it on, and auto-saves + shuts down after the idle
period.

## Ports

| Port | Published | Purpose |
| --- | --- | --- |
| 8211 (UDP) | yes (manager) | Palworld game traffic — players connect here |
| 443 (TCP/UDP) | only with `--profile bundled-caddy` | HTTPS to the web UI |
| 8080 | no | web UI on `palworld-net`; your proxy reaches it by name |
| 8212 | no | REST API, internal to the manager container only |

Forward **8211/UDP** (for players) and **443** (on whichever proxy owns it) on
your router. Never expose 8212.

## Data, updates, and lifecycle

- **Saves** live in the `palworld-data` named volume and survive
  rebuilds/restarts. Back it up to keep your world.
- **Migrating an existing save:** copy your `…/Pal/Saved/` folder into the
  `palworld-data` volume before first start (Windows and Linux saves are
  compatible). If you bring your own `PalWorldSettings.ini`, the entrypoint only
  *adds* the REST API keys if they're missing; it won't overwrite your settings.
- **Game updates:** with `UPDATE_ON_BOOT=true`, each container start re-validates
  the install via SteamCMD. Set it to `false` to pin the current version.
- **Graceful stop:** `docker stop` / `docker compose down` sends SIGTERM; the
  manager saves and gracefully shuts the running game down before exiting.
  `stop_grace_period` in `docker-compose.yml` (default 3m) gives it time — keep
  it ≥ `STOP_TIMEOUT_SECONDS`.

## Updating the manager itself

```powershell
git pull
docker compose up -d --build
```

The `palworld-data` volume is untouched, so your world is preserved.

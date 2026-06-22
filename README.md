# Palworld Server Manager

A lightweight Node.js manager for a self-hosted **Palworld dedicated server** on
**Windows**. It:

- **Auto-saves and shuts the server down** when nobody has been online for a
  configurable period (default **15 minutes**), so it stops eating resources
  when empty.
- Serves a **password-protected web UI** to manually **turn the server on/off**.
- Shows **live transitional states** — clicking *Turn On* shows
  *"Turning on…"* until the server is actually up, then *"Server is ON"*
  (and the reverse for shutdown). Updates stream in real time via
  Server-Sent Events.
- Talks to the game server over the **Palworld REST API** (localhost only —
  never exposed), which is the supported path now that RCON is deprecated.
- Ships with a **Caddyfile**, a **DuckDNS updater**, and a full setup guide so
  the UI is reachable over **HTTPS** at `https://<you>.duckdns.org`.

## Quick start

```bash
npm install
copy .env.example .env        # then edit .env (see comments inside)
npm run hash-password         # paste the result into .env as ADMIN_PASSWORD_HASH
npm start
```

Open `http://localhost:8080`, log in, and toggle the server.

For the full walkthrough — enabling the Palworld REST API, port forwarding,
DuckDNS, Caddy HTTPS, and running everything on boot — see
[`docs/SETUP.md`](docs/SETUP.md).

## How it works

| Piece | File |
| --- | --- |
| State machine (OFF → STARTING → ON → STOPPING), spawn, graceful stop, auto-shutdown poller | `src/serverManager.js` |
| Palworld REST API client | `src/palApi.js` |
| HTTP API, SSE stream, login/session | `src/httpServer.js` |
| Password hashing (scrypt) + signed session cookies | `src/auth.js` |
| Config loader + validation | `src/config.js` |
| Web UI (no build step) | `public/` |
| Caddy + DuckDNS deploy assets | `deploy/` |

The graceful stop sequence is **announce → save → shutdown countdown → wait for
exit**, with a `taskkill /T /F` fallback only if the server fails to exit in
time. The server data is always saved before the process stops.

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- A Palworld dedicated server with the REST API enabled
  (`RESTAPIEnabled=True`, `RESTAPIPort=8212`, `AdminPassword` set in
  `PalWorldSettings.ini`)

## Security notes

- The web UI requires a password (scrypt-hashed) for start/stop. Status is
  read-only and public so the page can show state.
- The Palworld REST API is plaintext and **must stay bound to localhost** —
  never port-forward 8212.
- Only port 443 (and 80 if you use the HTTP-01 TLS challenge) should be exposed
  through your router to Caddy.

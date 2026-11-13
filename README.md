# Palworld Server Manager

A lightweight Node.js manager for a self-hosted **Palworld dedicated server** on
**Windows**. It:

- **Auto-saves and shuts the server down** when nobody has been online for a
  configurable period (default **15 minutes**), so it stops eating resources
  when empty.
- Serves a **web UI** to manually **turn the server on/off**. Each friend signs
  in with their own **passkey** (fingerprint, face or screen lock), from a
  one-time invite link. An admin password is there for the start.
- Has a **Friends tab** for admins: invite people, remove them, and switch the
  password off once everybody has a passkey.
- Has a **Settings tab** to edit game balance, features, and performance options
  from `PalWorldSettings.ini` (sliders, toggles, dropdowns) — operational keys
  like passwords, ports, and the server name are never exposed. Saving offers a
  one-click **restart** to apply. The auto-shutdown timer is editable there too
  and applies live.
- Shows **live transitional states** — clicking *Turn On* shows
  *"Turning on…"* until the server is actually up, then *"Server is ON"*
  (and the reverse for shutdown). Updates stream in real time via
  Server-Sent Events.
- Talks to the game server over the **Palworld REST API** (localhost only —
  never exposed), which is the supported path now that RCON is deprecated.
- Can **keep the Windows host awake** (block sleep, disable Energy Saver) while
  the game server is running, even when the manager runs in Docker — a small
  host-side agent (`scripts/host-power-agent.ps1`) polls the manager and toggles
  power settings natively. Enable it on the Settings tab. See
  [docs/DOCKER.md](docs/DOCKER.md#keeping-the-windows-host-awake-host-power-agent).
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

### Or run it all in Docker

Prefer containers? A full stack (SteamCMD + Palworld server + manager + Caddy)
is provided:

```bash
cp .env.docker.example .env   # then edit it
docker compose up -d --build
```

This bundles the Linux game server and the manager in one image (so the manager
can start/stop the server without a Docker socket) and starts **manager-only** —
no ports 80/443 — so it coexists with an existing reverse proxy. Point your proxy
at `palworld-manager:8080`, or run the bundled Caddy with
`docker compose --profile bundled-caddy up -d`. See [`docs/DOCKER.md`](docs/DOCKER.md).

## How it works

| Piece | File |
| --- | --- |
| State machine (OFF → STARTING → ON → STOPPING), spawn, graceful stop, auto-shutdown poller | `src/serverManager.js` |
| Palworld REST API client | `src/palApi.js` |
| HTTP API, SSE stream, login/session | `src/httpServer.js` |
| Password hashing (scrypt) + signed session cookies | `src/auth.js` |
| `PalWorldSettings.ini` parser/writer (round-trip safe, atomic, `.bak`) | `src/palSettings.js` |
| Whitelist of UI-editable game settings (types, ranges, defaults) | `src/settingsCatalog.js` |
| Persisted manager overrides (auto-shutdown from the UI) | `src/managerSettings.js` |
| Config loader + validation | `src/config.js` |
| Web UI (no build step) | `public/` |
| Caddy + DuckDNS deploy assets | `deploy/` |

The graceful stop sequence is **announce → save → shutdown countdown → wait for
exit**, with a `taskkill /T /F` fallback only if the server fails to exit in
time. The server data is always saved before the process stops.

## Requirements

- Node.js 22+ (the passkey library needs it)
- A Palworld dedicated server with the REST API enabled
  (`RESTAPIEnabled=True`, `RESTAPIPort=8212`, `AdminPassword` set in
  `PalWorldSettings.ini`)

## Passkeys

Each person signs in with their own passkey. Nobody can make an account on
their own: an admin sends a one-time invite link.

| Who | Can |
|---|---|
| Friend | Turn the server on and off. |
| Admin | Also restart it, change game and manager settings, and use the Friends tab. |
| The admin password | The same as an admin, while password sign-in is on. |

**Move over from the password**

1. Sign in with the admin password.
2. Open **Friends**. Invite yourself, with **Admin** ticked. Open the link on
   your phone and tap **Create passkey**. Repeat with **Link for another
   device** for each of your other devices, or let your phone's passkey sync
   (iCloud Keychain, Google Password Manager) carry it.
3. Invite each friend (without **Admin**). Send each one their own link. A link
   works once, for 7 days. On the link's page, the friend taps
   **Create passkey**, and is signed in.
4. When everybody has a passkey, switch **Allow the admin password** off on the
   Friends tab. Password sessions end at once. The switch refuses while no
   admin has a passkey.

A friend who gets a new phone uses **Add another device** on the Server tab
while signed in, or asks an admin for a link.

**Notes**

- The friends and passkeys are in `passkeys.json` in `MANAGER_DATA_DIR` (the
  game-data volume in Docker). It holds public keys and the hashes of open
  invite links, never a working link. If the file is damaged, the manager
  refuses password sign-in rather than allowing it; move the file aside to start
  again with no passkeys.
- A passkey is tied to the site's address. If the address changes, every
  passkey must be made again. Set `PASSKEY_ORIGIN` to fix the address, or the
  manager uses the address of each request.
- Removing a friend, or one of their passkeys, takes effect at once.
- Sign-in failures (password or passkey) share one limit: 5 per address in
  5 minutes.

**Locked out?** On the machine the manager runs on, make a new admin link:

```bash
npm run passkey-invite -- --admin <name>
# in Docker:
docker compose exec palworld-manager node scripts/passkey-invite.js --admin <name>
```

`--device <name>` makes a link for another device of an existing friend.

## Security notes

- The web UI needs a passkey, or the admin password while it is on, for
  start/stop. Status is read-only and public so the page can show state.
- The Palworld REST API is plaintext and **must stay bound to localhost** —
  never port-forward 8212.
- Only port 443 (and 80 if you use the HTTP-01 TLS challenge) should be exposed
  through your router to Caddy.

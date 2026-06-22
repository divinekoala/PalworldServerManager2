# Setup Guide

End-to-end setup for the Palworld Server Manager on Windows: enabling the
Palworld REST API, running the manager, exposing it over HTTPS with DuckDNS +
Caddy, and making everything survive a reboot.

There are two distinct passwords in this setup — keep them clear in your head:

| Password | Where it lives | What it's for |
| --- | --- | --- |
| **Palworld AdminPassword** | `PalWorldSettings.ini` → `.env` `REST_API_PASSWORD` | The manager authenticating to the game server's REST API |
| **Web UI password** | hashed into `.env` `ADMIN_PASSWORD_HASH` | Logging into the web UI to press On/Off |

---

## 1. Enable the Palworld REST API

The manager controls the server through the REST API. Edit your server's
`PalWorldSettings.ini` (under `…\Pal\Saved\Config\WindowsServer\`) and make sure
the `OptionSettings` line contains:

```
RESTAPIEnabled=True,
RESTAPIPort=8212,
AdminPassword="choose-a-strong-admin-password",
```

Restart the Palworld dedicated server so the changes take effect.

> The REST API is plain HTTP with Basic auth (`admin` / your AdminPassword) and
> is meant for localhost only. **Never** port-forward port 8212.

Verify it's up (from the server machine):

```powershell
curl.exe -u admin:YOUR_ADMIN_PASSWORD http://127.0.0.1:8212/v1/api/info
```

You should get a JSON response with the server name and version.

---

## 2. Install and configure the manager

1. Install [Node.js 18+](https://nodejs.org/).
2. From the project folder:

   ```powershell
   npm install
   copy .env.example .env
   ```

3. Edit `.env`:
   - `PAL_SERVER_EXE` — full path to `PalServer.exe`.
   - `REST_API_PASSWORD` — the AdminPassword you set above.
   - `EMPTY_SHUTDOWN_MINUTES` — leave at `15` (or change).
   - Generate the web UI password hash and paste it in:

     ```powershell
     npm run hash-password
     ```

   - Generate a `SESSION_SECRET`:

     ```powershell
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```

   - Fill in `DUCKDNS_DOMAIN` and `DUCKDNS_TOKEN` (used by the deploy scripts).
   - If you'll test over plain `http://localhost`, set `SECURE_COOKIES=false`
     temporarily. Set it back to `true` once you're behind Caddy/HTTPS.

4. Run it:

   ```powershell
   npm start
   ```

   Open `http://localhost:8080`, log in with your web UI password, and confirm
   *Turn On* / *Turn Off* work and show the transitional states.

---

## 3. Router port forwarding

Forward only what's needed to reach Caddy:

| Port | Forward? | Why |
| --- | --- | --- |
| 443 (TCP) | **Yes** | HTTPS to Caddy |
| 80 (TCP) | Only if using the HTTP-01 TLS challenge (Option B) | ACME cert validation |
| 8211 (UDP) | Only if players connect from the internet | Palworld game traffic (separate from this manager) |
| 8080 / 8212 / RCON | **No** | Manager UI and REST API stay local; Caddy proxies the UI |

---

## 4. DuckDNS

1. Sign in at [duckdns.org](https://www.duckdns.org/), create a subdomain, and
   copy your token.
2. Keep your public IP up to date with the included updater. Test it once:

   ```powershell
   cd deploy
   .\Update-DuckDNS.ps1 -Domain YOURSUBDOMAIN -Token YOUR_TOKEN
   ```

   It should print a line ending in `response=OK` and write `deploy/duckdns.log`.
3. Schedule it every 5 minutes via **Task Scheduler**:
   - Create Task → *Run whether user is logged on or not*, *Run at highest privileges*.
   - Trigger: *At startup* **and** *Repeat every 5 minutes indefinitely*.
   - Action: *Start a program*
     - Program: `powershell.exe`
     - Arguments:
       `-ExecutionPolicy Bypass -File "C:\path\to\deploy\Update-DuckDNS.ps1" -Domain YOURSUBDOMAIN -Token YOUR_TOKEN`

---

## 5. Caddy for HTTPS

1. Get Caddy **with the DuckDNS DNS module** (recommended — no port 80 needed):
   - Easiest: download from <https://caddyserver.com/download>, tick the
     `github.com/caddy-dns/duckdns` provider, and download the custom binary; **or**
   - Build it: `xcaddy build --with github.com/caddy-dns/duckdns`.
2. Edit `deploy/Caddyfile`: replace `YOURDOMAIN` with your DuckDNS subdomain and
   confirm the proxy target port matches `WEB_PORT` (default 8080). The file ships
   with **Option A (DNS-01, recommended)** active and **Option B (HTTP-01)** commented.
3. Provide your DuckDNS token to Caddy via an environment variable and run it:

   ```powershell
   $env:DUCKDNS_TOKEN = "your-duckdns-token"
   caddy run --config deploy\Caddyfile
   ```

4. Browse to `https://YOURSUBDOMAIN.duckdns.org` — Caddy obtains a Let's Encrypt
   certificate automatically. Log in and confirm On/Off work over HTTPS.

> If you'd rather not build a custom Caddy, use **Option B** in the Caddyfile and
> forward **both** ports 80 and 443.

---

## 6. Run on boot (survive reboots)

Run both the manager and Caddy as background services so they restart with the
machine. [NSSM](https://nssm.cc/) is the simplest way on Windows:

```powershell
# Manager
nssm install PalworldManager "C:\Program Files\nodejs\node.exe" "C:\path\to\src\index.js"
nssm set PalworldManager AppDirectory "C:\path\to\project"
nssm start PalworldManager

# Caddy
nssm install Caddy "C:\path\to\caddy.exe" "run --config C:\path\to\deploy\Caddyfile"
nssm set Caddy AppEnvironmentExtra "DUCKDNS_TOKEN=your-duckdns-token"
nssm start Caddy
```

The DuckDNS updater is already handled by the Task Scheduler "at startup" trigger
from Step 4.

Restart the machine and confirm `https://YOURSUBDOMAIN.duckdns.org` comes back up
on its own.

---

## 7. Verifying behaviour

- **Manual toggle:** click *Turn On* → *"Turning on…"* → *"Server is ON"*;
  *Turn Off* → *"Turning off… (saving)"* → *"Server is OFF"*. Confirm your world
  save file's timestamp updates on shutdown (data was saved, not hard-killed).
- **Auto-shutdown:** temporarily set `EMPTY_SHUTDOWN_MINUTES=1` and
  `POLL_INTERVAL_SECONDS=10` in `.env`, start the server, leave it empty, and
  confirm it saves + shuts down. Restore the values afterwards.
- **Auth:** wrong password is rejected (and rate-limited after 5 tries);
  start/stop without logging in returns 401 and the UI prompts for the password.
- **Live updates:** open two browser tabs; a transition triggered in one updates
  both immediately.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Manager exits on start with config problems | Fill the missing `.env` values it lists. |
| UI shows "Server is up but rejected the AdminPassword" | `REST_API_PASSWORD` ≠ `AdminPassword` in `PalWorldSettings.ini`. |
| Stays on "Turning on…" then flips to OFF | Server didn't become reachable within `START_READY_TIMEOUT_SECONDS`; check the exe path/args and that the REST API is enabled. |
| Login works locally but not via HTTPS | Ensure `SECURE_COOKIES=true` and you're using `https://`. |
| Caddy can't get a certificate | Check DuckDNS token/env var (Option A) or that ports 80+443 are forwarded (Option B). |
| Server didn't auto-stop when empty | Confirm the REST API responds to `/v1/api/players`; check the manager logs for poll failures. |

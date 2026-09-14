---
name: update-palworld-server
description: Updates the Palworld dedicated server in this repo by running scripts/update-palworld-server.ps1, and checks the installed build id against Steam. Use this whenever the user mentions updating, patching, or upgrading the Palworld server, says "Palworld updated" / "there's a new update" / "new patch is out", asks what version or build the server is on, asks whether an update is available, or reports post-update problems like a version mismatch keeping players from connecting. Use it even if they don't name the script — do NOT hand-roll docker/steamcmd commands for this, the script already handles the safety checks.
---

# Updating the Palworld dedicated server

The container's entrypoint runs `steamcmd +app_update 2394010 validate` on every
boot (`UPDATE_ON_BOOT=true` in `.env`), so **updating the game means restarting
the `palworld-manager` container**. There is no separate update command, and the
image does *not* need rebuilding for a game update — a rebuild only matters when
manager code in `src/` changed.

`scripts/update-palworld-server.ps1` wraps that restart with the checks that make
it safe to run unattended. Prefer it over issuing docker commands yourself: it
already handles the graceful save, the "are players connected" guard, and the
failure modes below.

## Decide which mode to run

Read the user's intent before running anything, because one mode changes nothing
and the other disconnects players.

**Version question only** — "what build are we on?", "is there an update?",
"did the server update go through?". Run the read-only check:

```bash
powershell -ExecutionPolicy Bypass -File scripts\update-palworld-server.ps1 -Check
```

It prints the installed build id and the live one from Steam, then exits without
touching the container.

**Actually apply the update** — "update the server", "grab the new patch":

```bash
powershell -ExecutionPolicy Bypass -File scripts\update-palworld-server.ps1
```

This stops the container (SIGTERM → the manager saves the world and shuts the
game down), starts it again, streams the SteamCMD log, and reports the
before → after build id. It takes roughly 5 minutes because `validate`
re-hashes the whole 5 GB install.

Add `-Force` to skip the interactive "players will be disconnected" prompt. Only
do that when you have confirmed with the user that kicking players is fine, or
when the check has already shown the game process isn't running — the prompt is
the one thing standing between a running session and a disconnect. `-TimeoutMinutes N`
raises the 30-minute cap if SteamCMD is downloading a large patch on a slow line.

## Reporting the result

Say plainly whether the build id actually moved. "Install validated. Build X
(unchanged)" means Steam had nothing new — that is a real and useful answer, not
a failure, and it's worth stating rather than implying an update landed.

A common source of confusion: Pocketpair sometimes ships the **client** (appid
1623730) before the **dedicated server** (appid 2394010). So the user can
genuinely see "Palworld updated" in their Steam library while `-Check` correctly
reports the server already current. When the ids match but the user is certain
something changed, explain that split rather than re-running the update.

The manager does not auto-start the game after a restart. Tell the user to start
it from the web UI (https://palworldorsomething.duckdns.org) when they're ready.

## When it fails

The script prints the relevant recovery command, but for context:

- **`state is 0x6` / "Missing configuration"** — SteamCMD's download cache is
  wedged. Clear it and re-run:
  ```bash
  docker exec palworld-manager bash -c 'rm -rf /palworld/steamapps/downloading /palworld/steamapps/temp'
  ```
  The entrypoint also retries once on its own, so this only comes up when both
  attempts failed.
- **Container won't stay up** — check `docker logs palworld-manager`. If a
  playable install already exists on disk, the entrypoint deliberately boots the
  manager anyway with an "update failed twice" warning rather than crash-looping,
  so the UI stays reachable.
- **Proxy or TLS looks broken afterwards** — that isn't this repo. The manager
  sits behind the chat-server's Caddy (`chat-server-caddy-1`), which owns 80/443.
  Never start the bundled `--profile bundled-caddy` on this machine; two Caddys
  can't both bind 443.

## Editing the script

Three PowerShell-specific traps are already fixed in there, each with a comment
explaining why. If you refactor it, don't reintroduce them:

- Native-command args go through as **one array** (`Invoke-Compose @('up','-d',...)`).
  With `ValueFromRemainingArguments`, PowerShell's binder eats `-d` before docker
  sees it, silently turning `up -d` into an attached `up` that hangs the script.
- `docker logs` stderr is merged **inside a child scope** where
  `$ErrorActionPreference` is `Continue`. Merging with `2>&1` under `Stop` throws
  `NativeCommandError` on the first SteamCMD stderr line.
- The process check uses `pgrep -f '[P]alServer'`. Without the brackets, pgrep
  matches the command line of the shell running it and always reports the game as
  running.

Keep the file ASCII-only. Windows PowerShell 5.1 reads UTF-8-without-BOM as ANSI,
and a stray em dash turns into a parser error.

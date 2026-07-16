import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cookie from 'cookie';
import { verifyPassword, createSession, verifySession } from './auth.js';
import {
  readSettings,
  serialize,
  setEntry,
  rawToTyped,
  typedToRaw,
  writeSettingsFile,
} from './palSettings.js';
import { CATALOG, CATALOG_MAP, CATEGORIES, EXCLUDED_KEYS, validateValue } from './settingsCatalog.js';
import { loadOverrides, saveOverrides, applyOverrides } from './managerSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'psm_session';

// Simple in-memory login rate limiter: max attempts per IP per window.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

export function createHttpServer(config, manager) {
  const app = express();
  app.set('trust proxy', 1); // behind Caddy
  app.use(express.json());

  const loginAttempts = new Map(); // ip -> { count, resetAt }

  function isAuthed(req) {
    const cookies = cookie.parse(req.headers.cookie || '');
    return verifySession(cookies[SESSION_COOKIE], config.auth.sessionSecret);
  }

  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'authentication required' });
  }

  // ── Read-only status ───────────────────────────────────────────────────────
  app.get('/api/status', (req, res) => {
    res.json({ ...manager.getStatus(), authed: isAuthed(req) });
  });

  app.get('/api/me', (req, res) => {
    res.json({ authenticated: isAuthed(req) });
  });

  // Polled by scripts/host-power-agent.ps1 on the Windows host (loopback only —
  // see the 127.0.0.1 port mapping in docker-compose.yml). Read-only, no auth,
  // same as /api/status. keepAwake covers STARTING too so the host can't doze
  // off mid-boot.
  app.get('/api/host-power', (req, res) => {
    const running = manager.state === 'ON' || manager.state === 'STARTING';
    res.json({
      enabled: config.hostPower.enabled,
      serverState: manager.state,
      keepAwake: config.hostPower.enabled && running,
    });
  });

  // ── Server-Sent Events: live state stream ──────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    const send = (status) => res.write(`data: ${JSON.stringify(status)}\n\n`);
    send(manager.getStatus()); // initial state

    const onChange = (status) => send(status);
    manager.on('change', onChange);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      manager.off('change', onChange);
    });
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let rec = loginAttempts.get(ip);
    if (rec && now > rec.resetAt) rec = undefined;
    if (rec && rec.count >= LOGIN_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }

    const password = req.body?.password ?? '';
    if (verifyPassword(password, config.auth.passwordHash)) {
      loginAttempts.delete(ip);
      const token = createSession(config.auth.sessionSecret, config.auth.sessionTtlHours);
      res.setHeader(
        'Set-Cookie',
        cookie.serialize(SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: config.web.secureCookies,
          path: '/',
          maxAge: config.auth.sessionTtlHours * 3600,
        })
      );
      return res.json({ ok: true });
    }

    rec = rec || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    rec.count += 1;
    loginAttempts.set(ip, rec);
    res.status(401).json({ error: 'invalid password' });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader(
      'Set-Cookie',
      cookie.serialize(SESSION_COOKIE, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.web.secureCookies,
        path: '/',
        maxAge: 0,
      })
    );
    res.json({ ok: true });
  });

  // ── Mutating controls (auth required) ───────────────────────────────────────
  app.post('/api/start', requireAuth, (req, res) => {
    const result = manager.start();
    res.status(result.accepted ? 202 : 409).json(result);
  });

  app.post('/api/stop', requireAuth, (req, res) => {
    const result = manager.stop('manual-stop');
    res.status(result.accepted ? 202 : 409).json(result);
  });

  app.post('/api/restart', requireAuth, (req, res) => {
    const result = manager.restart();
    res.status(result.accepted ? 202 : 409).json(result);
  });

  // ── Game settings (PalWorldSettings.ini) ────────────────────────────────────
  const catalogDefaults = () => CATALOG.map((e) => [e.key, typedToRaw(e.default, e.type)]);

  app.get('/api/settings', requireAuth, (req, res) => {
    try {
      const { parsed, fileExists } = readSettings(config, catalogDefaults());
      const values = {};
      for (const entry of CATALOG) {
        const raw = parsed.entries.get(entry.key);
        const typed = raw === undefined ? null : rawToTyped(raw, entry.type);
        values[entry.key] = typed === null ? entry.default : typed;
      }
      res.json({
        catalog: CATALOG,
        categories: CATEGORIES,
        values,
        fileExists,
        serverState: manager.state,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to read settings: ${err.message}` });
    }
  });

  app.put('/api/settings', requireAuth, (req, res) => {
    if (manager.state === 'STARTING' || manager.state === 'STOPPING') {
      return res
        .status(409)
        .json({ error: `Cannot save settings while the server is ${manager.state}` });
    }
    const incoming = req.body?.values;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'Body must be { values: { Key: value, ... } }' });
    }

    // Whitelist + validate every incoming key before touching the file.
    const errors = {};
    for (const [key, value] of Object.entries(incoming)) {
      const entry = CATALOG_MAP.get(key);
      if (!entry || EXCLUDED_KEYS.has(key)) {
        errors[key] = 'not an editable setting';
        continue;
      }
      const problem = validateValue(entry, value);
      if (problem) errors[key] = problem;
    }
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    try {
      const { parsed, path: filePath } = readSettings(config, catalogDefaults());
      for (const [key, value] of Object.entries(incoming)) {
        setEntry(parsed, key, typedToRaw(value, CATALOG_MAP.get(key).type));
      }
      writeSettingsFile(filePath, serialize(parsed));
      res.json({ ok: true, restartRequired: manager.state === 'ON' });
    } catch (err) {
      res.status(500).json({ error: `Failed to write settings: ${err.message}` });
    }
  });

  // ── Manager settings (auto-shutdown, host power) ────────────────────────────
  app.get('/api/manager-settings', requireAuth, (req, res) => {
    res.json({
      autoShutdown: {
        enabled: config.autoShutdown.enabled,
        emptyMinutes: config.autoShutdown.emptyMinutes,
      },
      hostPower: {
        enabled: config.hostPower.enabled,
      },
    });
  });

  app.put('/api/manager-settings', requireAuth, (req, res) => {
    const as = req.body?.autoShutdown;
    const hp = req.body?.hostPower;
    if (!as || typeof as !== 'object' || !hp || typeof hp !== 'object') {
      return res
        .status(400)
        .json({ error: 'Body must be { autoShutdown: { ... }, hostPower: { ... } }' });
    }
    const errors = {};
    if (typeof as.enabled !== 'boolean') errors.enabled = 'must be true or false';
    if (typeof as.emptyMinutes !== 'number' || !(as.emptyMinutes > 0) || as.emptyMinutes > 1440) {
      errors.emptyMinutes = 'must be a number between 0 and 1440';
    }
    if (typeof hp.enabled !== 'boolean') errors.hostPowerEnabled = 'must be true or false';
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    try {
      const overrides = {
        ...loadOverrides(),
        autoShutdown: { enabled: as.enabled, emptyMinutes: as.emptyMinutes },
        hostPower: { enabled: hp.enabled },
      };
      saveOverrides(overrides);
      applyOverrides(config, overrides); // live — polling reads config each tick
      res.json({ ok: true, autoShutdown: overrides.autoShutdown, hostPower: overrides.hostPower });
    } catch (err) {
      res.status(500).json({ error: `Failed to save manager settings: ${err.message}` });
    }
  });

  // ── Static frontend ──────────────────────────────────────────────────────────
  app.use(express.static(PUBLIC_DIR));

  return app;
}

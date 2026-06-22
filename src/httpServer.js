import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cookie from 'cookie';
import { verifyPassword, createSession, verifySession } from './auth.js';

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

  // ── Static frontend ──────────────────────────────────────────────────────────
  app.use(express.static(PUBLIC_DIR));

  return app;
}

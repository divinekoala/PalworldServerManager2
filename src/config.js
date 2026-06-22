import 'dotenv/config';
import path from 'node:path';

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Config ${name} must be an integer, got "${v}"`);
  return n;
}

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Config ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const palServerExe = str('PAL_SERVER_EXE', '');
const palServerCwd = str('PAL_SERVER_CWD', '') || (palServerExe ? path.dirname(palServerExe) : '');

export const config = {
  web: {
    host: str('WEB_HOST', '127.0.0.1'),
    port: int('WEB_PORT', 8080),
    secureCookies: bool('SECURE_COOKIES', true),
  },
  process: {
    exe: palServerExe,
    cwd: palServerCwd,
    // Split on whitespace, dropping empty tokens.
    args: str('PAL_SERVER_ARGS', '').split(/\s+/).filter(Boolean),
  },
  rest: {
    base: str('REST_API_BASE', 'http://127.0.0.1:8212').replace(/\/+$/, ''),
    user: str('REST_API_USER', 'admin'),
    password: str('REST_API_PASSWORD', ''),
  },
  autoShutdown: {
    // Allow fractional minutes (e.g. 0.05) for testing.
    emptyMinutes: num('EMPTY_SHUTDOWN_MINUTES', 15),
    pollSeconds: num('POLL_INTERVAL_SECONDS', 60),
  },
  timeouts: {
    startReadySeconds: num('START_READY_TIMEOUT_SECONDS', 180),
    stopSeconds: num('STOP_TIMEOUT_SECONDS', 120),
    shutdownGraceSeconds: num('SHUTDOWN_GRACE_SECONDS', 10),
  },
  auth: {
    passwordHash: str('ADMIN_PASSWORD_HASH', ''),
    sessionSecret: str('SESSION_SECRET', ''),
    sessionTtlHours: num('SESSION_TTL_HOURS', 24),
  },
  duckdns: {
    domain: str('DUCKDNS_DOMAIN', ''),
    token: str('DUCKDNS_TOKEN', ''),
  },
};

/**
 * Validate the config needed to actually run. Returns an array of human-readable
 * problems (empty array means OK).
 */
export function validateConfig(c = config) {
  const problems = [];
  if (!c.process.exe) problems.push('PAL_SERVER_EXE is not set (path to PalServer.exe).');
  if (!c.rest.password) problems.push('REST_API_PASSWORD is not set (your Palworld AdminPassword).');
  if (!c.auth.passwordHash) {
    problems.push('ADMIN_PASSWORD_HASH is not set. Generate one with: npm run hash-password');
  }
  if (!c.auth.sessionSecret) {
    problems.push('SESSION_SECRET is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  }
  return problems;
}

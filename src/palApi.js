/**
 * Thin client for the Palworld dedicated server REST API.
 *
 * The REST API is plain HTTP with Basic auth (user "admin", password =
 * AdminPassword) and is intended to be reachable only on localhost. Enable it
 * in PalWorldSettings.ini with RESTAPIEnabled=True and RESTAPIPort=8212.
 *
 * Docs: https://docs.palworldgame.com/api/rest-api/palwold-rest-api/
 *
 * This module is the only place that knows how to talk to the game server, so
 * swapping to a different control transport later means changing only this file.
 */

// Raised when the API replies with HTTP 401 — i.e. wrong AdminPassword. Callers
// use this to fail fast instead of retrying forever during startup.
export class PalAuthError extends Error {
  constructor(message = 'Palworld REST API rejected credentials (401)') {
    super(message);
    this.name = 'PalAuthError';
  }
}

export function createPalApi({ base, user, password, timeoutMs = 5000 }) {
  const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: authHeader,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 401) throw new PalAuthError();
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Palworld API ${method} ${path} failed: ${res.status} ${text}`.trim());
      }
      // Some endpoints (save/announce/shutdown) return empty bodies.
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** GET /v1/api/info — also used as a readiness probe. */
    info: () => request('GET', '/v1/api/info'),

    /** GET /v1/api/metrics — uptime / fps / player count snapshot. */
    metrics: () => request('GET', '/v1/api/metrics'),

    /** GET /v1/api/players — returns { count, names } */
    async players() {
      const data = await request('GET', '/v1/api/players');
      const list = Array.isArray(data?.players) ? data.players : [];
      return {
        count: list.length,
        names: list.map((p) => p?.name).filter(Boolean),
      };
    },

    /** POST /v1/api/save — flush world to disk. */
    save: () => request('POST', '/v1/api/save'),

    /** POST /v1/api/announce — broadcast a message to all players. */
    announce: (message) => request('POST', '/v1/api/announce', { message }),

    /** POST /v1/api/shutdown — graceful shutdown after a countdown. */
    shutdown: (waittime, message) =>
      request('POST', '/v1/api/shutdown', { waittime, message }),

    /** POST /v1/api/stop — immediate stop. */
    stop: () => request('POST', '/v1/api/stop'),
  };
}

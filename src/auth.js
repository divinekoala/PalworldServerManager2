import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

/**
 * Hash a plaintext password with scrypt. Returns a self-describing string:
 *   scrypt:<saltHex>:<hashHex>
 *
 * The ":" separator (not "$") is deliberate: a "$" in a value gets interpreted
 * by docker-compose env interpolation and would corrupt the hash in a container.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored "scrypt:salt:hash" string.
 * Constant-time comparison; never throws on malformed input (returns false).
 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split(':');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Create a stateless signed session token: "<payloadB64>.<hmacB64>".
 * The payload carries an expiry timestamp, so no server-side store is needed.
 */
export function createSession(secret, ttlHours) {
  const payload = { exp: Date.now() + ttlHours * 3600 * 1000 };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

/**
 * Verify a session token. Returns true only if the signature is valid and the
 * token has not expired.
 */
export function verifySession(token, secret) {
  try {
    if (!token || typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
    const actual = Buffer.from(sigB64, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) {
      return false;
    }
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

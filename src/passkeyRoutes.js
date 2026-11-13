import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { StoreError, newUserId } from './passkeyStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_BUNDLE = path.join(
  __dirname, '..', 'node_modules', '@simplewebauthn', 'browser', 'dist', 'bundle', 'index.umd.min.js'
);

/** One sign-in or sign-up attempt: its challenge, valid once, for five minutes. */
const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_FLOWS = 500;

const STORE_STATUS = {
  'bad-name': 400,
  'not-found': 404,
  'name-taken': 409,
  duplicate: 409,
  'last-admin': 409,
  'no-admin-passkey': 409,
  'invite-gone': 410,
  unreadable: 500,
};

function sendStoreError(res, err) {
  if (err instanceof StoreError) {
    return res.status(STORE_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code });
  }
  throw err;
}

const INVITE_GONE = 'This invite link has expired or was used already. Ask for a new one.';

/**
 * Passkey sign-in (WebAuthn). Friends sign up only through a one-time invite
 * link, so nobody can make an account on their own.
 */
export function registerPasskeyRoutes(app, deps) {
  const { config, passkeys, limiter, requireAuth, requireAdmin, startSession } = deps;
  const flows = new Map();

  // The address the passkey is tied to. A fixed PASSKEY_ORIGIN wins; else the
  // address this request came to (Caddy passes the host and the scheme).
  function target(req) {
    if (config.passkeys?.origin) {
      return { origin: config.passkeys.origin, rpID: new URL(config.passkeys.origin).hostname };
    }
    return { origin: `${req.protocol}://${req.get('host')}`, rpID: req.hostname };
  }

  function startFlow(flow) {
    const now = Date.now();
    for (const [id, f] of flows) if (f.expiresAt <= now) flows.delete(id);
    while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value);
    const id = crypto.randomBytes(18).toString('base64url');
    flows.set(id, { ...flow, expiresAt: now + FLOW_TTL_MS });
    return id;
  }

  function takeFlow(id, kind) {
    const flow = flows.get(String(id ?? ''));
    flows.delete(String(id ?? ''));
    return flow && flow.kind === kind && flow.expiresAt > Date.now() ? flow : null;
  }

  function tooMany(req, res) {
    if (!limiter.blocked(req.ip)) return false;
    res.status(429).json({ error: 'Too many failed tries. Wait a few minutes.' });
    return true;
  }

  const role = (user) => (user.admin ? 'admin' : 'friend');

  // The browser half of @simplewebauthn, from the installed package.
  app.get('/vendor/simplewebauthn-browser.js', (req, res) => {
    res.type('application/javascript').sendFile(BROWSER_BUNDLE);
  });

  // ── Sign-up through an invite ───────────────────────────────────────────────
  app.get('/api/passkeys/invite', (req, res) => {
    if (tooMany(req, res)) return;
    try {
      const invite = passkeys.findInvite(req.query.invite);
      if (!invite) {
        limiter.fail(req.ip);
        return res.status(404).json({ error: INVITE_GONE });
      }
      res.json({
        name: invite.name,
        admin: invite.admin,
        forExistingFriend: Boolean(invite.userId),
        expiresAt: invite.expiresAt,
      });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post('/api/passkeys/register/options', async (req, res) => {
    if (tooMany(req, res)) return;
    try {
      const invite = passkeys.findInvite(req.body?.invite);
      if (!invite) {
        limiter.fail(req.ip);
        return res.status(404).json({ error: INVITE_GONE });
      }
      const existing = invite.userId ? passkeys.getUser(invite.userId) : null;
      const userId = existing?.id ?? newUserId();
      const { origin, rpID } = target(req);
      const options = await generateRegistrationOptions({
        rpName: 'Palworld Server Manager',
        rpID,
        userName: invite.name,
        userDisplayName: invite.name,
        userID: Buffer.from(userId, 'base64url'),
        attestationType: 'none',
        excludeCredentials: (existing?.credentials ?? []).map((c) => ({ id: c.id, transports: c.transports })),
        // A passkey proper: stored on the device (no user name to type) and
        // unlocked with a fingerprint, face or PIN.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const flowId = startFlow({ kind: 'register', challenge: options.challenge, inviteHash: invite.hash, userId, origin, rpID });
      res.json({ flowId, options });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post('/api/passkeys/register/verify', async (req, res) => {
    const flow = takeFlow(req.body?.flowId, 'register');
    if (!flow) return res.status(400).json({ error: 'That took too long. Start again.' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: flow.origin,
        expectedRPID: flow.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      limiter.fail(req.ip);
      return res.status(400).json({ error: `The passkey was not accepted: ${err.message}` });
    }
    if (!verification.verified) {
      limiter.fail(req.ip);
      return res.status(400).json({ error: 'The passkey was not accepted.' });
    }
    const { credential, credentialBackedUp } = verification.registrationInfo;
    try {
      const user = passkeys.redeemInvite(flow.inviteHash, {
        newUserId: flow.userId,
        deviceName: req.body?.deviceName,
        credential: {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: credential.transports ?? [],
          backedUp: credentialBackedUp,
        },
      });
      startSession(res, user.id);
      res.json({ ok: true, name: user.name, role: role(user) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  // ── Sign-in ─────────────────────────────────────────────────────────────────
  app.post('/api/passkeys/login/options', async (req, res) => {
    if (tooMany(req, res)) return;
    const { origin, rpID } = target(req);
    // No allowCredentials: the device offers the passkeys it has for this site.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const flowId = startFlow({ kind: 'login', challenge: options.challenge, origin, rpID });
    res.json({ flowId, options });
  });

  app.post('/api/passkeys/login/verify', async (req, res) => {
    if (tooMany(req, res)) return;
    const flow = takeFlow(req.body?.flowId, 'login');
    if (!flow) return res.status(400).json({ error: 'That took too long. Start again.' });
    try {
      const found = passkeys.findCredential(String(req.body?.response?.id ?? ''));
      if (!found) {
        limiter.fail(req.ip);
        return res.status(401).json({ error: 'This passkey is not known here. It may have been removed.' });
      }
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: req.body.response,
          expectedChallenge: flow.challenge,
          expectedOrigin: flow.origin,
          expectedRPID: flow.rpID,
          requireUserVerification: true,
          credential: {
            id: found.credential.id,
            publicKey: Buffer.from(found.credential.publicKey, 'base64url'),
            counter: found.credential.counter,
            transports: found.credential.transports,
          },
        });
      } catch (err) {
        limiter.fail(req.ip);
        return res.status(401).json({ error: `Sign-in failed: ${err.message}` });
      }
      if (!verification.verified) {
        limiter.fail(req.ip);
        return res.status(401).json({ error: 'Sign-in failed.' });
      }
      passkeys.touchCredential(found.credential.id, verification.authenticationInfo.newCounter);
      limiter.clear(req.ip);
      startSession(res, found.user.id);
      res.json({ ok: true, name: found.user.name, role: role(found.user) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  // ── Another device for yourself ─────────────────────────────────────────────
  app.post('/api/me/invite', requireAuth, (req, res) => {
    if (!req.who.passkey) {
      return res.status(400).json({ error: 'Sign in with a passkey first. A password session has no friend to add a device to.' });
    }
    try {
      const { token, invite } = passkeys.createInvite({ userId: req.who.uid, createdBy: req.who.name });
      res.status(201).json({ token, expiresAt: invite.expiresAt });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  // ── Friends, for admins ─────────────────────────────────────────────────────
  app.get('/api/friends', requireAdmin, (req, res) => {
    try {
      res.json({
        ...passkeys.overview(),
        passwordConfigured: Boolean(config.auth.passwordHash),
        you: req.who.uid,
      });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post('/api/invites', requireAdmin, (req, res) => {
    try {
      const body = req.body ?? {};
      const { token, invite } = passkeys.createInvite({
        name: body.name,
        admin: body.admin === true,
        userId: typeof body.userId === 'string' ? body.userId : null,
        createdBy: req.who.name,
      });
      res.status(201).json({ token, invite: { id: invite.id, name: invite.name, admin: invite.admin, expiresAt: invite.expiresAt } });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.delete('/api/invites/:id', requireAdmin, (req, res) => {
    try {
      passkeys.revokeInvite(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.delete('/api/friends/:id', requireAdmin, (req, res) => {
    try {
      passkeys.removeUser(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.delete('/api/friends/:id/passkeys/:credentialId', requireAdmin, (req, res) => {
    try {
      passkeys.removeCredential(req.params.id, req.params.credentialId);
      res.json({ ok: true });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.put('/api/password-login', requireAdmin, (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Body must be { enabled: true or false }' });
    if (enabled && !config.auth.passwordHash) {
      return res.status(409).json({ error: 'ADMIN_PASSWORD_HASH is not set, so there is no password to turn on.' });
    }
    try {
      res.json({ ok: true, passwordLogin: passkeys.setPasswordLogin(enabled) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });
}

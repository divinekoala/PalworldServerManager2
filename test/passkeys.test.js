import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PasskeyStore, INVITE_TTL_MS } from '../src/passkeyStore.js';
import { createHttpServer } from '../src/httpServer.js';
import { hashPassword, createSession } from '../src/auth.js';

// ── A software passkey, so the real WebAuthn checks run without a browser ────

function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  };
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

class SoftPasskey {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: 'jwk' });
    this.id = crypto.randomBytes(16);
    this.counter = 0;
    this.userHandle = null;
  }

  authData(rpID, flags, attested) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpID), Buffer.from([flags]), counter, attested ?? Buffer.alloc(0)]);
  }

  create(options, origin) {
    this.userHandle = options.user.id;
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.id, cose]);
    // Flags: user present, user verified, attested credential data.
    const authData = this.authData(options.rp.id, 0x45, attested);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
        transports: ['internal'],
      },
    };
  }

  get(options, origin) {
    this.counter += 1;
    const authData = this.authData(options.rpId, 0x05);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
    };
  }
}

// ── The store on its own ──────────────────────────────────────────────────────

const credential = (id = crypto.randomBytes(8).toString('base64url')) => ({ id, publicKey: 'cGs', counter: 0, transports: [] });

describe('passkey store', () => {
  let dir;
  let clock;
  let store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psm-passkeys-'));
    clock = { now: 1_800_000_000_000 };
    store = new PasskeyStore(path.join(dir, 'passkeys.json'), { now: () => clock.now });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const join = (name, opts = {}) => {
    const { invite } = store.createInvite({ name, ...opts });
    return store.redeemInvite(invite.hash, { newUserId: `u-${name}`, credential: credential(), deviceName: 'Phone' });
  };

  test('an invite works once, and only for 7 days', () => {
    const { token, invite } = store.createInvite({ name: 'Ann' });
    assert.equal(store.findInvite(token)?.name, 'Ann');
    assert.equal(store.findInvite('not-the-token'), null);
    clock.now += INVITE_TTL_MS;
    assert.equal(store.findInvite(token), null);
    clock.now -= 1;
    store.redeemInvite(invite.hash, { newUserId: 'u1', credential: credential(), deviceName: 'Phone' });
    assert.equal(store.findInvite(token), null);
    assert.throws(
      () => store.redeemInvite(invite.hash, { newUserId: 'u2', credential: credential() }),
      { code: 'invite-gone' }
    );
  });

  test('keeps only a hash of the link', () => {
    const { token } = store.createInvite({ name: 'Ann' });
    assert.ok(!fs.readFileSync(store.file, 'utf8').includes(token));
  });

  test('a name is taken by a friend or by an open invite, in any case', () => {
    join('Ann');
    assert.throws(() => store.createInvite({ name: 'ann' }), { code: 'name-taken' });
    store.createInvite({ name: 'Bo' });
    assert.throws(() => store.createInvite({ name: ' BO ' }), { code: 'name-taken' });
    assert.throws(() => store.createInvite({ name: '   ' }), { code: 'bad-name' });
  });

  test('another-device invites add a passkey to the same friend', () => {
    const ann = join('Ann');
    const { invite } = store.createInvite({ userId: ann.id });
    store.redeemInvite(invite.hash, { newUserId: 'ignored', credential: credential(), deviceName: 'Laptop' });
    assert.equal(store.getUser(ann.id).credentials.length, 2);
    assert.equal(store.read().users.length, 1);
  });

  test('password sign-in goes off only when an admin has a passkey', () => {
    assert.throws(() => store.setPasswordLogin(false), { code: 'no-admin-passkey' });
    join('Friend');
    assert.throws(() => store.setPasswordLogin(false), { code: 'no-admin-passkey' });
    join('Owner', { admin: true });
    assert.equal(store.setPasswordLogin(false), false);
    assert.equal(store.passwordLoginEnabled(), false);
  });

  test('with the password off, the last admin passkey cannot be removed', () => {
    const owner = join('Owner', { admin: true });
    store.setPasswordLogin(false);
    assert.throws(() => store.removeUser(owner.id), { code: 'last-admin' });
    assert.throws(() => store.removeCredential(owner.id, owner.credentials[0].id), { code: 'last-admin' });
    const second = join('Second', { admin: true });
    store.removeUser(owner.id);
    assert.deepEqual(store.read().users.map((u) => u.id), [second.id]);
  });

  test('a damaged file is an error, and is left as it was', () => {
    fs.writeFileSync(store.file, '{ not json');
    assert.throws(() => store.read(), { code: 'unreadable' });
    assert.throws(() => store.createInvite({ name: 'Ann' }), { code: 'unreadable' });
    assert.equal(fs.readFileSync(store.file, 'utf8'), '{ not json');
  });

  test('the overview holds no keys or link hashes', () => {
    join('Ann');
    store.createInvite({ name: 'Bo' });
    const text = JSON.stringify(store.overview());
    assert.ok(!text.includes('publicKey') && !text.includes('hash'));
  });
});

// ── The HTTP routes, with real WebAuthn checks ───────────────────────────────

describe('passkey sign-in over HTTP', () => {
  let dir;
  let server;
  let base;
  let store;
  let config;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psm-http-'));
    store = new PasskeyStore(path.join(dir, 'passkeys.json'));
    const manager = Object.assign(new EventEmitter(), {
      state: 'OFF',
      getStatus() { return { state: this.state, players: 0 }; },
      start() { return { accepted: true }; },
      stop() { return { accepted: true }; },
      restart() { return { accepted: true }; },
    });
    config = {
      auth: { passwordHash: hashPassword('pw'), sessionSecret: 's'.repeat(48), sessionTtlHours: 1 },
      web: { secureCookies: false },
      passkeys: { origin: '' },
      autoShutdown: { enabled: true, emptyMinutes: 15 },
      hostPower: { enabled: false },
    };
    server = createHttpServer(config, manager, { passkeys: store }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://localhost:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, { body, cookie, headers } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie?.split(';')[0] };
  };

  const passwordSession = async () => (await call('POST', '/api/login', { body: { password: 'pw' } })).cookie;

  async function invite(admin, body) {
    const res = await call('POST', '/api/invites', { body, cookie: admin });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.token;
  }

  async function register(token, passkey, { origin = base, deviceName = 'Phone' } = {}) {
    const start = await call('POST', '/api/passkeys/register/options', { body: { invite: token } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    return call('POST', '/api/passkeys/register/verify', {
      body: { flowId: start.body.flowId, response: passkey.create(start.body.options, origin), deviceName },
    });
  }

  async function signIn(passkey) {
    const start = await call('POST', '/api/passkeys/login/options', { body: {} });
    return call('POST', '/api/passkeys/login/verify', {
      body: { flowId: start.body.flowId, response: passkey.get(start.body.options, base) },
    });
  }

  test('a friend joins by invite, then may turn the server on and off and nothing else', async () => {
    const admin = await passwordSession();
    const token = await invite(admin, { name: 'Ann' });
    assert.deepEqual((await call('GET', `/api/passkeys/invite?invite=${token}`)).body.name, 'Ann');

    const joined = await register(token, new SoftPasskey());
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual(joined.body, { ok: true, name: 'Ann', role: 'friend' });
    const ann = joined.cookie;

    assert.equal((await call('GET', '/api/me', { cookie: ann })).body.role, 'friend');
    assert.equal((await call('POST', '/api/start', { cookie: ann })).status, 202);
    assert.equal((await call('POST', '/api/stop', { cookie: ann })).status, 202);
    for (const [method, url] of [['POST', '/api/restart'], ['GET', '/api/settings'], ['PUT', '/api/settings'],
      ['GET', '/api/manager-settings'], ['GET', '/api/friends'], ['POST', '/api/invites'], ['PUT', '/api/password-login']]) {
      assert.equal((await call(method, url, { cookie: ann, body: {} })).status, 403, `${method} ${url}`);
    }
  });

  test('signs in with the passkey, and counts its uses', async () => {
    const passkey = new SoftPasskey();
    await register(await invite(await passwordSession(), { name: 'Ann' }), passkey);
    const first = await signIn(passkey);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await call('GET', '/api/me', { cookie: first.cookie })).body.name, 'Ann');
    await signIn(passkey);
    assert.equal(store.read().users[0].credentials[0].counter, 2);
  });

  test('an invite link works once', async () => {
    const token = await invite(await passwordSession(), { name: 'Ann' });
    assert.equal((await register(token, new SoftPasskey())).status, 200);
    assert.equal((await call('POST', '/api/passkeys/register/options', { body: { invite: token } })).status, 404);
  });

  test('refuses a passkey made for another site', async () => {
    const token = await invite(await passwordSession(), { name: 'Ann' });
    const res = await register(token, new SoftPasskey(), { origin: 'https://evil.example' });
    assert.equal(res.status, 400);
    assert.equal(store.read().users.length, 0);
    assert.ok(store.findInvite(token), 'the invite is still usable');
  });

  test('a step works once', async () => {
    const passkey = new SoftPasskey();
    await register(await invite(await passwordSession(), { name: 'Ann' }), passkey);
    const start = await call('POST', '/api/passkeys/login/options', { body: {} });
    const response = passkey.get(start.body.options, base);
    assert.equal((await call('POST', '/api/passkeys/login/verify', { body: { flowId: start.body.flowId, response } })).status, 200);
    assert.equal((await call('POST', '/api/passkeys/login/verify', { body: { flowId: start.body.flowId, response } })).status, 400);
  });

  test('removing a friend ends their session and their passkey', async () => {
    const admin = await passwordSession();
    const passkey = new SoftPasskey();
    const ann = (await register(await invite(admin, { name: 'Ann' }), passkey)).cookie;
    const id = store.read().users[0].id;
    assert.equal((await call('DELETE', `/api/friends/${id}`, { cookie: admin })).status, 200);
    assert.equal((await call('POST', '/api/start', { cookie: ann })).status, 401);
    assert.equal((await signIn(passkey)).status, 401);
  });

  test('a friend can add another device with their own link', async () => {
    const ann = (await register(await invite(await passwordSession(), { name: 'Ann' }), new SoftPasskey())).cookie;
    const own = await call('POST', '/api/me/invite', { cookie: ann });
    assert.equal(own.status, 201);
    const laptop = new SoftPasskey();
    assert.equal((await register(own.body.token, laptop, { deviceName: 'Laptop' })).status, 200);
    assert.equal((await signIn(laptop)).body.name, 'Ann');
    assert.equal(store.read().users.length, 1);
  });

  test('switching the password off needs an admin passkey, then ends password sessions', async () => {
    const admin = await passwordSession();
    assert.equal((await call('PUT', '/api/password-login', { cookie: admin, body: { enabled: false } })).status, 409);

    const owner = new SoftPasskey();
    const joined = await register(await invite(admin, { name: 'Owner', admin: true }), owner);
    assert.equal(joined.body.role, 'admin');
    const off = await call('PUT', '/api/password-login', { cookie: joined.cookie, body: { enabled: false } });
    assert.deepEqual(off.body, { ok: true, passwordLogin: false });

    assert.equal((await call('POST', '/api/login', { body: { password: 'pw' } })).status, 403);
    assert.equal((await call('POST', '/api/start', { cookie: admin })).status, 401);
    assert.equal((await call('GET', '/api/friends', { cookie: (await signIn(owner)).cookie })).status, 200);
  });

  test('a session token from before passkeys counts as the password', async () => {
    const legacy = `psm_session=${createSession(config.auth.sessionSecret, 1)}`;
    assert.equal((await call('GET', '/api/me', { cookie: legacy })).body.role, 'admin');
  });

  test('a damaged passkeys.json turns password sign-in off rather than on', async () => {
    fs.writeFileSync(store.file, 'damaged');
    assert.equal((await call('POST', '/api/login', { body: { password: 'pw' } })).status, 403);
  });

  test('wrong invite links count as failed tries', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await call('GET', `/api/passkeys/invite?invite=guess${i}`)).status, 404);
    }
    assert.equal((await call('GET', '/api/passkeys/invite?invite=guess')).status, 429);
  });
});

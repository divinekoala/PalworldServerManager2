import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './dataDir.js';

/**
 * Friends, their passkeys, invites, and the password switch, in passkeys.json.
 *
 * Every operation reads the file and writes it back, so the recovery script
 * (scripts/passkey-invite.js) and the running manager never overwrite each
 * other's changes. The file is small; that costs nothing.
 *
 * An unreadable file is an error, never an empty list: treating it as empty
 * would drop every friend and could turn password sign-in back on.
 */

export const DEFAULT_FILE = path.join(DATA_DIR, 'passkeys.json');
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const NAME_MAX = 40;
const DEVICE_MAX = 40;

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const empty = () => ({ version: 1, passwordLogin: true, users: [], invites: [] });
export const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('base64url');
const newId = () => crypto.randomBytes(16).toString('base64url');

function cleanName(value, max, what) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new StoreError('bad-name', `${what} is empty.`);
  if (name.length > max) throw new StoreError('bad-name', `${what} is longer than ${max} characters.`);
  // Control characters only; letters in any language are fine.
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new StoreError('bad-name', `${what} has a control character.`);
  return name;
}

/** An admin with at least one passkey: someone who can still sign in with the password off. */
const hasAdminPasskey = (data, except = {}) =>
  data.users.some(
    (u) =>
      u.admin &&
      u.id !== except.userId &&
      u.credentials.some((c) => !(u.id === except.ownerId && c.id === except.credentialId))
  );

export class PasskeyStore {
  constructor(file = DEFAULT_FILE, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
  }

  read() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return empty();
      throw new StoreError('unreadable', `Cannot read ${this.file}: ${err.message}`);
    }
    try {
      const data = JSON.parse(text);
      if (data?.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.invites)) {
        throw new Error('not a passkeys file');
      }
      return data;
    } catch (err) {
      throw new StoreError(
        'unreadable',
        `${this.file} is damaged (${err.message}). Fix it, or move it aside to start again with no passkeys.`
      );
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Windows refuses to rename over an existing file in some setups.
      if (err.code === 'EPERM' || err.code === 'EEXIST') {
        fs.rmSync(this.file, { force: true });
        fs.renameSync(tmp, this.file);
      } else {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    }
  }

  update(change) {
    const data = this.read();
    const result = change(data);
    data.invites = data.invites.filter((i) => i.expiresAt > this.now());
    this.write(data);
    return result;
  }

  // ── Password switch ─────────────────────────────────────────────────────────

  passwordLoginEnabled() {
    return this.read().passwordLogin !== false;
  }

  /** Turning it off needs an admin who can sign in with a passkey, or nobody could manage the manager. */
  setPasswordLogin(enabled) {
    return this.update((data) => {
      if (!enabled && !hasAdminPasskey(data)) {
        throw new StoreError(
          'no-admin-passkey',
          'Create a passkey for an admin first. Without one, nobody could sign in as admin.'
        );
      }
      data.passwordLogin = Boolean(enabled);
      return data.passwordLogin;
    });
  }

  // ── Users ───────────────────────────────────────────────────────────────────

  getUser(id) {
    return this.read().users.find((u) => u.id === id) ?? null;
  }

  findCredential(credentialId) {
    for (const user of this.read().users) {
      const credential = user.credentials.find((c) => c.id === credentialId);
      if (credential) return { user, credential };
    }
    return null;
  }

  /** Records a successful sign-in: the authenticator's counter and when. */
  touchCredential(credentialId, counter) {
    this.update((data) => {
      for (const user of data.users) {
        const credential = user.credentials.find((c) => c.id === credentialId);
        if (credential) {
          credential.counter = counter;
          credential.lastUsedAt = this.now();
        }
      }
    });
  }

  removeUser(id) {
    return this.update((data) => {
      const user = data.users.find((u) => u.id === id);
      if (!user) throw new StoreError('not-found', 'No such friend.');
      if (data.passwordLogin === false && user.admin && !hasAdminPasskey(data, { userId: id })) {
        throw new StoreError(
          'last-admin',
          'This is the last admin with a passkey, and password sign-in is off. Make another admin first.'
        );
      }
      data.users = data.users.filter((u) => u.id !== id);
      data.invites = data.invites.filter((i) => i.userId !== id);
      return user;
    });
  }

  removeCredential(userId, credentialId) {
    return this.update((data) => {
      const user = data.users.find((u) => u.id === userId);
      const credential = user?.credentials.find((c) => c.id === credentialId);
      if (!credential) throw new StoreError('not-found', 'No such passkey.');
      if (
        data.passwordLogin === false &&
        user.admin &&
        !hasAdminPasskey(data, { ownerId: userId, credentialId })
      ) {
        throw new StoreError(
          'last-admin',
          'This is the last admin passkey, and password sign-in is off. Add another first.'
        );
      }
      user.credentials = user.credentials.filter((c) => c.id !== credentialId);
      return credential;
    });
  }

  // ── Invites ─────────────────────────────────────────────────────────────────

  /**
   * A one-time link. For a new friend (name, admin) or for another device of an
   * existing one (userId). Only the token's hash is kept: the file never holds
   * a link that works.
   */
  createInvite({ name, admin = false, userId = null, createdBy }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const invite = this.update((data) => {
      let inviteName;
      if (userId) {
        const user = data.users.find((u) => u.id === userId);
        if (!user) throw new StoreError('not-found', 'No such friend.');
        inviteName = user.name;
      } else {
        inviteName = cleanName(name, NAME_MAX, 'The name');
        const lower = inviteName.toLowerCase();
        const taken =
          data.users.some((u) => u.name.toLowerCase() === lower) ||
          data.invites.some((i) => !i.userId && i.expiresAt > this.now() && i.name.toLowerCase() === lower);
        if (taken) throw new StoreError('name-taken', `"${inviteName}" already has a passkey or an invite.`);
      }
      const entry = {
        id: newId(),
        hash: hashToken(token),
        name: inviteName,
        admin: userId ? false : Boolean(admin),
        userId,
        createdBy: String(createdBy ?? ''),
        createdAt: this.now(),
        expiresAt: this.now() + INVITE_TTL_MS,
      };
      data.invites.push(entry);
      return entry;
    });
    return { token, invite };
  }

  findInvite(token) {
    const hash = hashToken(token);
    return this.read().invites.find((i) => i.hash === hash && i.expiresAt > this.now()) ?? null;
  }

  revokeInvite(id) {
    return this.update((data) => {
      const before = data.invites.length;
      data.invites = data.invites.filter((i) => i.id !== id);
      if (data.invites.length === before) throw new StoreError('not-found', 'No such invite.');
    });
  }

  /**
   * Uses an invite: adds the passkey to its friend, or creates the friend.
   * The invite is checked again here, so two devices racing one link cannot both land.
   */
  redeemInvite(inviteHash, { newUserId, credential, deviceName }) {
    return this.update((data) => {
      const invite = data.invites.find((i) => i.hash === inviteHash && i.expiresAt > this.now());
      if (!invite) throw new StoreError('invite-gone', 'This invite has expired or was used already.');
      if (data.users.some((u) => u.credentials.some((c) => c.id === credential.id))) {
        throw new StoreError('duplicate', 'This passkey is registered already.');
      }
      const entry = {
        ...credential,
        deviceName: deviceName ? cleanName(deviceName, DEVICE_MAX, 'The device name') : 'Passkey',
        createdAt: this.now(),
        lastUsedAt: this.now(),
      };
      let user;
      if (invite.userId) {
        user = data.users.find((u) => u.id === invite.userId);
        if (!user) throw new StoreError('invite-gone', 'The friend for this invite was removed.');
        user.credentials.push(entry);
      } else {
        if (data.users.some((u) => u.name.toLowerCase() === invite.name.toLowerCase())) {
          throw new StoreError('name-taken', `"${invite.name}" already has a passkey.`);
        }
        user = { id: newUserId, name: invite.name, admin: invite.admin, createdAt: this.now(), credentials: [entry] };
        data.users.push(user);
      }
      data.invites = data.invites.filter((i) => i.id !== invite.id);
      return user;
    });
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  /** What the Friends tab shows: no public keys, no token hashes. */
  overview() {
    const data = this.read();
    return {
      passwordLogin: data.passwordLogin !== false,
      users: data.users.map((u) => ({
        id: u.id,
        name: u.name,
        admin: u.admin,
        createdAt: u.createdAt,
        passkeys: u.credentials.map((c) => ({
          id: c.id,
          deviceName: c.deviceName,
          createdAt: c.createdAt,
          lastUsedAt: c.lastUsedAt,
        })),
      })),
      invites: data.invites
        .filter((i) => i.expiresAt > this.now())
        .map((i) => ({
          id: i.id,
          name: i.name,
          admin: i.admin,
          forExistingFriend: Boolean(i.userId),
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
        })),
    };
  }
}

export const newUserId = newId;

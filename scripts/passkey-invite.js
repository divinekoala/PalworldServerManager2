#!/usr/bin/env node
/**
 * Make a one-time passkey invite link, from the machine the manager runs on.
 * This is the way back in when nobody can sign in as admin, and a way to make
 * the first admin passkey without the password.
 *
 * Usage:
 *   npm run passkey-invite -- --admin <name>    a new admin
 *   npm run passkey-invite -- <name>            a new friend (on/off only)
 *   npm run passkey-invite -- --device <name>   another device for an existing friend
 *
 * In Docker:
 *   docker compose exec palworld-manager node scripts/passkey-invite.js --admin <name>
 *
 * The link works once, for 7 days. Open it on the device that gets the passkey.
 */
import 'dotenv/config';
import { PasskeyStore, StoreError } from '../src/passkeyStore.js';

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const device = args.includes('--device');
const name = args.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!name || (admin && device)) {
  console.error('Usage: npm run passkey-invite -- [--admin | --device] <name>');
  process.exit(1);
}

const store = new PasskeyStore();
try {
  let userId = null;
  if (device) {
    const user = store.read().users.find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!user) throw new StoreError('not-found', `No friend called "${name}".`);
    userId = user.id;
  }
  const { token, invite } = store.createInvite({ name, admin, userId, createdBy: 'passkey-invite script' });
  const origin = (process.env.PASSKEY_ORIGIN || '').replace(/\/+$/, '');
  const link = origin ? `${origin}/?invite=${token}` : `https://<the manager's address>/?invite=${token}`;
  const what = device ? `another device for ${invite.name}` : `${invite.admin ? 'admin' : 'friend'} "${invite.name}"`;
  console.log(`\nInvite for ${what}. It works once, until ${new Date(invite.expiresAt).toISOString()}:\n`);
  console.log(`  ${link}\n`);
  if (!origin) console.log('Put the manager\'s address in place of <the manager\'s address>, or set PASSKEY_ORIGIN.\n');
} catch (err) {
  console.error(err instanceof StoreError ? err.message : err);
  process.exit(1);
}

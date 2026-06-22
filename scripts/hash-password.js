#!/usr/bin/env node
/**
 * Generate an ADMIN_PASSWORD_HASH for the web UI password.
 *
 * Usage:
 *   npm run hash-password
 *   npm run hash-password -- "my secret password"
 *
 * Paste the printed line into your .env file.
 */
import readline from 'node:readline';
import { hashPassword } from '../src/auth.js';

function emit(password) {
  if (!password) {
    console.error('Password must not be empty.');
    process.exit(1);
  }
  const hash = hashPassword(password);
  console.log('\nAdd this line to your .env file:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
}

const fromArgs = process.argv.slice(2).join(' ').trim();
if (fromArgs) {
  emit(fromArgs);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the web UI password: ', (answer) => {
    rl.close();
    emit(answer.trim());
  });
}

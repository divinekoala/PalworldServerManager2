import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overrides live in a small JSON file so they survive manager restarts.
// In Docker, point MANAGER_DATA_DIR at the game-data volume (see compose file).
const DATA_DIR = process.env.MANAGER_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'manager-settings.json');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/** Load persisted overrides; missing or corrupt file yields {}. */
export function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Ignoring unreadable ${FILE}: ${err.message}`);
    return {};
  }
}

/** Persist overrides atomically. */
export function saveOverrides(overrides) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2) + '\n');
  try {
    fs.renameSync(tmp, FILE);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EEXIST') {
      fs.rmSync(FILE, { force: true });
      fs.renameSync(tmp, FILE);
    } else {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

/**
 * Apply overrides onto the live config object (mutates in place).
 * ServerManager reads config.autoShutdown on every poll tick, so this takes
 * effect immediately without restarting the manager.
 */
export function applyOverrides(config, overrides) {
  const as = overrides?.autoShutdown;
  if (as && typeof as === 'object') {
    if (typeof as.enabled === 'boolean') config.autoShutdown.enabled = as.enabled;
    if (typeof as.emptyMinutes === 'number' && as.emptyMinutes > 0) {
      config.autoShutdown.emptyMinutes = as.emptyMinutes;
    }
  }
  const hp = overrides?.hostPower;
  if (hp && typeof hp === 'object') {
    if (typeof hp.enabled === 'boolean') config.hostPower.enabled = hp.enabled;
  }
}

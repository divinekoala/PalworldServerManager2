import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The manager's own files (UI settings, passkeys) live here so they survive restarts.
// In Docker, MANAGER_DATA_DIR points at the game-data volume (see the compose file).
export const DATA_DIR = process.env.MANAGER_DATA_DIR || path.join(__dirname, '..', 'data');

import fs from 'node:fs';
import path from 'node:path';

const SECTION_HEADER = '[/Script/Pal.PalGameWorldSettings]';
const OPTION_LINE_RE = /^(\s*)OptionSettings=\((.*)\)\s*$/;

/** Path to the live PalWorldSettings.ini for this platform. */
export function getSettingsPath(config, platform = process.platform) {
  const sub = platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
  return path.join(config.process.cwd, 'Pal', 'Saved', 'Config', sub, 'PalWorldSettings.ini');
}

/** Path to the DefaultPalWorldSettings.ini the server ships with. */
export function getDefaultSettingsPath(config) {
  return path.join(config.process.cwd, 'DefaultPalWorldSettings.ini');
}

/**
 * Split the body of OptionSettings=(...) into `Key=RawValue` chunks.
 * Commas inside double quotes or nested parentheses (e.g.
 * CrossplayPlatforms=(Steam,Xbox)) do not split.
 */
function tokenizeTuple(body) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuotes) {
      cur += ch;
      if (ch === '\\' && i + 1 < body.length) {
        cur += body[++i]; // keep escaped char (covers \")
      } else if (ch === '"') {
        inQuotes = false;
      }
    } else if (ch === '"') {
      inQuotes = true;
      cur += ch;
    } else if (ch === '(') {
      depth += 1;
      cur += ch;
    } else if (ch === ')') {
      depth -= 1;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/**
 * Parse the full INI text. Everything except the OptionSettings line is kept
 * verbatim (as lines) so the file round-trips byte-exact apart from the
 * values we deliberately change.
 *
 * Returns { entries: Map<key, rawValue>, order: [key...], lines, lineIndex,
 *           indent, newline }.
 */
export function parse(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const lineIndex = lines.findIndex((l) => OPTION_LINE_RE.test(l));
  if (lineIndex === -1) {
    throw new Error('No OptionSettings=(...) line found in PalWorldSettings.ini');
  }
  const [, indent, body] = lines[lineIndex].match(OPTION_LINE_RE);

  const entries = new Map();
  const order = [];
  for (const part of tokenizeTuple(body)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue; // malformed chunk; drop rather than guess
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1);
    if (!entries.has(key)) order.push(key);
    entries.set(key, raw);
  }
  return { entries, order, lines, lineIndex, indent, newline };
}

/** Rebuild the file text from a parse() result (entries may be mutated). */
export function serialize(parsed) {
  const body = parsed.order.map((k) => `${k}=${parsed.entries.get(k)}`).join(',');
  const lines = [...parsed.lines];
  lines[parsed.lineIndex] = `${parsed.indent}OptionSettings=(${body})`;
  return lines.join(parsed.newline);
}

/** Set a key's raw value, appending it to the tuple if new. */
export function setEntry(parsed, key, raw) {
  if (!parsed.entries.has(key)) parsed.order.push(key);
  parsed.entries.set(key, raw);
}

/** Convert a raw INI value string to a typed JS value per catalog type. */
export function rawToTyped(raw, type) {
  switch (type) {
    case 'bool':
      return /^true$/i.test(raw.trim());
    case 'float':
    case 'int': {
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    }
    case 'enum':
    case 'string': {
      const t = raw.trim();
      if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        return t.slice(1, -1).replace(/\\"/g, '"');
      }
      return t;
    }
    default:
      return raw;
  }
}

/** Convert a typed JS value to the raw INI representation per catalog type. */
export function typedToRaw(value, type) {
  switch (type) {
    case 'bool':
      return value ? 'True' : 'False';
    case 'int':
      return String(Math.round(Number(value)));
    case 'float': {
      // The game writes 6-decimal floats (1.000000); match it so diffs stay tidy.
      const n = Number(value);
      return Number.isInteger(n) ? n.toFixed(6) : String(n);
    }
    case 'enum':
      return String(value);
    case 'string':
      return `"${String(value).replace(/"/g, '\\"')}"`;
    default:
      return String(value);
  }
}

/**
 * Atomic write with a one-time pristine backup: the first time we ever touch
 * the file, a .bak copy of the original is kept forever.
 */
export function writeSettingsFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bak = `${filePath}.bak`;
  if (fs.existsSync(filePath) && !fs.existsSync(bak)) {
    fs.copyFileSync(filePath, bak);
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Windows can refuse rename-over-existing (EPERM/EEXIST); replace explicitly.
    if (err.code === 'EPERM' || err.code === 'EEXIST' || err.code === 'EACCES') {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    } else {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

/** Build a minimal settings file from [key, rawValue] pairs. */
export function synthesizeFile(pairs, newline = '\n') {
  const body = pairs.map(([k, v]) => `${k}=${v}`).join(',');
  return `${SECTION_HEADER}${newline}OptionSettings=(${body})${newline}`;
}

/**
 * Read and parse the live settings file. If it doesn't exist yet (server never
 * started), fall back to DefaultPalWorldSettings.ini, then to the supplied
 * fallback pairs (catalog defaults). Never invents credentials.
 *
 * Returns { parsed, fileExists, path }.
 */
export function readSettings(config, fallbackPairs = []) {
  const livePath = getSettingsPath(config);
  if (fs.existsSync(livePath)) {
    return { parsed: parse(fs.readFileSync(livePath, 'utf8')), fileExists: true, path: livePath };
  }
  const defPath = getDefaultSettingsPath(config);
  if (fs.existsSync(defPath)) {
    try {
      const parsed = parse(fs.readFileSync(defPath, 'utf8'));
      return { parsed, fileExists: false, path: livePath };
    } catch {
      // fall through to synthesized defaults
    }
  }
  return { parsed: parse(synthesizeFile(fallbackPairs)), fileExists: false, path: livePath };
}

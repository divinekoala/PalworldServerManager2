import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { PalAuthError } from './palApi.js';

const STATES = Object.freeze({
  OFF: 'OFF',
  STARTING: 'STARTING',
  ON: 'ON',
  STOPPING: 'STOPPING',
});

// Consecutive failed polls while ON before we treat the server as crashed.
const CRASH_FAIL_THRESHOLD = 3;
// How often to probe readiness during startup.
const READY_PROBE_MS = 3000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export class ServerManager extends EventEmitter {
  constructor(config, api) {
    super();
    this.cfg = config;
    this.api = api;

    this.state = STATES.OFF;
    this.since = Date.now();
    this.players = 0;
    this.playerNames = [];
    this.emptySince = null;
    this.lastError = null;

    this.child = null;
    this.pid = null;
    this._childExited = false;
    this._expectingExit = false;
    this._pollTimer = null;
    this._failCount = 0;
  }

  getStatus() {
    return {
      state: this.state,
      players: this.players,
      playerNames: this.playerNames,
      emptySince: this.emptySince,
      since: this.since,
      lastError: this.lastError,
    };
  }

  /** Probe on startup: if a server is already running, adopt it as ON. */
  async init() {
    try {
      await this.api.info();
      this._setState(STATES.ON, 'adopted-existing-server');
      log('Detected an already-running Palworld server; adopted state ON.');
    } catch {
      this._setState(STATES.OFF, 'init');
    }
  }

  // ── Public transitions ─────────────────────────────────────────────────────

  start() {
    if (this.state !== STATES.OFF) {
      return { accepted: false, state: this.state, message: `Cannot start while ${this.state}` };
    }
    this.lastError = null;
    this._setState(STATES.STARTING, 'manual-start');
    this._doStart().catch((err) => log('Unexpected start error:', err));
    return { accepted: true, state: this.state };
  }

  stop(reason = 'manual-stop') {
    if (this.state !== STATES.ON) {
      return { accepted: false, state: this.state, message: `Cannot stop while ${this.state}` };
    }
    this._setState(STATES.STOPPING, reason);
    this._doStop(reason).catch((err) => log('Unexpected stop error:', err));
    return { accepted: true, state: this.state };
  }

  // ── Start/stop implementations ─────────────────────────────────────────────

  async _doStart() {
    try {
      const cwd = this.cfg.process.cwd || path.dirname(this.cfg.process.exe);
      log(`Spawning ${this.cfg.process.exe} ${this.cfg.process.args.join(' ')}`);
      this._childExited = false;
      this._expectingExit = false;
      this.child = spawn(this.cfg.process.exe, this.cfg.process.args, {
        cwd,
        windowsHide: false,
        stdio: 'ignore',
        // On Linux, PalServer.sh execs a child binary; a new process group lets
        // us force-kill the whole tree via the negative pid.
        detached: process.platform !== 'win32',
      });
      this.pid = this.child.pid;
      this.child.on('error', (err) => {
        this.lastError = `Failed to launch server: ${err.message}`;
        log(this.lastError);
      });
      this.child.on('exit', (code, signal) => this._onChildExit(code, signal));

      await this._waitForReady();
      if (this.state === STATES.STARTING) this._setState(STATES.ON, 'ready');
    } catch (err) {
      this.lastError = err.message;
      log('Start failed:', err.message);
      await this._forceKill();
      this._setState(STATES.OFF, 'start-failed');
    }
  }

  async _waitForReady() {
    const deadline = Date.now() + this.cfg.timeouts.startReadySeconds * 1000;
    while (Date.now() < deadline) {
      if (this.state !== STATES.STARTING) return; // aborted elsewhere
      if (this._childExited) throw new Error('Server process exited during startup');
      try {
        await this.api.info();
        return; // reachable -> ready
      } catch (err) {
        if (err instanceof PalAuthError) {
          throw new Error('Server is up but rejected the AdminPassword (check REST_API_PASSWORD)');
        }
        // connection refused / still booting: keep waiting
      }
      await delay(READY_PROBE_MS);
    }
    throw new Error('Timed out waiting for the server to become ready');
  }

  async _doStop(reason) {
    this._expectingExit = true;
    try {
      await this._safe(() => this.api.announce('Server_is_saving_and_shutting_down'), 'announce');
      await this._safe(() => this.api.save(), 'save');
      await delay(2000); // let the save flush before we pull the plug
      const grace = this.cfg.timeouts.shutdownGraceSeconds;
      try {
        await this.api.shutdown(grace, 'Server_shutting_down');
      } catch (err) {
        log('Graceful shutdown call failed, trying immediate stop:', err.message);
        await this._safe(() => this.api.stop(), 'stop');
      }
      await this._waitForExit();
    } catch (err) {
      this.lastError = err.message;
      log('Stop encountered an error:', err.message);
    } finally {
      await this._forceKillIfAlive();
      this._expectingExit = false;
      this._setState(STATES.OFF, reason);
    }
  }

  async _waitForExit() {
    // Allow the configured shutdown countdown plus the stop timeout.
    const deadline =
      Date.now() +
      (this.cfg.timeouts.stopSeconds + this.cfg.timeouts.shutdownGraceSeconds) * 1000;
    while (Date.now() < deadline) {
      if (this._childExited) return;
      // For an adopted process (no child handle), detect exit via the API.
      if (!this.child) {
        try {
          await this.api.info();
        } catch (err) {
          if (!(err instanceof PalAuthError)) return; // unreachable -> stopped
        }
      }
      await delay(2000);
    }
    log('Timed out waiting for graceful exit; will force-kill.');
  }

  // ── Player polling / auto-shutdown ─────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._failCount = 0;
    const tick = async () => {
      if (this.state !== STATES.ON) return;
      await this._pollOnce();
      if (this.state === STATES.ON) {
        this._pollTimer = setTimeout(tick, this.cfg.autoShutdown.pollSeconds * 1000);
      }
    };
    // First poll on a short delay so the server can settle after becoming ready.
    this._pollTimer = setTimeout(tick, 2000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _pollOnce() {
    try {
      const { count, names } = await this.api.players();
      this._failCount = 0;
      const changed = count !== this.players;
      this.players = count;
      this.playerNames = names;

      if (count === 0) {
        if (!this.emptySince) this.emptySince = Date.now();
      } else {
        this.emptySince = null;
      }
      if (changed) this._emitChange('players');

      const thresholdMs = this.cfg.autoShutdown.emptyMinutes * 60 * 1000;
      if (this.emptySince && Date.now() - this.emptySince >= thresholdMs) {
        log(`Auto-shutdown: server empty for ${this.cfg.autoShutdown.emptyMinutes} min.`);
        this.stop('auto-idle');
      }
    } catch (err) {
      // Transient failures must NOT advance the idle timer.
      this._failCount += 1;
      log(`Player poll failed (${this._failCount}/${CRASH_FAIL_THRESHOLD}): ${err.message}`);
      if (this._failCount >= CRASH_FAIL_THRESHOLD && this.state === STATES.ON) {
        this.lastError = 'Lost contact with the server (possible crash)';
        this._setState(STATES.OFF, 'crash');
      }
    }
  }

  // ── Process lifecycle helpers ──────────────────────────────────────────────

  _onChildExit(code, signal) {
    this._childExited = true;
    this.child = null;
    if (this._expectingExit) return; // handled by _doStop
    if (this.state === STATES.ON || this.state === STATES.STARTING) {
      this.lastError = `Server process exited unexpectedly (code ${code}, signal ${signal})`;
      log(this.lastError);
      this._setState(STATES.OFF, 'crash');
    }
  }

  async _forceKillIfAlive() {
    if (this._childExited) return;
    await this._forceKill();
  }

  async _forceKill() {
    if (process.platform === 'win32') {
      if (this.pid) {
        // /T kills the whole tree (PalServer.exe spawns a worker process).
        spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F']);
      }
      // Image-name fallback covers adopted processes we don't own a handle for.
      spawnSync('taskkill', ['/IM', 'PalServer-Win64-Shipping.exe', '/F']);
    } else {
      if (this.pid) {
        try {
          // Negative pid kills the whole process group (PalServer.sh + binary).
          process.kill(-this.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(this.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
      // Image-name fallback covers an orphaned worker we no longer have a pid for.
      spawnSync('pkill', ['-9', '-f', 'PalServer-Linux-Shipping']);
    }
    this._childExited = true;
    this.child = null;
  }

  // ── State transition plumbing ──────────────────────────────────────────────

  _setState(next, detail) {
    if (this.state === next) {
      // Still surface detail changes (e.g. re-init) but skip poller churn.
      this.emit('change', this.getStatus());
      return;
    }
    const leaving = this.state;
    this.state = next;
    this.since = Date.now();

    if (leaving === STATES.ON && next !== STATES.ON) this._stopPolling();
    if (next === STATES.ON) {
      this.players = this.players || 0;
      this.emptySince = null;
      this._startPolling();
    }
    if (next === STATES.OFF) {
      this.players = 0;
      this.playerNames = [];
      this.emptySince = null;
    }
    log(`State: ${leaving} -> ${next} (${detail})`);
    this._emitChange(detail);
  }

  _emitChange(detail) {
    this.emit('change', { ...this.getStatus(), detail });
  }

  async _safe(fn, label) {
    try {
      return await fn();
    } catch (err) {
      log(`${label} failed (continuing): ${err.message}`);
      return null;
    }
  }
}

export { STATES };

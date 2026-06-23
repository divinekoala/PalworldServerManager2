'use strict';

const el = (id) => document.getElementById(id);
const dot = el('dot');
const statusText = el('status-text');
const spinner = el('spinner');
const playersBox = el('players');
const playerCount = el('player-count');
const detail = el('detail');
const controls = el('controls');
const btnOn = el('btn-on');
const btnOff = el('btn-off');
const btnLogout = el('btn-logout');
const loginForm = el('login');
const passwordInput = el('password');
const message = el('message');

// null (not false) so the first /api/status response always differs from this
// initial value and triggers applyAuth() — otherwise a logged-out visitor
// (authed:false) matches the initial false, applyAuth never runs, and neither
// the login form nor the controls are ever revealed.
let authed = null;
let currentState = null;

const LABELS = {
  OFF: 'Server is OFF',
  STARTING: 'Turning on…',
  ON: 'Server is ON',
  STOPPING: 'Turning off… (saving)',
};

function showMessage(text, isError = false) {
  message.textContent = text || '';
  message.classList.toggle('error', !!isError);
}

function render(status) {
  if (!status) return;
  currentState = status.state;
  const transitioning = status.state === 'STARTING' || status.state === 'STOPPING';

  statusText.textContent = LABELS[status.state] || status.state;
  dot.className = 'dot ' + status.state.toLowerCase();
  spinner.classList.toggle('hidden', !transitioning);

  // Player count (only meaningful while ON)
  if (status.state === 'ON') {
    playerCount.textContent = status.players ?? 0;
    playersBox.classList.remove('hidden');
  } else {
    playersBox.classList.add('hidden');
  }

  detail.textContent = status.lastError ? `Last issue: ${status.lastError}` : '';

  // Button availability
  btnOn.disabled = !authed || status.state !== 'OFF';
  btnOff.disabled = !authed || status.state !== 'ON';
  btnOn.classList.toggle('hidden', status.state === 'ON');
  btnOff.classList.toggle('hidden', status.state !== 'ON' && status.state !== 'STOPPING');
}

function applyAuth(isAuthed) {
  authed = isAuthed;
  controls.classList.toggle('hidden', !authed);
  loginForm.classList.toggle('hidden', authed);
  render({ state: currentState || 'OFF', players: playerCount.textContent });
}

// ── Live updates via SSE, with polling fallback ───────────────────────────────
function connectEvents() {
  let pollTimer = null;
  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(refreshStatus, 2000);
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  try {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      stopPolling();
      try {
        render(JSON.parse(e.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; poll in the meantime and resync.
      startPolling();
    };
  } catch {
    startPolling();
  }
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status', { credentials: 'include' });
    const data = await res.json();
    if (typeof data.authed === 'boolean' && data.authed !== authed) applyAuth(data.authed);
    render(data);
  } catch {
    /* offline; will retry */
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function sendAction(path, transitionalLabel) {
  showMessage('');
  // Optimistically show the transitional state immediately.
  statusText.textContent = transitionalLabel;
  spinner.classList.remove('hidden');
  btnOn.disabled = true;
  btnOff.disabled = true;

  try {
    const res = await fetch(path, { method: 'POST', credentials: 'include' });
    if (res.status === 401) {
      applyAuth(false);
      showMessage('Please log in to control the server.', true);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMessage(data.message || data.error || 'Request failed.', true);
      refreshStatus();
    }
    // On success the authoritative state arrives over SSE.
  } catch {
    showMessage('Network error. Is the manager running?', true);
    refreshStatus();
  }
}

btnOn.addEventListener('click', () => sendAction('/api/start', LABELS.STARTING));
btnOff.addEventListener('click', () => sendAction('/api/stop', LABELS.STOPPING));

btnLogout.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  applyAuth(false);
  showMessage('Logged out.');
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      passwordInput.value = '';
      applyAuth(true);
      showMessage('Logged in.');
    } else {
      showMessage(data.error || 'Login failed.', true);
    }
  } catch {
    showMessage('Network error during login.', true);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function init() {
  await refreshStatus();
  connectEvents();
})();

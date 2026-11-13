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
const loginBox = el('login');
const passwordForm = el('password-form');
const passwordInput = el('password');
const btnPasskey = el('btn-passkey');
const signedInAs = el('signed-in-as');
const btnAddDevice = el('btn-add-device');
const deviceLink = el('device-link');
const deviceLinkUrl = el('device-link-url');
const message = el('message');
const webauthn = window.SimpleWebAuthnBrowser;

// null (not false) so the first /api/status response always differs from this
// initial value and triggers refreshMe() — otherwise a logged-out visitor
// (authed:false) matches the initial false, and neither the sign-in box nor
// the controls are ever revealed.
let authed = null;
let me = { role: null, name: null, passkey: false, passwordLogin: false };
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

/** Copies an input's text. Some browsers refuse the clipboard: then the text is selected. */
async function copyText(input, button) {
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = 'Copied';
  } catch {
    input.select();
    button.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => (button.textContent = 'Copy'), 2500);
}
window.psmCopyText = copyText;

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** The browser's passkey errors, in words a friend understands. */
function passkeyError(err) {
  if (err?.name === 'NotAllowedError') return 'Cancelled, or this device has no passkey for this site.';
  if (err?.name === 'InvalidStateError') return 'This device already has a passkey for you here.';
  return err?.message || 'The passkey did not work.';
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

  // Let other scripts (settings.js) follow the live server state.
  window.dispatchEvent(new CustomEvent('psm:state', { detail: { state: status.state } }));
}

function applyAuth(info) {
  me = info;
  authed = Boolean(info.authenticated);
  controls.classList.toggle('hidden', !authed);
  loginBox.classList.toggle('hidden', authed);
  passwordForm.classList.toggle('hidden', !info.passwordLogin);
  signedInAs.textContent = authed ? `Signed in as ${info.name}${info.role === 'admin' ? ' (admin)' : ''}` : '';
  btnAddDevice.classList.toggle('hidden', !(authed && info.passkey));
  if (!authed) deviceLink.classList.add('hidden');
  render({ state: currentState || 'OFF', players: playerCount.textContent });
  window.dispatchEvent(new CustomEvent('psm:auth', { detail: { authed, role: info.role, name: info.name } }));
}

async function refreshMe() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    applyAuth(await res.json());
  } catch {
    /* offline; will retry */
  }
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
    if (typeof data.authed === 'boolean' && (data.authed !== authed || (data.role ?? null) !== me.role)) {
      await refreshMe();
    }
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
      await refreshMe();
      showMessage('Please sign in to control the server.', true);
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
  await refreshMe();
  showMessage('Logged out.');
});

// ── Sign in ───────────────────────────────────────────────────────────────────
btnPasskey.addEventListener('click', async () => {
  showMessage('');
  if (!webauthn?.browserSupportsWebAuthn()) {
    showMessage('This browser cannot use passkeys. Try Safari, Chrome, Edge or Firefox.', true);
    return;
  }
  btnPasskey.disabled = true;
  try {
    const start = await postJson('/api/passkeys/login/options');
    if (!start.ok) throw new Error(start.data.error || 'Sign-in failed.');
    const response = await webauthn.startAuthentication({ optionsJSON: start.data.options });
    const done = await postJson('/api/passkeys/login/verify', { flowId: start.data.flowId, response });
    if (!done.ok) throw new Error(done.data.error || 'Sign-in failed.');
    await refreshMe();
    showMessage(`Welcome, ${done.data.name}.`);
  } catch (err) {
    showMessage(passkeyError(err), true);
  } finally {
    btnPasskey.disabled = false;
  }
});

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('');
  try {
    const res = await postJson('/api/login', { password: passwordInput.value });
    if (res.ok) {
      passwordInput.value = '';
      await refreshMe();
      showMessage('Logged in.');
    } else {
      showMessage(res.data.error || 'Login failed.', true);
    }
  } catch {
    showMessage('Network error during login.', true);
  }
});

btnAddDevice.addEventListener('click', async () => {
  showMessage('');
  const res = await postJson('/api/me/invite');
  if (!res.ok) {
    showMessage(res.data.error || 'Could not make a link.', true);
    return;
  }
  deviceLinkUrl.value = `${location.origin}/?invite=${res.data.token}`;
  deviceLink.classList.remove('hidden');
});
el('btn-copy-device-link').addEventListener('click', (e) => copyText(deviceLinkUrl, e.currentTarget));

// ── Invite link: create a passkey on this device ──────────────────────────────
function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'This device';
}

async function startInvite(token) {
  const panel = el('panel-invite');
  const intro = el('invite-intro');
  const box = el('invite-form-box');
  const inviteMessage = el('invite-message');
  const createBtn = el('btn-create-passkey');
  const deviceName = el('device-name');
  const tabs = document.querySelector('.tabs');
  const serverPanel = el('panel-server');

  // Show only the invite until it is done.
  panel.classList.remove('hidden');
  tabs.classList.add('hidden');
  serverPanel.classList.add('hidden');
  const leave = () => {
    history.replaceState(null, '', location.pathname);
    panel.classList.add('hidden');
    tabs.classList.remove('hidden');
    serverPanel.classList.remove('hidden');
  };

  const res = await fetch(`/api/passkeys/invite?invite=${encodeURIComponent(token)}`, { credentials: 'include' });
  const info = await res.json().catch(() => ({}));
  if (!res.ok) {
    intro.textContent = info.error || 'This invite link does not work.';
    const back = document.createElement('button');
    back.className = 'btn btn-link';
    back.textContent = 'Go to the server page';
    back.addEventListener('click', leave);
    panel.appendChild(back);
    return;
  }
  if (!webauthn?.browserSupportsWebAuthn()) {
    intro.textContent = 'This browser cannot use passkeys. Open the link in Safari, Chrome, Edge or Firefox.';
    return;
  }

  intro.textContent = info.forExistingFriend
    ? `Hi ${info.name}. Add a passkey on this device. You then sign in with your fingerprint, face or screen lock.`
    : info.admin
      ? `Hi ${info.name}. Create a passkey on this device. You then sign in as an admin with your fingerprint, face or screen lock.`
      : `Hi ${info.name}. Create a passkey on this device. You then sign in with your fingerprint, face or screen lock, and can turn the server on and off.`;
  deviceName.value = guessDeviceName();
  box.classList.remove('hidden');

  createBtn.addEventListener('click', async () => {
    inviteMessage.textContent = '';
    inviteMessage.classList.remove('error');
    createBtn.disabled = true;
    try {
      const start = await postJson('/api/passkeys/register/options', { invite: token });
      if (!start.ok) throw new Error(start.data.error || 'Could not start.');
      const response = await webauthn.startRegistration({ optionsJSON: start.data.options });
      const done = await postJson('/api/passkeys/register/verify', {
        flowId: start.data.flowId,
        response,
        deviceName: deviceName.value,
      });
      if (!done.ok) throw new Error(done.data.error || 'The passkey was not saved.');
      leave();
      await refreshMe();
      showMessage(`Your passkey is ready, ${done.data.name}. Next time, use "Sign in with a passkey".`);
    } catch (err) {
      inviteMessage.textContent = passkeyError(err);
      inviteMessage.classList.add('error');
      createBtn.disabled = false;
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function init() {
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) startInvite(invite);
  await refreshStatus();
  connectEvents();
})();

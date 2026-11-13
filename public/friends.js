'use strict';

// Friends tab (admins only): invite people, remove them or one of their
// passkeys, and switch password sign-in off once admins have passkeys.
(() => {
  const el = (id) => document.getElementById(id);
  const tabButton = el('tab-friends');
  const panel = el('panel-friends');
  const friendList = el('friend-list');
  const inviteList = el('invite-list');
  const noFriends = el('no-friends');
  const noInvites = el('no-invites');
  const inviteForm = el('invite-form');
  const inviteName = el('invite-name');
  const inviteAdmin = el('invite-admin');
  const inviteResult = el('invite-result');
  const inviteResultText = el('invite-result-text');
  const inviteResultUrl = el('invite-result-url');
  const pwSwitch = el('pw-switch');
  const pwHint = el('pw-hint');
  const message = el('friends-message');

  let isAdmin = false;
  let data = null;

  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  function show(text, isError = false) {
    message.textContent = text || '';
    message.classList.toggle('error', !!isError);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
    return json;
  }

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function linkButton(text, onClick, danger = false) {
    const b = node('button', `btn btn-link${danger ? ' danger' : ''}`, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function showLink(token, text) {
    inviteResultUrl.value = `${location.origin}/?invite=${token}`;
    inviteResultText.textContent = text;
    inviteResult.classList.remove('hidden');
    inviteResultUrl.focus();
    inviteResultUrl.select();
  }

  function render() {
    friendList.replaceChildren();
    for (const user of data.users) {
      const li = node('li', 'friend');
      const head = node('div', 'friend-head');
      head.append(node('strong', '', user.name), node('span', `badge${user.admin ? ' admin' : ''}`, user.admin ? 'admin' : 'friend'));
      if (user.id === data.you) head.append(node('span', 'you', '(you)'));
      li.append(head);

      const keys = node('ul', 'passkeys');
      for (const key of user.passkeys) {
        const k = node('li');
        k.append(node('span', '', `${key.deviceName} · added ${day(key.createdAt)} · last used ${day(key.lastUsedAt)}`));
        k.append(
          linkButton('Remove', async () => {
            if (!confirm(`Remove the passkey "${key.deviceName}" of ${user.name}? That device can no longer sign in.`)) return;
            await act(() => api('DELETE', `/api/friends/${encodeURIComponent(user.id)}/passkeys/${encodeURIComponent(key.id)}`), 'Passkey removed.');
          }, true)
        );
        keys.append(k);
      }
      if (!user.passkeys.length) keys.append(node('li', 'hint', 'No passkey left. Make a link for another device.'));
      li.append(keys);

      const actions = node('div', 'friend-actions');
      actions.append(
        linkButton('Link for another device', async () => {
          try {
            const res = await api('POST', '/api/invites', { userId: user.id });
            showLink(res.token, `Send this to ${user.name}. It adds a passkey on one more device, once, until ${day(res.invite.expiresAt)}.`);
            await load();
          } catch (err) {
            show(err.message, true);
          }
        }),
        linkButton(`Remove ${user.name}`, async () => {
          if (!confirm(`Remove ${user.name}? Their passkeys stop working at once.`)) return;
          await act(() => api('DELETE', `/api/friends/${encodeURIComponent(user.id)}`), `${user.name} removed.`);
        }, true)
      );
      li.append(actions);
      friendList.append(li);
    }
    noFriends.classList.toggle('hidden', data.users.length > 0);

    inviteList.replaceChildren();
    for (const inv of data.invites) {
      const li = node('li', 'friend invite');
      const what = inv.forExistingFriend ? 'another device' : inv.admin ? 'admin' : 'friend';
      li.append(node('span', '', `${inv.name} (${what}) · expires ${day(inv.expiresAt)}`));
      li.append(
        linkButton('Withdraw', async () => {
          await act(() => api('DELETE', `/api/invites/${encodeURIComponent(inv.id)}`), 'Invite withdrawn. The link no longer works.');
        }, true)
      );
      inviteList.append(li);
    }
    noInvites.classList.toggle('hidden', data.invites.length > 0);

    const adminWithPasskey = data.users.some((u) => u.admin && u.passkeys.length > 0);
    pwSwitch.checked = data.passwordLogin && data.passwordConfigured;
    pwSwitch.disabled = !data.passwordConfigured || (data.passwordLogin && !adminWithPasskey);
    pwHint.textContent = !data.passwordConfigured
      ? 'ADMIN_PASSWORD_HASH is not set, so there is no password.'
      : data.passwordLogin && !adminWithPasskey
        ? 'Make a passkey for an admin first. Then you can switch the password off.'
        : data.passwordLogin
          ? 'Switch it off when everybody has a passkey. Password sessions end at once.'
          : 'Off: only passkeys sign in. Switch it on again if you need the password.';
  }

  async function load() {
    try {
      data = await api('GET', '/api/friends');
      render();
    } catch (err) {
      show(err.message, true);
    }
  }

  async function act(call, done) {
    show('');
    try {
      await call();
      show(done);
    } catch (err) {
      show(err.message, true);
    }
    await load();
  }

  inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    show('');
    try {
      const res = await api('POST', '/api/invites', { name: inviteName.value, admin: inviteAdmin.checked });
      showLink(res.token, `Send this to ${res.invite.name}. It works once, until ${day(res.invite.expiresAt)}.`);
      inviteName.value = '';
      inviteAdmin.checked = false;
      await load();
    } catch (err) {
      show(err.message, true);
    }
  });

  el('btn-copy-invite').addEventListener('click', (e) => window.psmCopyText(inviteResultUrl, e.currentTarget));

  pwSwitch.addEventListener('change', async () => {
    const enabled = pwSwitch.checked;
    if (!enabled && data.you === 'password' &&
      !confirm('You are signed in with the password. Switching it off signs you out. Continue?')) {
      pwSwitch.checked = true;
      return;
    }
    await act(() => api('PUT', '/api/password-login', { enabled }), enabled ? 'Password sign-in is on.' : 'Password sign-in is off.');
    if (!enabled && data.you === 'password') location.reload();
  });

  window.addEventListener('psm:auth', (e) => {
    isAdmin = e.detail.authed && e.detail.role === 'admin';
    tabButton.classList.toggle('hidden', !isAdmin);
    if (!isAdmin && !panel.classList.contains('hidden')) window.psmSelectTab('server');
    if (isAdmin && !panel.classList.contains('hidden')) load();
  });

  window.addEventListener('psm:tab', (e) => {
    if (e.detail.name === 'friends' && isAdmin) load();
  });
})();

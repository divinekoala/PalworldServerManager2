'use strict';

// Settings tab: generated form for PalWorldSettings.ini (game balance,
// features, performance) plus the manager's auto-shutdown options.
(() => {
  const el = (id) => document.getElementById(id);

  const panels = {
    server: el('panel-server'),
    settings: el('panel-settings'),
  };
  const tabButtons = Array.from(document.querySelectorAll('.tab'));

  const loginNote = el('settings-login-note');
  const body = el('settings-body');
  const form = el('game-settings-form');
  const saveBtn = el('btn-save-settings');
  const resetBtn = el('btn-reset-defaults');
  const settingsMessage = el('settings-message');
  const banner = el('restart-banner');
  const restartBtn = el('btn-restart-now');

  const msEnabled = el('ms-auto-enabled');
  const msMinutes = el('ms-auto-minutes');
  const msMinutesRange = el('ms-auto-minutes-range');
  const msPowerEnabled = el('ms-power-enabled');
  const msSaveBtn = el('btn-save-manager');
  const managerMessage = el('manager-message');

  let authed = null; // mirrors app.js via psm:auth events
  let serverState = null; // mirrors app.js via psm:state events
  let catalog = null; // loaded from GET /api/settings
  let savedValues = {}; // last values persisted on the server
  let controls = new Map(); // key -> { get, set, entry, row }
  let loaded = false;
  let loadedManager = null; // last-saved manager settings

  // ── Tabs ────────────────────────────────────────────────────────────────────
  function selectTab(name) {
    for (const btn of tabButtons) {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    }
    panels.server.classList.toggle('hidden', name !== 'server');
    panels.settings.classList.toggle('hidden', name !== 'settings');
    if (name === 'settings') maybeLoad();
  }
  tabButtons.forEach((btn) => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));

  // ── Auth / state wiring from app.js ────────────────────────────────────────
  window.addEventListener('psm:auth', (e) => {
    authed = e.detail.authed;
    loginNote.classList.toggle('hidden', authed);
    body.classList.toggle('hidden', !authed);
    if (!authed) {
      loaded = false; // force a refetch on next login
      banner.classList.add('hidden');
    } else {
      maybeLoad();
    }
  });

  window.addEventListener('psm:state', (e) => {
    const prev = serverState;
    serverState = e.detail.state;
    restartBtn.disabled = serverState !== 'ON';
    // Once a restart actually begins (or the server is stopped some other
    // way), the pending-restart banner is obsolete.
    if (prev && prev !== serverState && serverState !== 'ON') {
      banner.classList.add('hidden');
    }
  });

  function showSettingsMessage(text, isError = false) {
    settingsMessage.textContent = text || '';
    settingsMessage.classList.toggle('error', !!isError);
  }
  function showManagerMessage(text, isError = false) {
    managerMessage.textContent = text || '';
    managerMessage.classList.toggle('error', !!isError);
  }

  // ── Load + build form ───────────────────────────────────────────────────────
  async function maybeLoad() {
    if (loaded || !authed || panels.settings.classList.contains('hidden')) return;
    loaded = true;
    showSettingsMessage('Loading…');
    try {
      const [settingsRes, managerRes] = await Promise.all([
        fetch('/api/settings', { credentials: 'include' }),
        fetch('/api/manager-settings', { credentials: 'include' }),
      ]);
      if (settingsRes.status === 401 || managerRes.status === 401) {
        loaded = false;
        return;
      }
      const settings = await settingsRes.json();
      const managerData = await managerRes.json();
      if (!settingsRes.ok) throw new Error(settings.error || 'failed to load settings');
      if (!managerRes.ok) throw new Error(managerData.error || 'failed to load manager settings');

      catalog = settings;
      savedValues = { ...settings.values };
      buildForm(settings);
      if (!settings.fileExists) {
        showSettingsMessage(
          'PalWorldSettings.ini does not exist yet (server never started); showing defaults. Saving will create it.'
        );
      } else {
        showSettingsMessage('');
      }

      loadedManager = {
        autoShutdown: managerData.autoShutdown,
        hostPower: managerData.hostPower || { enabled: false },
      };
      msEnabled.checked = !!loadedManager.autoShutdown.enabled;
      setMinutes(loadedManager.autoShutdown.emptyMinutes);
      msPowerEnabled.checked = !!loadedManager.hostPower.enabled;
      updateManagerDirty();
    } catch (err) {
      loaded = false;
      showSettingsMessage(`Could not load settings: ${err.message}`, true);
    }
  }

  function buildForm(settings) {
    form.textContent = '';
    controls = new Map();
    const byCategory = new Map(settings.categories.map((c) => [c.id, []]));
    for (const entry of settings.catalog) {
      (byCategory.get(entry.category) || []).push(entry);
    }

    for (const cat of settings.categories) {
      const entries = byCategory.get(cat.id) || [];
      if (!entries.length) continue;
      const group = document.createElement('details');
      group.className = 'settings-group';
      group.open = true;
      const summary = document.createElement('summary');
      summary.textContent = cat.label;
      group.appendChild(summary);
      for (const entry of entries) {
        group.appendChild(buildRow(entry, settings.values[entry.key]));
      }
      form.appendChild(group);
    }
    updateDirty();
  }

  function buildRow(entry, value) {
    const row = document.createElement('div');
    row.className = 'setting-row';

    const info = document.createElement('div');
    info.className = 'setting-info';
    const label = document.createElement('label');
    label.textContent = entry.label;
    label.htmlFor = `set-${entry.key}`;
    const desc = document.createElement('p');
    desc.className = 'setting-desc';
    desc.textContent = entry.description;
    info.append(label, desc);

    const controlBox = document.createElement('div');
    controlBox.className = 'setting-control';

    let api;
    if (entry.type === 'bool') {
      api = buildToggle(entry, value, controlBox);
    } else if (entry.type === 'enum') {
      api = buildSelect(entry, value, controlBox);
    } else if (entry.type === 'string') {
      api = buildText(entry, value, controlBox);
    } else {
      api = buildNumber(entry, value, controlBox);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset-btn';
    reset.title = `Reset to default (${entry.default})`;
    reset.textContent = '↺';
    reset.addEventListener('click', () => {
      api.set(entry.default);
      updateDirty();
    });
    controlBox.appendChild(reset);

    row.append(info, controlBox);
    controls.set(entry.key, { ...api, entry, row });
    return row;
  }

  function buildToggle(entry, value, parent) {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `set-${entry.key}`;
    input.checked = !!value;
    const knob = document.createElement('span');
    knob.className = 'knob';
    wrap.append(input, knob);
    parent.appendChild(wrap);
    input.addEventListener('change', updateDirty);
    return { get: () => input.checked, set: (v) => (input.checked = !!v) };
  }

  function buildSelect(entry, value, parent) {
    const select = document.createElement('select');
    select.id = `set-${entry.key}`;
    for (const opt of entry.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    select.value = value;
    parent.appendChild(select);
    select.addEventListener('change', updateDirty);
    return { get: () => select.value, set: (v) => (select.value = v) };
  }

  function buildNumber(entry, value, parent) {
    const range = document.createElement('input');
    range.type = 'range';
    range.min = entry.min;
    range.max = entry.max;
    range.step = entry.step;
    const num = document.createElement('input');
    num.type = 'number';
    num.id = `set-${entry.key}`;
    num.min = entry.min;
    num.max = entry.max;
    num.step = entry.step;

    const set = (v) => {
      range.value = v;
      num.value = v;
    };
    set(value);

    range.addEventListener('input', () => {
      num.value = range.value;
      updateDirty();
    });
    num.addEventListener('input', () => {
      range.value = num.value;
      updateDirty();
    });
    parent.append(range, num);
    return {
      get: () => {
        const n = Number(num.value);
        return Number.isNaN(n) ? null : n;
      },
      set,
    };
  }

  function buildText(entry, value, parent) {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `set-${entry.key}`;
    input.value = value ?? '';
    parent.appendChild(input);
    input.addEventListener('input', updateDirty);
    return { get: () => input.value, set: (v) => (input.value = v ?? '') };
  }

  // ── Dirty tracking / save ───────────────────────────────────────────────────
  function currentValues() {
    const values = {};
    for (const [key, c] of controls) values[key] = c.get();
    return values;
  }

  function updateDirty() {
    const values = currentValues();
    const dirty = Object.keys(values).some((k) => values[k] !== savedValues[k]);
    saveBtn.disabled = !dirty;
  }

  saveBtn.addEventListener('click', async () => {
    const values = currentValues();
    const changed = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== savedValues[k]) changed[k] = v;
    }
    if (!Object.keys(changed).length) return;

    // Clear previous field errors.
    for (const c of controls.values()) c.row.classList.remove('invalid');
    showSettingsMessage('Saving…');
    saveBtn.disabled = true;

    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: changed }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        showSettingsMessage('Session expired — log in again on the Server tab.', true);
        return;
      }
      if (!res.ok) {
        if (data.errors) {
          for (const [key, msg] of Object.entries(data.errors)) {
            const c = controls.get(key);
            if (c) c.row.classList.add('invalid');
          }
          const first = Object.entries(data.errors)[0];
          showSettingsMessage(`${first[0]}: ${first[1]}`, true);
        } else {
          showSettingsMessage(data.error || 'Save failed.', true);
        }
        updateDirty();
        return;
      }
      savedValues = { ...savedValues, ...changed };
      updateDirty();
      if (data.restartRequired) {
        showSettingsMessage('Saved.');
        banner.classList.remove('hidden');
      } else {
        showSettingsMessage('Saved. Changes apply the next time the server starts.');
      }
    } catch {
      showSettingsMessage('Network error while saving.', true);
      updateDirty();
    }
  });

  resetBtn.addEventListener('click', () => {
    if (!catalog) return;
    if (!window.confirm('Set every game setting on this page back to its default value?')) return;
    for (const c of controls.values()) c.set(c.entry.default);
    updateDirty();
  });

  restartBtn.addEventListener('click', async () => {
    restartBtn.disabled = true;
    try {
      const res = await fetch('/api/restart', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        banner.classList.add('hidden');
        showSettingsMessage('Restarting the server…');
      } else {
        showSettingsMessage(data.message || data.error || 'Restart failed.', true);
        restartBtn.disabled = false;
      }
    } catch {
      showSettingsMessage('Network error while restarting.', true);
      restartBtn.disabled = false;
    }
  });

  // ── Manager settings ────────────────────────────────────────────────────────
  function setMinutes(v) {
    msMinutes.value = v;
    msMinutesRange.value = Math.min(Number(msMinutesRange.max), v);
  }

  function updateManagerDirty() {
    if (!loadedManager) return;
    const dirty =
      msEnabled.checked !== loadedManager.autoShutdown.enabled ||
      Number(msMinutes.value) !== loadedManager.autoShutdown.emptyMinutes ||
      msPowerEnabled.checked !== loadedManager.hostPower.enabled;
    msSaveBtn.disabled = !dirty;
  }

  msEnabled.addEventListener('change', updateManagerDirty);
  msPowerEnabled.addEventListener('change', updateManagerDirty);
  msMinutes.addEventListener('input', () => {
    msMinutesRange.value = Math.min(Number(msMinutesRange.max), Number(msMinutes.value) || 1);
    updateManagerDirty();
  });
  msMinutesRange.addEventListener('input', () => {
    msMinutes.value = msMinutesRange.value;
    updateManagerDirty();
  });

  msSaveBtn.addEventListener('click', async () => {
    const payload = {
      autoShutdown: {
        enabled: msEnabled.checked,
        emptyMinutes: Number(msMinutes.value),
      },
      hostPower: {
        enabled: msPowerEnabled.checked,
      },
    };
    showManagerMessage('Saving…');
    msSaveBtn.disabled = true;
    try {
      const res = await fetch('/api/manager-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        loadedManager = { autoShutdown: data.autoShutdown, hostPower: data.hostPower };
        showManagerMessage('Saved — applies immediately, no restart needed.');
      } else {
        const msg = data.errors ? Object.values(data.errors)[0] : data.error || 'Save failed.';
        showManagerMessage(msg, true);
      }
    } catch {
      showManagerMessage('Network error while saving.', true);
    }
    updateManagerDirty();
  });
})();

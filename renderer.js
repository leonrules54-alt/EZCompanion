/* === EZCompanion Renderer (planner sidebar; works with or without Electron) === */

// DOM elements
const app = document.getElementById('app');
const infoPopup = document.getElementById('info-popup');
const settingsPanel = document.getElementById('settings-panel');
const vaultPanel = document.getElementById('clipboard-vault');
const notesPanel = document.getElementById('notes-panel');
const tasksPanel = document.getElementById('tasks-panel');
const categoriesPanel = document.getElementById('categories-panel');
const focusPanel = document.getElementById('focus-panel');

// Popup elements
const popupTime = document.getElementById('popup-time');
const popupDate = document.getElementById('popup-date');
const weatherIcon = document.getElementById('weather-icon');
const weatherTemp = document.getElementById('weather-temp');
const weatherDesc = document.getElementById('weather-desc');
const quoteText = document.getElementById('quote-text');

// State
let radialOpen = false;
let notes = loadNotes();
let tasks = loadTasks();       // [{id, name, due, durationMin, done, completedAt, category}]
let deadlines = loadDeadlines(); // [{id, name, due, time, done, completedAt}]
let categories = loadCategories(); // [{id, name, color}]
// daily-tasks filter window (0 = today, 3, 7 days) — persisted
let taskFilter = (() => {
  const v = parseInt(localStorage.getItem('wolf-task-filter'), 10);
  return v === 0 || v === 3 || v === 7 ? v : 7;
})();
let imMode = 'deadline';       // add/edit modal mode: 'deadline' | 'task'
let imEditId = null;           // id being edited in the modal (null = new)
// Sidebar view mode: 'tasks' (default two-half layout) or 'calendar'
// (month grid on top, selected day's items below). 'week' lives in its own
// top-of-screen window and hides this one (main.js orchestrates the windows).
let appView = 'tasks';
let calMonth = null;           // calendar view: month being shown (Date of the 1st)
let calSelectedKey = null;     // calendar view: selected day 'YYYY-MM-DD'

const settings = {
  alwaysOnTop: true,
  weather: true,
};

// === API wrapper (Electron or browser fallback) ===
const hasElectron = !!(window.electronAPI);
const api = {
  setIgnoreMouse(ignore) { if (hasElectron) window.electronAPI.setIgnoreMouse(ignore); },
  setAlwaysOnTop(v) { if (hasElectron) window.electronAPI.setAlwaysOnTop(v); },
  openScreenshotOverlay() {
    if (hasElectron) window.electronAPI.openScreenshotOverlay();
    else startBrowserScreenshot();
  },
  openNotesPanel() {
    // Electron: the notes popup is its own window floating LEFT of the
    // sidebar (see notes.html / createNotesWindow). The browser preview
    // falls back to the in-window panel.
    if (hasElectron) window.electronAPI.openNotesPanel();
    else openNotesPanel();
  },
  writeClipboard(text) {
    if (hasElectron) return window.electronAPI.writeClipboard(text);
    return navigator.clipboard.writeText(text).then(() => true);
  },
  getClipboardHistory() {
    if (hasElectron) return window.electronAPI.getClipboardHistory();
    return Promise.resolve([]);
  },
  deleteClipboardItem(text) { if (hasElectron) window.electronAPI.deleteClipboardItem(text); },
  clearClipboardHistory() { if (hasElectron) window.electronAPI.clearClipboardHistory(); },
  onOpenPanel(cb) { if (hasElectron) window.electronAPI.onOpenPanel(cb); },
  onScreenshotDone(cb) { if (hasElectron) window.electronAPI.onScreenshotDone(cb); },
  // Full-screen deadline alert (Electron only; the browser preview shows the
  // due toast but no overlay).
  showDeadlineAlert(dl) { if (hasElectron) window.electronAPI.showDeadlineAlert(dl); },
  onDeadlineAlertAcked(cb) { if (hasElectron) window.electronAPI.onDeadlineAlertAcked(cb); },
  // Sleep / wake (Ctrl+Shift+S) — browser preview fades the planner in place.
  toggleSleep() {
    if (hasElectron) window.electronAPI.toggleSleep();
    else { document.body.classList.toggle('sleeping-all'); sendInteractiveBounds(); }
  },
  onSetSleeping(cb) { if (hasElectron) window.electronAPI.onSetSleeping(cb); },
  onAltDim(cb) { if (hasElectron) window.electronAPI.onAltDim(cb); },
  // App view modes (tasks / calendar / week — one at a time)
  setMode(mode) {
    if (hasElectron) window.electronAPI.setMode(mode);
    else if (mode === 'calendar') setAppView('calendar');
    else if (mode === 'tasks') setAppView('tasks');
    else showToast('📆 Week view runs in the desktop app');
  },
  onSetMode(cb) { if (hasElectron) window.electronAPI.onSetMode(cb); },
  onSelectDay(cb) { if (hasElectron) window.electronAPI.onSelectDay(cb); },
};

// === Initialize ===
function init() {
  // Panels opened from the floating launcher button window.
  api.onOpenPanel(({ action }) => {
    switch (action) {
      case 'info': toggleInfoPopup(); break;
      case 'clipboard': openClipboardVault(); break;
      case 'tasks': showPlanner(); break;
      case 'focus': openFocusPanel(); break;
      case 'settings': openSettingsPanel(); break;
      case 'categories': openCategoriesPanel(); break;
    }
  });
  api.onScreenshotDone(() => showToast('Screenshot copied to clipboard! 📋'));
  // Sleep (Ctrl+Shift+S): fade the whole app off the screen. Alt+C peek:
  // dim everything while held so you can see & click through.
  api.onSetSleeping(({ value }) => {
    document.body.classList.toggle('sleeping-all', !!value);
    if (value) {
      closeAllPopups(); // nothing should stay up over a hidden app
    } else {
      // Wake robustness: force the planner back on screen even if it was left
      // panel-hidden — the status bar used to come back without the planner.
      showPlanner();
    }
    sendInteractiveBounds();
    // Toast floats above the faded planner so the action is always confirmed.
    showToast(value ? '😴 App hidden — Ctrl+Shift+S to summon it back' : '✨ Welcome back!');
  });
  api.onAltDim((s) => {
    document.body.classList.toggle('alt-dim', !!(s && s.active));
    sendInteractiveBounds();
  });
  // View modes: 'tasks'/'calendar' render in this window; 'week' hides it in
  // favour of the top-of-screen week strip (main.js owns the window toggles).
  api.onSetMode(({ view }) => {
    if (view === 'week') {
      document.body.classList.add('view-week');
      document.body.classList.remove('view-calendar');
      setViewSwitch('week');
      sendInteractiveBounds();
    } else {
      document.body.classList.remove('view-week');
      showPlanner(); // a mode switch always brings the planner back on screen
      setAppView(view === 'calendar' ? 'calendar' : 'tasks');
    }
  });
  api.onSelectDay(({ key }) => {
    // Jump the calendar view to a specific day (clicked in the week strip).
    document.body.classList.remove('view-week');
    const d = parseDateKey(key);
    if (d) {
      calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      calSelectedKey = key;
    } else {
      calSelectedKey = dayKeyNow();
    }
    setAppView('calendar'); // renders with the requested month + day selected
    sendInteractiveBounds();
  });
  // When the user acknowledges the full-screen deadline alert, forget its
  // reminder record AND cross the acknowledged deadline out (mark done) —
  // it's removed automatically once its day is over, never on acknowledge.
  api.onDeadlineAlertAcked(() => {
    const alertedIds = Object.keys(reminderState).filter((id) => reminderState[id] && reminderState[id].alerted);
    let changed = false;
    alertedIds.forEach((id) => { delete reminderState[id]; changed = true; });
    if (changed) saveReminderState(reminderState);
    if (alertedIds.length) {
      let doneNow = false;
      deadlines.forEach((dl) => {
        if (alertedIds.includes(String(dl.id)) && !dl.done) {
          dl.done = true;
          dl.completedAt = Date.now();
          doneNow = true;
        }
      });
      if (doneNow) {
        saveDeadlines();
        bumpStreak(); // acknowledging a deadline counts toward today's streak
      }
      renderDeadlines();
      renderStreak();
    }
  });

  updateClock();
  setInterval(updateClock, 1000);
  updateWeather();
  updateQuote();
  loadSettings();
  loadTheme();

  if (hasElectron) {
    document.body.classList.add('electron-mode');
    sendInteractiveBounds();
    // Keep the interactive hit-regions in sync with the planner's live
    // layout (state changes, show/hide, popups).
    setInterval(sendInteractiveBounds, 400);
    setTimeout(sendInteractiveBounds, 1200);
    window.electronAPI.onClipboardHistory((items) => {
      if (!vaultPanel.classList.contains('popup-hidden')) renderVault(items);
    });
  }

  buildRingMenu();
  migrateTasks();
  renderDeadlines();
  renderTasks();
  renderStreak();
  renderDailyProgress();
  renderFocusMini();
  // Live ticker: prunes expired deadlines + finished tasks and re-checks the
  // streak (day rollover) every minute. The lists themselves are only
  // re-rendered while the planner is visible, so a hidden planner never
  // resets scroll position out from under the user.
  setInterval(() => {
    pruneExpiredDeadlines();
    pruneExpiredTasks();
    if (!tasksPanel.classList.contains('panel-hidden')) { renderDeadlines(); renderTasks(); }
    if (appView === 'calendar') renderCalendar(); // refresh day dots
    renderStreak();
    renderDailyProgress();
  }, 60000);

  // Deadline reminders: check every 30s (cheap — only iterates deadlines and
  // compares timestamps) so 30/20/10/5-min toasts and the due alert fire on
  // time even while the planner is hidden.
  tickDeadlineReminders();
  setInterval(tickDeadlineReminders, 30000);
}

// === Send interactive element bounds to main process for cursor polling ===
// The planner glass, popups and modal are interactive at once (no hover-arm
// anymore). The renderer refreshes these on a 400ms timer so the hit-regions
// always track the live layout.
function sendInteractiveBounds() {
  if (!hasElectron) return;
  const appRect = app.getBoundingClientRect();
  const bounds = [];

  // Planner glass — interactive immediately wherever it sits (unless the app
  // is asleep or Alt+C-peeking, when everything is click-through).
  const glass = document.querySelector('.tasks-panel-glass');
  const asleep = document.body.classList.contains('sleeping-all');
  const peeking = document.body.classList.contains('alt-dim');
  if (glass && !tasksPanel.classList.contains('panel-hidden') && !asleep && !peeking) {
    const r = glass.getBoundingClientRect();
    bounds.push({ x: r.left - appRect.left, y: r.top - appRect.top, w: r.width, h: r.height });
  }

  // Add/edit modal: the whole window belongs to the modal while it's open.
  const modal = document.getElementById('task-modal');
  if (modal && !modal.hidden) {
    bounds.push({ x: 0, y: 0, w: appRect.width, h: appRect.height });
  }

  // While ANY popup or the ring menu is open, make the whole window
  // interactive so every button reliably receives clicks in Electron.
  const anyPopup =
    radialOpen ||
    !infoPopup.classList.contains('popup-hidden') ||
    !settingsPanel.classList.contains('panel-hidden') ||
    !vaultPanel.classList.contains('popup-hidden') ||
    !notesPanel.classList.contains('panel-hidden') ||
    !categoriesPanel.classList.contains('panel-hidden') ||
    !focusPanel.classList.contains('popup-hidden') ||
    !document.getElementById('theme-palette').classList.contains('palette-hidden');
  if (anyPopup) {
    bounds.push({ x: 0, y: 0, w: appRect.width, h: appRect.height });
  }

  // The mark-progress slider box must keep receiving input while open — add
  // its rect to the interactive regions (the 400ms bounds sync keeps it
  // live as it moves).
  const pp = document.getElementById('progress-popover');
  if (pp && pp.classList.contains('visible')) {
    const r = pp.getBoundingClientRect();
    bounds.push({ x: r.left - appRect.left, y: r.top - appRect.top, w: r.width, h: r.height });
  }

  window.electronAPI.updateInteractiveBounds(bounds);
}

// === Clock ===
function updateClock() {
  const now = new Date();
  popupTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  popupDate.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// === Weather (mock) ===
const weatherOptions = [
  { icon: '☀️', temp: '74°F', desc: 'Sunny' },
  { icon: '⛅', temp: '68°F', desc: 'Partly cloudy' },
  { icon: '🌤️', temp: '70°F', desc: 'Fair' },
  { icon: '🌧️', temp: '62°F', desc: 'Light rain' },
  { icon: '❄️', temp: '45°F', desc: 'Snow flurries' },
];

function updateWeather() {
  if (!settings.weather) {
    weatherIcon.textContent = '—'; weatherTemp.textContent = ''; weatherDesc.textContent = 'Weather off'; return;
  }
  const w = weatherOptions[Math.floor(Math.random() * weatherOptions.length)];
  weatherIcon.textContent = w.icon; weatherTemp.textContent = w.temp; weatherDesc.textContent = w.desc;
}
setInterval(() => { if (settings.weather) updateWeather(); }, 300000);

// === Quotes ===
const quotes = [
  "You're doing great today! ✨", 'Every step forward counts. 🌱',
  "Take a deep breath — you've got this. 💪", 'Small progress is still progress. 🌻',
  'You are capable of amazing things. ⭐', 'One task at a time. You rule! 🎯',
  'Rest is productive too. 😌', 'Believe in yourself — I do! 💖',
];
function updateQuote() { quoteText.textContent = quotes[Math.floor(Math.random() * quotes.length)]; }

// Close popups when clicking anywhere else (the launcher and its ring are
// excluded — they toggle their own state).
app.addEventListener('click', (e) => {
  if (e.target.closest('#browser-launcher')) return;
  if (e.target.closest('#radial-menu')) return;
  if (e.target.closest('#tasks-panel')) return;
  if (e.target.closest('#categories-panel')) return;
  if (e.target.closest('.popup-glass') || e.target.closest('.panel-glass')) return;
  closeRadialMenu();
  closeClipboardVault();
  closeNotesPanel();
  closeCategoriesPanel();
  closeFocusPanel();
});

// Browser-only launcher button (hidden in Electron — button.html owns the
// ring menu there). Clicking it opens the ring around the button.
const launcherEl = document.getElementById('browser-launcher');
if (launcherEl) {
  launcherEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRadialMenu();
  });

  // Hover-arm for the browser-preview launcher: rest on the button ~2.5s to
  // open the ring (matches the floating launcher window in Electron, which
  // runs the same arming logic in main.js).
  (function armBrowserLauncher() {
    const ARM_MS = 2500;
    const ring = document.getElementById('browser-arm-ring');
    const timer = document.getElementById('browser-arm-timer');
    let start = 0, raf = null, armed = false;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / ARM_MS);
      if (ring) ring.style.setProperty('--p', (p * 100).toFixed(1));
      if (timer) timer.textContent = p < 1 ? Math.ceil((1 - p) * ARM_MS / 1000) + 's' : '';
      document.body.classList.toggle('arming', p > 0 && p < 1);
      if (p >= 1) {
        armed = true;
        document.body.classList.remove('arming');
        document.body.classList.add('armed');
        if (!radialOpen) toggleRadialMenu();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    launcherEl.addEventListener('mouseenter', () => {
      if (armed || radialOpen) return;
      start = performance.now();
      raf = requestAnimationFrame(tick);
    });
    launcherEl.addEventListener('mouseleave', () => {
      cancelAnimationFrame(raf);
      document.body.classList.remove('arming', 'armed');
      if (ring) ring.style.setProperty('--p', '0');
      if (timer) timer.textContent = '';
      if (armed) { armed = false; closeRadialMenu(); }
    });
  })();
}

// === Info Popup ===
function toggleInfoPopup() {
  const isHidden = infoPopup.classList.contains('popup-hidden');
  if (isHidden) {
    updateClock(); updateWeather(); updateQuote();
    infoPopup.classList.remove('popup-hidden');
    settingsPanel.classList.add('panel-hidden');
    vaultPanel.classList.add('popup-hidden');
    notesPanel.classList.add('panel-hidden');
  } else { infoPopup.classList.add('popup-hidden'); }
  sendInteractiveBounds();
}
document.getElementById('popup-close').addEventListener('click', (e) => { e.stopPropagation(); infoPopup.classList.add('popup-hidden'); sendInteractiveBounds(); });

// === Settings ===
document.getElementById('settings-close').addEventListener('click', (e) => { e.stopPropagation(); settingsPanel.classList.add('panel-hidden'); sendInteractiveBounds(); });

['setting-weather','setting-ontop'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', function() {
    const key = { 'setting-weather':'weather', 'setting-ontop':'alwaysOnTop' }[id];
    settings[key] = this.checked; saveSettings();
    if (id === 'setting-weather') updateWeather();
    if (id === 'setting-ontop') api.setAlwaysOnTop(this.checked);
  });
});

function openSettingsPanel() {
  settingsPanel.classList.remove('panel-hidden');
  infoPopup.classList.add('popup-hidden');
  vaultPanel.classList.add('popup-hidden');
  notesPanel.classList.add('panel-hidden');
  sendInteractiveBounds();
}

function loadSettings() {
  try { Object.assign(settings, JSON.parse(localStorage.getItem('wolf-pet-settings')) || {}); } catch (e) {}
  document.getElementById('setting-weather').checked = settings.weather;
  document.getElementById('setting-ontop').checked = settings.alwaysOnTop;
  // Apply the saved on-top preference at startup — the window is created
  // always-on-top, so without this the toggle only worked mid-session.
  api.setAlwaysOnTop(settings.alwaysOnTop);
}
function saveSettings() { localStorage.setItem('wolf-pet-settings', JSON.stringify(settings)); }

// === Theme palette (pops up at the bottom-left of the planner) ===
// Each theme swaps the app's CSS variables via body[data-theme=…] — the
// swatch grid below is a gradient preview of what the glass becomes.
const THEMES = [
  { id: 'black',      name: 'Black',      gradient: 'linear-gradient(135deg, #3a3a3a, #000000)' },
  { id: 'white',      name: 'White',      gradient: 'linear-gradient(135deg, #ffffff, #d6deea)' },
  { id: 'light-blue', name: 'Light Blue', gradient: 'linear-gradient(135deg, #c7e6ff, #38bdf8)' },
  { id: 'dark-blue',  name: 'Dark Blue',  gradient: 'linear-gradient(135deg, #60a5fa, #172554)' },
  { id: 'green',      name: 'Green',      gradient: 'linear-gradient(135deg, #34d399, #065f46)' },
  { id: 'pink',       name: 'Pink',       gradient: 'linear-gradient(135deg, #fbcfe8, #ec4899)' },
  { id: 'purple',     name: 'Purple',     gradient: 'linear-gradient(135deg, #ddd6fe, #7c3aed)' },
  { id: 'red',        name: 'Red',        gradient: 'linear-gradient(135deg, #fca5a5, #b91c1c)' },
];
let themeId = 'default';

function applyTheme(id) {
  themeId = (id && THEMES.some(t => t.id === id)) ? id : 'default';
  if (themeId === 'default') delete document.body.dataset.theme;
  else document.body.dataset.theme = themeId;
  localStorage.setItem('wolf-theme', themeId);
  const grid = document.getElementById('theme-grid');
  if (grid) grid.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.theme === themeId));
}

function loadTheme() {
  let id = 'default';
  try { id = localStorage.getItem('wolf-theme') || 'default'; } catch (e) {}
  applyTheme(id);
}

function renderThemeGrid() {
  const grid = document.getElementById('theme-grid');
  if (!grid || grid.childNodes.length) return;
  THEMES.forEach(t => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch' + (t.id === themeId ? ' active' : '');
    s.dataset.theme = t.id;
    s.style.background = t.gradient;
    s.title = t.name;
    s.setAttribute('aria-label', t.name);
    s.addEventListener('click', (e) => {
      e.stopPropagation();
      applyTheme(t.id);
      closeThemePalette();
      showToast('🎨 ' + t.name + ' theme applied');
    });
    grid.appendChild(s);
  });
}

function openThemePalette() {
  renderThemeGrid();
  document.getElementById('theme-palette').classList.remove('palette-hidden');
  sendInteractiveBounds();
}

function closeThemePalette() {
  document.getElementById('theme-palette').classList.add('palette-hidden');
  sendInteractiveBounds();
}

// === Daily date key (used by the planner to prune finished tasks) ===
const dayKeyNow = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// Start-of-today timestamp (local midnight) — shared by the pruners so the
// deadline/task expiry rules can never drift apart.
const todayStartMs = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
};

// === Glass Ring Menu (browser preview only — built from RING_ACTIONS) ===
const RING_ACTIONS = [
  { action: 'info', icon: 'ℹ️', label: 'Info' },
  { action: 'clipboard', icon: '📋', label: 'Clipboard' },
  { action: 'notes', icon: '📝', label: 'Notes' },
  { action: 'tasks', icon: '🎯', label: 'Tasks' },
  { action: 'focus', icon: '⏱️', label: 'Focus' },
  { action: 'calendar', icon: '📅', label: 'Calendar' },
  { action: 'week', icon: '📆', label: 'Week' },
  { action: 'screenshot', icon: '📷', label: 'Screenshot' },
  { action: 'settings', icon: '⚙️', label: 'Settings' },
];

// Accent hue per action — feeds both the glow identity and the SVG
// gradient paint servers for each wedge + glass button.
const ACTION_COLORS = {
  info: '#38bdf8', clipboard: '#2dd4bf', notes: '#fbbf24',
  tasks: '#34d399', focus: '#a3e635', calendar: '#f97316', week: '#818cf8',
  screenshot: '#f472b6', settings: '#94a3b8',
};

// Build the ring: N equal arc segments (annular sectors) with an icon on each.
function buildRingMenu() {
  const svg = document.getElementById('ring-segments');
  if (!svg || svg.childNodes.length) return;
  const NS = 'http://www.w3.org/2000/svg';
  const CX = 140, CY = 140;
  const R_OUT = 124, R_IN = 88;         // wedge band (big hole)
  const ICON_R = (R_IN + R_OUT) / 2;    // dead centre of the band
  const BTN_R = 16;                     // glass button behind each icon
  const LABEL_R = 131;                  // action-name labels, just outside the band
  const N = RING_ACTIONS.length;
  const step = 360 / N;
  const gap = 1.4; // tiny gap between chunks for a segmented look
  const polar = (r, a) => {
    const rad = (a * Math.PI) / 180;
    return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
  };

  const defs = document.createElementNS(NS, 'defs');
  RING_ACTIONS.forEach((item) => {
    const c = ACTION_COLORS[item.action];
    const mk = (id, stops) => {
      const g = document.createElementNS(NS, 'linearGradient');
      g.setAttribute('id', id);
      g.setAttribute('x1', '0%'); g.setAttribute('y1', '0%');
      g.setAttribute('x2', '100%'); g.setAttribute('y2', '100%');
      stops.forEach(([off, col]) => {
        const s = document.createElementNS(NS, 'stop');
        s.setAttribute('offset', off);
        s.setAttribute('stop-color', col);
        g.appendChild(s);
      });
      defs.appendChild(g);
    };
    mk('seg-grad-' + item.action, [['0%', '#141e381f'], ['55%', c + '99'], ['100%', c + 'cc']]);
    mk('seg-grad-btn-' + item.action, [['0%', c + 'd9'], ['60%', c + '66'], ['100%', '#141e3873']]);
  });
  svg.appendChild(defs);

  RING_ACTIONS.forEach((item, i) => {
    const a0 = i * step - 90 - step / 2 + gap / 2;
    const a1 = (i + 1) * step - 90 - step / 2 - gap / 2;
    const [ox0, oy0] = polar(R_OUT, a0);
    const [ox1, oy1] = polar(R_OUT, a1);
    const [ix0, iy0] = polar(R_IN, a0);
    const [ix1, iy1] = polar(R_IN, a1);
    const large = (a1 - a0) > 180 ? 1 : 0;
    const d = `M ${ox0} ${oy0} L ${ix0} ${iy0} A ${R_IN} ${R_IN} 0 ${large} 1 ${ix1} ${iy1} L ${ox1} ${oy1} A ${R_OUT} ${R_OUT} 0 ${large} 0 ${ox0} ${oy0} Z`;

    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'ring-seg');
    g.setAttribute('data-action', item.action);
    g.setAttribute('data-icon', item.icon);

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'url(#seg-grad-' + item.action + ')');
    g.appendChild(path);

    const mid = i * step - 90; // wedge centre angle (0° = top, clockwise)
    const [tx, ty] = polar(ICON_R, mid);
    const btn = document.createElementNS(NS, 'circle');
    btn.setAttribute('class', 'seg-btn');
    btn.setAttribute('cx', tx);
    btn.setAttribute('cy', ty);
    btn.setAttribute('r', BTN_R);
    btn.setAttribute('fill', 'url(#seg-grad-btn-' + item.action + ')');
    g.appendChild(btn);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('class', 'seg-icon');
    text.setAttribute('x', tx);
    text.setAttribute('y', ty);
    text.textContent = item.icon;
    g.appendChild(text);

    const [lx, ly] = polar(LABEL_R, mid);
    let rot = mid + 90;
    if (rot > 90 && rot <= 270) rot -= 180;
    const lg = document.createElementNS(NS, 'g');
    lg.setAttribute('class', 'seg-label-wrap');
    lg.setAttribute('transform', 'rotate(' + rot + ' ' + lx + ' ' + ly + ')');
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('class', 'seg-label');
    label.setAttribute('x', lx);
    label.setAttribute('y', ly);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = item.label;
    lg.appendChild(label);
    g.appendChild(lg);

    svg.appendChild(g);
  });
}

function toggleRadialMenu() {
  radialOpen = !radialOpen;
  const menu = document.getElementById('radial-menu');
  if (radialOpen) {
    // Position the ring centered on the launcher button.
    const launcher = document.getElementById('browser-launcher');
    if (launcher) {
      const r = launcher.getBoundingClientRect();
      menu.style.left = (r.left + r.width / 2) + 'px';
      menu.style.top = (r.top + r.height / 2) + 'px';
    }
    menu.classList.add('open');
    clearRingHover();
    closeAllPopups();
  } else {
    menu.classList.remove('open');
    clearRingHover();
  }
  sendInteractiveBounds();
}

function closeRadialMenu() {
  if (!radialOpen) return;
  radialOpen = false;
  document.getElementById('radial-menu').classList.remove('open');
  clearRingHover();
  sendInteractiveBounds();
}

function closeAllPopups() {
  infoPopup.classList.add('popup-hidden');
  settingsPanel.classList.add('panel-hidden');
  vaultPanel.classList.add('popup-hidden');
  notesPanel.classList.add('panel-hidden');
  categoriesPanel.classList.add('panel-hidden');
  focusPanel.classList.add('popup-hidden');
  closeThemePalette();
  // The ring opens above everything — the add/edit modal must not stay
  // behind its backdrop (it would cover the ring and eat its clicks).
  hideAddTaskModal();
}

// Ring segment handlers (delegated — segments are built dynamically)
const ringSegments = document.getElementById('ring-segments');

// Hit-test a screen point against the ring by polar angle.
function ringHitTest(x, y) {
  const r = ringSegments.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dist = Math.hypot(x - cx, y - cy);
  const scale = r.width / 280;
  if (dist < 86 * scale || dist > 146 * scale) return -1;
  let ang = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
  ang = (ang + 90 + 360) % 360; // 0° = top of ring, going clockwise
  const step = 360 / RING_ACTIONS.length;
  return Math.min(RING_ACTIONS.length - 1, Math.floor(ang / step));
}

function clearRingHover() {
  if (!ringSegments) return;
  ringSegments.querySelectorAll('.ring-seg.hovered').forEach((s) => s.classList.remove('hovered'));
}

if (ringSegments) {
  // JS-driven hover: highlight the segment under the cursor so the pop-out,
  // glow and label never flicker as the wedge itself moves outward.
  ringSegments.addEventListener('mousemove', (e) => {
    const idx = ringHitTest(e.clientX, e.clientY);
    clearRingHover();
    if (idx < 0) return;
    const segs = ringSegments.querySelectorAll('.ring-seg');
    if (segs[idx]) segs[idx].classList.add('hovered');
  });
  ringSegments.addEventListener('mouseleave', clearRingHover);

  ringSegments.addEventListener('click', (e) => {
    let seg = e.target.closest('.ring-seg');
    let action = seg && seg.dataset.action;
    if (!action) { // a popped wedge may have moved off the cursor — hit-test by angle
      const idx = ringHitTest(e.clientX, e.clientY);
      if (idx >= 0) {
        const segs = ringSegments.querySelectorAll('.ring-seg');
        if (segs[idx]) action = segs[idx].dataset.action;
      }
    }
    if (!action) return;
    closeRadialMenu();
    switch (action) {
      case 'info':
        toggleInfoPopup();
        break;
      case 'clipboard':
        openClipboardVault();
        break;
      case 'notes':
        api.openNotesPanel();
        break;
      case 'tasks':
        showPlanner();
        break;
      case 'focus':
        openFocusPanel();
        break;
      case 'calendar':
        setAppView('calendar');
        break;
      case 'week':
        api.setMode('week');
        break;
      case 'screenshot':
        api.openScreenshotOverlay();
        break;
      case 'settings':
        openSettingsPanel();
        break;
    }
  });
}

// === Clipboard Vault ===
function openClipboardVault() {
  vaultPanel.classList.remove('popup-hidden');
  infoPopup.classList.add('popup-hidden');
  settingsPanel.classList.add('panel-hidden');
  notesPanel.classList.add('panel-hidden');
  refreshVault();
  sendInteractiveBounds();
}

function closeClipboardVault() {
  vaultPanel.classList.add('popup-hidden');
  sendInteractiveBounds();
}

async function refreshVault() {
  const items = await api.getClipboardHistory();
  renderVault(items);
}

function renderVault(items) {
  const list = document.getElementById('vault-list');
  list.innerHTML = '';
  if (!items || !items.length) {
    list.innerHTML = '<div class="vault-empty">Nothing copied yet — copy something! 📋</div>';
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'vault-item';

    const txt = document.createElement('span');
    txt.className = 'vault-text';
    txt.textContent = item.text;
    txt.title = item.text;

    const meta = document.createElement('span');
    meta.className = 'vault-meta';
    meta.textContent = timeAgo(item.time);

    const del = document.createElement('button');
    del.className = 'vault-del';
    del.textContent = '✕';
    del.title = 'Remove from history';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      api.deleteClipboardItem(item.text);
    });

    row.append(txt, meta, del);
    row.addEventListener('click', () => copyHistoryItem(item.text));
    list.appendChild(row);
  });
}

function copyHistoryItem(text) {
  api.writeClipboard(text).then(() => showToast('Copied to clipboard! 📋'));
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

document.getElementById('vault-close').addEventListener('click', (e) => { e.stopPropagation(); closeClipboardVault(); });
document.getElementById('vault-clear').addEventListener('click', (e) => {
  e.stopPropagation();
  api.clearClipboardHistory();
  refreshVault();
  showToast('Clipboard history cleared 🧹');
});

// === Quick Notes (browser fallback panel) ===
function loadNotes() {
  try { return JSON.parse(localStorage.getItem('wolf-notes')) || []; } catch (e) { return []; }
}
function saveNotes() { localStorage.setItem('wolf-notes', JSON.stringify(notes)); }

function openNotesPanel() {
  notesPanel.classList.remove('panel-hidden');
  infoPopup.classList.add('popup-hidden');
  settingsPanel.classList.add('panel-hidden');
  vaultPanel.classList.add('popup-hidden');
  renderNotes();
  sendInteractiveBounds();
}

function closeNotesPanel() {
  notesPanel.classList.add('panel-hidden');
  sendInteractiveBounds();
}

// id of the note being edited (null = composing a brand-new note).
let notesEditingId = null;

function notesSaveLabel() {
  const btn = document.getElementById('notes-save');
  if (btn) btn.textContent = notesEditingId !== null ? 'Update note ✏️' : 'Save note';
}

function saveCurrentNote() {
  const input = document.getElementById('notes-input');
  const text = input.value.trim();
  if (!text) { showToast('✍️ Write something first'); return; }
  const wasEditing = notesEditingId !== null;
  if (wasEditing) {
    const n = notes.find(x => x.id === notesEditingId);
    if (n) { n.text = text; n.time = Date.now(); }
    notesEditingId = null;
  } else {
    notes.unshift({ id: Date.now(), text, time: Date.now() });
    notes = notes.slice(0, 50);
  }
  saveNotes();
  input.value = '';
  notesSaveLabel();
  renderNotes();
  showToast(wasEditing ? 'Note updated 📝' : 'Note saved 📝');
}

function renderNotes() {
  const list = document.getElementById('notes-list');
  list.innerHTML = '';
  if (!notes.length) {
    list.innerHTML = '<div class="vault-empty">No notes yet — jot something down!</div>';
    return;
  }
  notes.forEach(n => {
    const row = document.createElement('div');
    row.className = 'note-item';

    const txt = document.createElement('span');
    txt.className = 'note-text';
    txt.textContent = n.text;
    txt.title = 'Click to edit';

    const meta = document.createElement('span');
    meta.className = 'vault-meta';
    meta.textContent = timeAgo(n.time);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'note-act';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy note';
    copyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      api.writeClipboard(n.text).then(() => showToast('Copied 📋'));
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'note-act';
    delBtn.textContent = '🗑️';
    delBtn.title = 'Delete note';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      notes = notes.filter(x => x.id !== n.id);
      if (notesEditingId === n.id) { notesEditingId = null; notesSaveLabel(); }
      saveNotes();
      renderNotes();
    });

    row.append(txt, meta, copyBtn, delBtn);
    // Click a saved note to edit it in place — loading it into the textarea
    // and saving updates that same note (no duplicate).
    row.addEventListener('click', () => {
      notesEditingId = n.id;
      const input = document.getElementById('notes-input');
      input.value = n.text;
      notesSaveLabel();
      renderNotes(); // re-highlight the note being edited
      input.focus();
    });
    if (n.id === notesEditingId) row.classList.add('editing');
    list.appendChild(row);
  });
}

document.getElementById('notes-save').addEventListener('click', (e) => { e.stopPropagation(); saveCurrentNote(); });
document.getElementById('notes-close').addEventListener('click', (e) => { e.stopPropagation(); closeNotesPanel(); });

// === Categories sidebar (slide-in from the left) ===
const CATEGORY_PALETTE = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#f97316'];

function categoryOf(id) { return categories.find(c => c.id === id) || null; }

function openCategoriesPanel() {
  categoriesPanel.classList.remove('panel-hidden');
  renderCategories();
  sendInteractiveBounds();
}

function closeCategoriesPanel() {
  categoriesPanel.classList.add('panel-hidden');
  sendInteractiveBounds();
  // If the add/edit modal is open, refresh its chips to match any changes.
  const modal = document.getElementById('task-modal');
  if (modal && !modal.hidden && imMode === 'task') buildCatChips();
}

function renderCategories() {
  const list = document.getElementById('categories-list');
  list.innerHTML = '';
  if (!categories.length) {
    list.innerHTML = '<div class="cat-empty">No categories yet — add one! 🗂</div>';
    return;
  }
  categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.style.setProperty('--cat-color', cat.color);

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'cat-color-input';
    swatch.value = cat.color;
    swatch.title = 'Change color';
    swatch.addEventListener('change', () => {
      cat.color = swatch.value;
      saveCategories();
      refreshCategoryUI();
    });

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'cat-name';
    name.value = cat.name;
    name.maxLength = 20;
    name.title = 'Rename';
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (v) cat.name = v; else name.value = cat.name;
      saveCategories();
      refreshCategoryUI();
    });

    const count = document.createElement('span');
    count.className = 'cat-count';
    count.textContent = String(tasks.filter(t => t.category === cat.id).length);

    const del = document.createElement('button');
    del.className = 'cat-del';
    del.textContent = '🗑';
    del.title = 'Delete category';
    del.addEventListener('click', () => deleteCategory(cat.id));

    row.append(swatch, name, count, del);
    list.appendChild(row);
  });
}

function addCategory() {
  const cat = {
    id: 'cat-' + Date.now(),
    name: 'New category',
    color: CATEGORY_PALETTE[categories.length % CATEGORY_PALETTE.length],
  };
  categories.push(cat);
  saveCategories();
  renderCategories();
  // Select the new row's name so renaming is one keystroke.
  const list = document.getElementById('categories-list');
  const input = list.querySelector('.cat-row:last-child .cat-name');
  if (input) { input.focus(); input.select(); }
  refreshCategoryUI();
}

function deleteCategory(id) {
  categories = categories.filter(c => c.id !== id);
  // Never save a task against a category that no longer exists.
  if (imCategory === id) imCategory = '';
  let changed = false;
  tasks.forEach(t => {
    if (t.category === id) { t.category = ''; changed = true; }
  });
  saveCategories();
  if (changed) saveTasks();
  renderCategories();
  refreshCategoryUI();
  showToast('🗂 Category deleted');
}

// Re-render anything showing category colors after a category change.
function refreshCategoryUI() {
  renderTasks();
  if (!categoriesPanel.classList.contains('panel-hidden')) renderCategories();
}

document.getElementById('theme-open').addEventListener('click', (e) => {
  e.stopPropagation();
  // Toggle: a second click closes the palette.
  if (document.getElementById('theme-palette').classList.contains('palette-hidden')) openThemePalette();
  else closeThemePalette();
});
// Clicking anywhere else in the planner dismisses the palette (the palette's
// own buttons stop propagation).
tasksPanel.addEventListener('click', (e) => {
  if (e.target.closest('#theme-palette')) return;
  closeThemePalette();
});
document.getElementById('categories-open').addEventListener('click', (e) => { e.stopPropagation(); openCategoriesPanel(); });
document.getElementById('categories-close').addEventListener('click', (e) => { e.stopPropagation(); closeCategoriesPanel(); });
document.getElementById('categories-add').addEventListener('click', (e) => { e.stopPropagation(); addCategory(); });

// The planner is always visible in the sidebar; these just toggle its glass.
function showPlanner() {
  tasksPanel.classList.remove('panel-hidden');
  renderDeadlines();
  renderTasks();
  sendInteractiveBounds();
}

function hidePlanner() {
  tasksPanel.classList.add('panel-hidden');
  closeThemePalette();
  hideAddTaskModal();
  sendInteractiveBounds();
}

// === Planner: Deadlines (top half) + Daily Tasks (bottom half) ===
function loadTasks() {
  try {
    const arr = JSON.parse(localStorage.getItem('wolf-tasks')) || [];
    return arr.map(t => Object.assign({ category: '', progressMin: 0 }, t));
  } catch (e) { return []; }
}
function saveTasks() { localStorage.setItem('wolf-tasks', JSON.stringify(tasks)); }

function loadDeadlines() {
  try { return JSON.parse(localStorage.getItem('wolf-deadlines')) || []; } catch (e) { return []; }
}
function saveDeadlines() { localStorage.setItem('wolf-deadlines', JSON.stringify(deadlines)); }

// === Categories (color-coded task tags, managed from the sidebar) ===
function loadCategories() {
  // Defaults are seeded ONLY when nothing was stored before — an explicit
  // empty array (user deleted every category) must stay empty.
  try {
    const raw = localStorage.getItem('wolf-categories');
    if (raw !== null) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) { /* fall through to defaults */ }
  return [
    { id: 'school', name: 'School', color: '#60a5fa' },
    { id: 'work', name: 'Work', color: '#34d399' },
    { id: 'workout', name: 'Workout', color: '#f472b6' },
  ];
}
function saveCategories() { localStorage.setItem('wolf-categories', JSON.stringify(categories)); }

// Migrate the legacy task shape (estimateMin/workedMin) → durationMin.
function migrateTasks() {
  let changed = false;
  tasks = tasks.map(t => {
    if (typeof t.durationMin === 'number') return t;
    changed = true;
    return {
      id: t.id,
      name: t.name,
      due: t.due || '',
      durationMin: t.estimateMin || 60,
      done: !!t.done,
      completedAt: t.done ? Date.now() : undefined,
      progressMin: 0,
    };
  });
  if (changed) saveTasks();
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const fmtMin = (m) => {
  m = Math.round(m);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), r = m % 60;
  return h + 'h' + (r ? ' ' + r + 'm' : '');
};
const parseDateKey = (key) => {
  if (!key) return null;
  const p = String(key).split('-').map(Number);
  let d;
  if (p.length === 3 && p.every(Number.isFinite)) {
    d = new Date(p[0], p[1] - 1, p[2]);
  } else {
    // Fallback for legacy formats (e.g. '8/6/2026') so such items still get
    // their date parsed — otherwise they'd look undated and never expire.
    const m = String(key).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    d = m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : new Date(key);
  }
  return isNaN(d) ? null : d;
};
const fmtDateShort = (key) => {
  // Compact M/D format — 8/6, not "Aug 6" — so rows stay short and scannable.
  const d = parseDateKey(key);
  return d ? (d.getMonth() + 1) + '/' + d.getDate() : 'no date';
};
const dueTs = (dl) => {
  const d = parseDateKey(dl.due);
  if (!d) return Infinity;
  const parts = (dl.time || '23:59').split(':');
  d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
  return d.getTime();
};
const fmtTimeOfDay = (time) => {
  if (!time) return '';
  const d = new Date('2000-01-01T' + time);
  return isNaN(d) ? time : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// How far back past days stay viewable (calendar / week / past-day views show
// their items crossed out as completed). Items whose day falls outside this
// window are pruned so storage never grows without bound.
const PAST_RETENTION_MS = 90 * 86400000;

// Retention pruning for tasks: dated items are kept while their day is within
// the retention window (past days stay viewable, crossed out); undated items
// are kept forever unless finished, in which case a completion window applies.
function pruneExpiredTasks() {
  const cutoff = Date.now() - PAST_RETENTION_MS;
  const before = tasks.length;
  tasks = tasks.filter(t => {
    const d = parseDateKey(t.due);
    if (!d) return !t.done || (t.completedAt || 0) >= cutoff;
    return d.getTime() >= cutoff;
  });
  if (tasks.length !== before) saveTasks();
}

// === Expired deadline cleanup ===
// Deadlines are retained while their day is within the past-retention window
// (past days stay viewable in the calendar/week, crossed out); older ones are
// pruned. The planner list itself only ever shows today + future. Undated
// deadlines never expire.
function pruneExpiredDeadlines() {
  const cutoff = Date.now() - PAST_RETENTION_MS;
  const before = deadlines.length;
  deadlines = deadlines.filter(dl => {
    const ts = dueTs(dl);
    return ts === Infinity || ts >= cutoff;
  });
  if (deadlines.length !== before) {
    saveDeadlines();
    // Drop reminder records for everything that got pruned.
    const ids = new Set(deadlines.map(d => String(d.id)));
    let changed = false;
    Object.keys(reminderState).forEach(id => {
      if (!ids.has(id)) { delete reminderState[id]; changed = true; }
    });
    if (changed) saveReminderState(reminderState);
  }
}

// === Deadlines ===
function renderDeadlines() {
  pruneExpiredDeadlines();
  const list = document.getElementById('deadlines-list');
  list.innerHTML = '';
  // The planner list only shows today + future — past days are history and
  // are viewed crossed out in the calendar / week views instead.
  const todayStart = todayStartMs();
  const visible = deadlines.filter(dl => {
    const ts = dueTs(dl);
    return ts === Infinity || ts >= todayStart;
  });
  if (!visible.length) {
    list.innerHTML = '<div class="section-empty">No deadlines yet — add one! ⏰</div>';
    return;
  }
  // Closest to the deadline first (overdue = closest); finished deadlines
  // keep the spot they were in (they don't sink to the bottom).
  const sorted = [...visible].sort((a, b) => {
    const d = dueTs(a) - dueTs(b);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  sorted.forEach(dl => list.appendChild(buildDeadlineRow(dl)));
}

// Compact "clock" chip: how long until the deadline — (5m) (2h) (1d) (3d).
// Colored by urgency; "Overdue" pulses red.
function relativeDue(dl) {
  const ts = dueTs(dl);
  if (ts === Infinity) return { text: '', cls: '' };
  const diff = ts - Date.now();
  if (diff <= 0) return { text: 'Overdue', cls: 'past' };
  const m = Math.max(1, Math.round(diff / 60000));
  if (m < 60) return { text: '(' + m + 'm)', cls: m <= 30 ? 'soon' : '' };
  const h = Math.max(1, Math.round(m / 60));
  if (h < 24) return { text: '(' + h + 'h)', cls: h <= 6 ? 'soon' : '' };
  const d = Math.max(1, Math.round(h / 24));
  return { text: '(' + d + 'd)', cls: d <= 1 ? 'today' : d === 2 ? 'close' : '' };
}

// One clean compact line: [check] [name] [date · time] [(1d)] [edit] [delete]
// opts.past: the item's day has passed → rendered crossed out as completed.
// opts.historic: read-only history row (calendar past days) — the check is
// inert and the edit/delete actions are hidden.
function buildDeadlineRow(dl, opts = {}) {
  const past = !!opts.past;
  const historic = !!opts.historic;
  const done = !!dl.done || past;
  const row = document.createElement('div');
  row.className = 'item-row' + (done ? ' done' : '') + (past ? ' past-day' : '');
  wireRowHover(row, dl, 'deadline');
  const check = document.createElement('button');
  check.className = 'item-check';
  check.textContent = done ? '✓' : '';
  check.title = historic ? 'Past day — completed' : (dl.done ? 'Reopen deadline' : 'Mark deadline done');
  if (historic) check.disabled = true;
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    if (historic) return;
    if (dl.done) reopenDeadline(dl.id); else completeDeadline(dl.id);
  });
  const name = document.createElement('span');
  name.className = 'item-name'; name.textContent = dl.name; name.title = dl.name;
  const chip = document.createElement('span');
  chip.className = 'item-chip';
  const t = fmtTimeOfDay(dl.time);
  chip.textContent = fmtDateShort(dl.due) + (t ? ' · ' + t : '');
  const due = relativeDue(dl);
  const dueEl = document.createElement('span');
  dueEl.className = 'due-chip' + (done ? ' done' : due.cls ? ' ' + due.cls : '');
  dueEl.textContent = done ? 'Done' : (due.text || '—');
  row.append(check, name, chip, dueEl);
  if (!historic) {
    const edit = document.createElement('button');
    edit.className = 'item-act'; edit.textContent = '✎'; edit.title = 'Edit deadline';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openItemModal('deadline', dl.id); });
    const del = document.createElement('button');
    del.className = 'item-act del'; del.textContent = '🗑'; del.title = 'Delete deadline';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteDeadline(dl.id); });
    row.append(edit, del);
  }
  return row;
}

function completeDeadline(id) {
  const dl = deadlines.find(x => x.id === id);
  if (!dl || dl.done) return;
  dl.done = true;
  dl.completedAt = Date.now();
  saveDeadlines();
  renderDeadlines();
  refreshActiveView();
  bumpStreak(); // finishing any deadline counts toward today's streak
  showToast('✅ "' + dl.name + '" done!');
}
function reopenDeadline(id) {
  const dl = deadlines.find(x => x.id === id);
  if (!dl) return;
  dl.done = false;
  saveDeadlines();
  renderDeadlines();
  refreshActiveView();
}
function deleteDeadline(id) {
  deadlines = deadlines.filter(x => x.id !== id);
  // Drop its reminder record so a re-added deadline re-arms from scratch.
  if (reminderState[id]) { delete reminderState[id]; saveReminderState(reminderState); }
  saveDeadlines();
  renderDeadlines();
  refreshActiveView();
  showToast('🗑 Deadline removed');
}

// === Daily Tasks ===
function renderTasks() {
  pruneExpiredTasks();
  const list = document.getElementById('tasks-list');
  list.innerHTML = '';
  const todayStart = todayStartMs();
  const windowStart = todayStart - taskFilter * 86400000;
  const windowEnd = todayStart + taskFilter * 86400000;
  // True when a task's day has already passed (works for YYYY-MM-DD keys AND
  // legacy formats like '8/6/2026'; empty/undated keys are never "past").
  const isPastDay = (key) => {
    if (!key) return false;
    const d = parseDateKey(key);
    return !!d && d.getTime() < todayStart;
  };
  const visible = tasks.filter(t => {
    if (t.due) {
      const ts = parseDateKey(t.due);
      if (ts) {
        const ms = ts.getTime();
        // Only days inside the selected window (past days included) show —
        // anything older is history, viewed in the calendar instead.
        if (ms >= windowStart && ms <= windowEnd) return true;
        // Recently completed tasks keep showing even when their due day fell
        // outside the window (e.g. finished early for a far-off day).
        return !!(t.done && (t.completedAt || 0) >= windowStart);
      }
    }
    // Undated tasks: unfinished always show; finished only if completed
    // recently (they have no day to pin them to).
    return t.done ? (t.completedAt || 0) >= windowStart : true;
  });
  if (!visible.length) {
    list.innerHTML = '<div class="section-empty">No tasks in this view — add one! 🎯</div>';
    return;
  }
  // Soonest day first; within a day the longer tasks sit on top. Finished
  // tasks keep their sorted spot (they don't sink to the bottom).
  const sorted = [...visible].sort((a, b) => {
    const da = a.due || '9999-99-99', db = b.due || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return (b.durationMin || 0) - (a.durationMin || 0);
  });
  // Faint dividing line between each day; past days show their items crossed
  // out (completed) instead of an "Overdue" label.
  let lastDay = null;
  sorted.forEach(t => {
    const key = t.due || '';
    if (key && key !== lastDay) {
      list.appendChild(buildDayDivider(key));
      lastDay = key;
    }
    list.appendChild(buildTaskRow(t, { past: isPastDay(key) }));
  });
  renderFocusTasks(); // keep the focus-timer task dropdown in sync
  renderDailyProgress();
  renderFocusMini();
}

// === Daily progress (very top of the planner) ===
// A single bar over ALL of today's tasks, weighted by time: each task
// contributes its duration, and the filled part is progressMin (capped).
// Done tasks count as fully complete. Includes the live focus-session delta
// so the bar visibly creeps up while a focus timer runs.
function dailyProgress() {
  const today = dayKey(new Date());
  let filled = 0, total = 0;
  tasks.forEach((t) => {
    // Today's tasks: dated today or undated (daily). Also count tasks that
    // were finished today even if their due day was earlier.
    const dueIsToday = !t.due || t.due === today;
    const completedToday = !!t.done && (t.completedAt || 0) >= todayStartMs();
    if (!dueIsToday && !completedToday) return;
    const dur = Math.max(1, t.durationMin || 60);
    total += dur;
    filled += t.done ? dur : Math.min(dur, liveProgressMin(t));
  });
  return total ? Math.min(1, filled / total) : 0;
}

function renderDailyProgress() {
  const pctEl = document.getElementById('daily-progress-pct');
  const fillEl = document.getElementById('daily-progress-fill');
  const timeEl = document.getElementById('daily-progress-time');
  if (!pctEl || !fillEl) return;
  const p = dailyProgress();
  pctEl.textContent = Math.round(p * 100) + '%';
  fillEl.style.width = (p * 100) + '%';
  // Sub-line: "Today · 1h 5m of 2h done"
  if (timeEl) {
    const today = dayKey(new Date());
    let filled = 0, total = 0;
    tasks.forEach((t) => {
      const dueIsToday = !t.due || t.due === today;
      const completedToday = !!t.done && (t.completedAt || 0) >= todayStartMs();
      if (!dueIsToday && !completedToday) return;
      const dur = Math.max(1, t.durationMin || 60);
      total += dur;
      filled += t.done ? dur : Math.min(dur, liveProgressMin(t));
    });
    timeEl.textContent = fmtMin(filled) + ' of ' + fmtMin(total);
  }
}

// Live update during a focus session: only touch the focused task's bar and
// the daily bar (no full re-render, so hover states stay intact).
function updateLiveProgressBars() {
  if (!focusTimer.taskId) return;
  const task = tasks.find((t) => String(t.id) === focusTimer.taskId) || {};
  const pct = taskProgressPct(task);
  const fill = document.querySelector('.item-progress-fill[data-fill-task="' + focusTimer.taskId + '"]');
  if (fill) fill.style.width = pct + '%';
  const label = document.querySelector('.item-progress-pct[data-pct-task="' + focusTimer.taskId + '"]');
  if (label) label.textContent = pct + '%';
  renderDailyProgress();
}

// Faint per-day divider label for the 3-day / 1-week task views.
function buildDayDivider(key) {
  const div = document.createElement('div');
  div.className = 'day-divider';
  const label = document.createElement('span');
  label.className = 'day-divider-label';
  label.textContent = dayLabel(key);
  div.appendChild(label);
  return div;
}

function dayLabel(key) {
  const todayKey = dayKey(new Date());
  if (key === todayKey) return 'Today';
  if (key === dayKey(new Date(Date.now() + 86400000))) return 'Tomorrow';
  const d = parseDateKey(key);
  if (!d) return 'No date';
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
}

// A task's progress in minutes: stored progressMin plus the LIVE focus-session
// minutes (so the bar visibly fills while a focus timer runs on this task).
function liveProgressMin(t) {
  let m = Math.max(0, t.progressMin || 0);
  if (
    focusTimer && focusTimer.running &&
    focusTimer.taskId && String(focusTimer.taskId) === String(t.id) &&
    focusTimer.sessionStartAt
  ) {
    m += (Date.now() - focusTimer.sessionStartAt) / 60000;
  }
  return m;
}

function taskProgressPct(t) {
  const dur = Math.max(1, t.durationMin || 60);
  return Math.min(100, Math.round((liveProgressMin(t) / dur) * 100));
}

// Thin time-weighted progress bar under a task row's single line.
function buildTaskProgress(t) {
  const wrap = document.createElement('div');
  wrap.className = 'item-progress';
  wrap.dataset.task = String(t.id);
  const fill = document.createElement('div');
  fill.className = 'item-progress-fill';
  fill.dataset.fillTask = String(t.id);
  fill.style.width = taskProgressPct(t) + '%';
  wrap.appendChild(fill);
  // Tiny % readout at the right end of the line.
  const pct = document.createElement('span');
  pct.className = 'item-progress-pct';
  pct.dataset.pctTask = String(t.id);
  pct.textContent = taskProgressPct(t) + '%';
  wrap.appendChild(pct);
  return wrap;
}

// Compact row: [check] [dot?] [name] [date · duration] [prog?] [edit] [delete]
// + a thin time-weighted progress bar underneath. opts.past: day passed.
// opts.historic: read-only history row (calendar past days).
function buildTaskRow(t, opts = {}) {
  const past = !!opts.past;
  const historic = !!opts.historic;
  const done = !!t.done || past;
  const row = document.createElement('div');
  row.className = 'item-row' + (done ? ' done' : '') + (past ? ' past-day' : '');
  if (!historic && !past) row.classList.add('prog-row');
  // Category accent: colored left border + a small glowing dot.
  const cat = categoryOf(t.category);
  if (cat) {
    row.classList.add('has-cat');
    row.style.setProperty('--cat-color', cat.color);
  }
  const main = document.createElement('div');
  main.className = 'item-row-main';
  const check = document.createElement('button');
  check.className = 'item-check';
  check.textContent = done ? '✓' : '';
  check.title = historic ? 'Past day — completed' : (t.done ? 'Reopen task' : 'Mark task done');
  if (historic) check.disabled = true;
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    if (historic) return;
    if (t.done) reopenTask(t.id); else completeTask(t.id);
  });
  const name = document.createElement('span');
  name.className = 'item-name'; name.textContent = t.name; name.title = t.name;
  const chip = document.createElement('span');
  chip.className = 'item-chip';
  chip.textContent = fmtDateShort(t.due) + ' · ' + fmtMin(t.durationMin);
  const kids = [check];
  if (cat) {
    const dot = document.createElement('span');
    dot.className = 'cat-dot';
    dot.style.background = cat.color;
    dot.title = cat.name;
    kids.push(dot);
  }
  kids.push(name, chip);
  if (!historic) {
    // ⊕ opens a small slider box to set how much time is done — the icon
    // reads as "add to this task's progress", and its hover glow invites it.
    const prog = document.createElement('button');
    prog.className = 'item-act prog'; prog.dataset.task = String(t.id); prog.textContent = '⊕'; prog.title = 'Mark progress';
    prog.addEventListener('click', (e) => { e.stopPropagation(); openProgressPopover(t.id); });
    const focus = document.createElement('button');
    focus.className = 'item-act focus'; focus.textContent = '▶'; focus.title = 'Start focus timer';
    focus.addEventListener('click', (e) => { e.stopPropagation(); openFocusPanel(t.id); });
    const edit = document.createElement('button');
    edit.className = 'item-act'; edit.textContent = '✎'; edit.title = 'Edit task';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openItemModal('task', t.id); });
    const del = document.createElement('button');
    del.className = 'item-act del'; del.textContent = '🗑'; del.title = 'Delete task';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(t.id); });
    kids.push(prog, focus, edit, del);
  }
  main.append(...kids);
  row.append(main);
  // Progress bar underneath (tasks only, not historic/past rows).
  if (!historic && !past) row.append(buildTaskProgress(t));
  wireRowHover(row, t, 'task');
  return row;
}

// Rows scroll under the cursor inside the lists — dismiss any open hover
// card the moment the list scrolls (the anchored position would be stale).
['deadlines-list', 'tasks-list'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('scroll', () => hideHoverCard());
});
function hideHoverCard() {
  if (hasElectron) window.electronAPI.hideHoverCard();
  else hideBrowserHoverCard();
}

// === Mark-progress slider popover ===
// Clicking a task's ▲ opens a small box beside the row: drag the slider to
// pick how much time is done (0 → full duration), then Save commits it.
let progressPopover = null; // { el, taskId }

function buildProgressPopover() {
  const el = document.createElement('div');
  el.id = 'progress-popover';
  el.innerHTML =
    '<div class="pp-head"><span>Mark progress</span><span class="pp-value" id="pp-value">0m</span></div>' +
    '<div class="pp-name" id="pp-name"></div>' +
    '<input type="range" class="pp-slider" id="pp-slider" min="0" max="60" step="1" value="0">' +
    '<div class="pp-meta"><span id="pp-min">0</span><span id="pp-max"></span></div>' +
    '<div class="pp-btns">' +
    '  <button class="btn btn-ghost btn-sm" id="pp-cancel">Cancel</button>' +
    '  <button class="btn btn-primary btn-sm" id="pp-save">Save</button>' +
    '</div>';
  document.body.appendChild(el);
  const slider = el.querySelector('#pp-slider');
  const valueEl = el.querySelector('#pp-value');
  const maxEl = el.querySelector('#pp-max');
  const fmt = (m) => {
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), r = m % 60;
    return h + 'h' + (r ? ' ' + r + 'm' : '');
  };
  slider.addEventListener('input', () => {
    valueEl.textContent = fmt(parseInt(slider.value, 10) || 0);
  });
  el.querySelector('#pp-cancel').addEventListener('click', (e) => {
    e.stopPropagation();
    hideProgressPopover();
  });
  el.querySelector('#pp-save').addEventListener('click', (e) => {
    e.stopPropagation();
    commitProgressPopover();
  });
  return el;
}

// Open the slider box anchored beside the task row (left edge + top, clamped
// inside the window). Also makes the planner window interactive in Electron
// so the slider reliably receives input.
function openProgressPopover(taskId) {
  const t = tasks.find((x) => x.id === taskId);
  if (!t || t.done) return;
  const dur = Math.max(1, t.durationMin || 60);
  const el = progressPopover ? progressPopover.el : buildProgressPopover();
  if (!progressPopover) progressPopover = { el, taskId };
  progressPopover.taskId = taskId;
  const btn = document.querySelector('.item-act.prog[data-task="' + taskId + '"]');
  const rect = btn ? btn.getBoundingClientRect() : { left: 20, top: 20 };
  const w = 210;
  let left = rect.left - w - 8;
  left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
  el.style.left = left + 'px';
  el.style.top = Math.max(6, Math.min(rect.top, window.innerHeight - 160)) + 'px';
  const slider = el.querySelector('#pp-slider');
  slider.min = 0;
  slider.max = String(dur);
  slider.value = String(Math.min(dur, Math.round(t.progressMin || 0)));
  el.querySelector('#pp-name').textContent = t.name;
  el.querySelector('#pp-min').textContent = '0';
  el.querySelector('#pp-max').textContent = fmtMin(dur);
  el.querySelector('#pp-value').textContent = fmtMin(Math.round(t.progressMin || 0));
  el.classList.add('visible');
  // The planner window is click-through in Electron unless over an
  // interactive bound — add the popover's rect so it stays interactive.
  if (hasElectron) sendInteractiveBounds();
}

function commitProgressPopover() {
  if (!progressPopover) return;
  const t = tasks.find((x) => x.id === progressPopover.taskId);
  const slider = progressPopover.el.querySelector('#pp-slider');
  const minutes = parseInt(slider.value, 10) || 0;
  hideProgressPopover();
  if (!t || t.done) return;
  const dur = Math.max(1, t.durationMin || 60);
  t.progressMin = Math.min(dur, Math.max(0, minutes));
  saveTasks();
  if (t.progressMin >= dur) {
    // Slider hit the full duration → auto-complete the task.
    completeTask(t.id);
    return;
  }
  renderTasks();
  renderDailyProgress();
  showToast('▲ "' + t.name + '" is ' + Math.round((t.progressMin / dur) * 100) + '% done');
}

function hideProgressPopover() {
  if (progressPopover) {
    progressPopover.el.classList.remove('visible');
    progressPopover = null;
  }
  if (hasElectron) sendInteractiveBounds();
}

// Close the slider box when clicking anywhere else.
app.addEventListener('click', (e) => {
  if (e.target.closest('#progress-popover')) return;
  hideProgressPopover();
});

// Rest the cursor on a row for ~2s → a detailed card pops up to the LEFT of
// the row (its own window in Electron so it never covers the planner; a
// fixed overlay clamped to the window in the browser preview). Leaving the
// row hides it.
function wireRowHover(row, item, kind) {
  let timer = null;
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    const data = hoverPayload(item, kind);
    const rect = row.getBoundingClientRect();
    if (hasElectron) {
      window.electronAPI.showHoverCard(Object.assign({}, data, {
        rowTop: Math.round(rect.top),
        rowBottom: Math.round(rect.bottom),
      }));
    } else {
      showBrowserHoverCard(data, rect);
    }
  };
  const hide = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!shown) return;
    shown = false;
    if (hasElectron) window.electronAPI.hideHoverCard();
    else hideBrowserHoverCard();
  };
  row.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(show, 2000);
  });
  row.addEventListener('mouseleave', hide);
  row.addEventListener('click', hide);
}

// Structured payload for the hover card (full name, date, time, etc.).
function hoverPayload(item, kind) {
  if (kind === 'deadline') {
    const d = parseDateKey(item.due);
    return {
      kind: 'deadline',
      name: item.name,
      date: d ? d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : 'No date',
      time: fmtTimeOfDay(item.time) || '—',
      duration: null,
      category: null,
      status: item.done ? 'Done' : (dueTs(item) < Date.now() ? 'Overdue' : 'Pending'),
    };
  }
  const t = item;
  const d = parseDateKey(t.due);
  const cat = categoryOf(t.category);
  return {
    kind: 'task',
    name: t.name,
    date: d ? d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : 'No date',
    time: null,
    duration: t.durationMin ? fmtMin(t.durationMin) : '—',
    category: cat ? cat.name : null,
    status: t.done ? 'Done' : (t.due && isPastDayKey(t.due) ? 'Overdue' : 'Pending'),
    progressPct: taskProgressPct(t),
  };
}

function isPastDayKey(key) {
  if (!key) return false;
  const d = parseDateKey(key);
  return !!d && d.getTime() < todayStartMs();
}

// --- Browser-preview hover card (fixed overlay, anchored LEFT of the row) ---
let browserHoverEl = null;
function ensureBrowserHoverCard() {
  if (browserHoverEl) return browserHoverEl;
  const el = document.createElement('div');
  el.id = 'row-hover-card';
  document.body.appendChild(el);
  browserHoverEl = el;
  return el;
}
function showBrowserHoverCard(data, rect) {
  const el = ensureBrowserHoverCard();
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'rhc-title';
  title.textContent = data.name;
  el.appendChild(title);
  const grid = document.createElement('div');
  grid.className = 'rhc-grid';
  const cells = [];
  if (data.date) cells.push(['Date', data.date]);
  if (data.time) cells.push(['Time', data.time]);
  if (data.duration) cells.push(['Duration', data.duration]);
  if (data.category) cells.push(['Category', data.category]);
  cells.push(['Status', data.status]);
  cells.forEach(([k, v]) => {
    const cell = document.createElement('div');
    cell.innerHTML = '<div class="k">' + k + '</div><div class="v">' + v + '</div>';
    grid.appendChild(cell);
  });
  el.appendChild(grid);
  if (typeof data.progressPct === 'number') {
    const bar = document.createElement('div');
    bar.className = 'rhc-bar';
    bar.innerHTML = '<i style="width:' + Math.min(100, Math.max(0, data.progressPct)) + '%"></i>';
    el.appendChild(bar);
  }
  // Anchor: card's right edge just left of the row, clamped to the window.
  const winW = window.innerWidth;
  const w = 292;
  let left = rect.left - w - 8;
  left = Math.max(6, Math.min(left, winW - w - 6));
  el.style.left = left + 'px';
  el.style.top = Math.max(6, Math.min(rect.top, window.innerHeight - 170)) + 'px';
  el.classList.add('visible');
}
function hideBrowserHoverCard() {
  if (browserHoverEl) browserHoverEl.classList.remove('visible');
}

function completeTask(id) {
  const t = tasks.find(x => x.id === id);
  if (!t || t.done) return;
  t.done = true;
  t.completedAt = Date.now();
  t.progressMin = Math.max(t.progressMin || 0, t.durationMin || 0); // fully weighted
  saveTasks();
  renderTasks();
  refreshActiveView();
  bumpStreak(); // finishing any task counts toward today's streak
  showToast('🎉 "' + t.name + '" done!');
}
function reopenTask(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  t.done = false;
  saveTasks();
  renderTasks();
  refreshActiveView();
}
function deleteTask(id) {
  tasks = tasks.filter(x => x.id !== id);
  saveTasks();
  renderTasks();
  refreshActiveView();
  showToast('🗑 Task removed');
}

function setTaskFilter(days) {
  taskFilter = days;
  localStorage.setItem('wolf-task-filter', String(days));
  document.querySelectorAll('#tasks-filter .fchip').forEach(c => c.classList.toggle('active', Number(c.dataset.days) === days));
  renderTasks();
}

// === Add/Edit modal (shared by deadlines + tasks) ===
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW_NAMES = ['Su','Mo','Tu','We','Th','Fr','Sa'];
let tmDate = null;   // selected Date or null
let tmMonth = null;  // calendar month currently shown
let tmHours = 9;     // deadline: 1-12 hour shown on the wheel (AM/PM separate)
let tmMins = 0;
let tmAmPm = 'AM';   // deadline AM/PM picker ('AM' | 'PM')
let imCategory = ''; // selected category id in the task modal

function openItemModal(mode, id) {
  imMode = mode;
  imEditId = id || null;
  const all = mode === 'deadline' ? deadlines : tasks;
  const existing = id ? all.find(x => x.id === id) : null;
  tmDate = existing ? parseDateKey(existing.due) : null;
  tmMonth = new Date((tmDate || new Date()).getFullYear(), (tmDate || new Date()).getMonth(), 1);
  if (existing) {
    if (mode === 'deadline') {
      const parts = (existing.time || '09:00').split(':');
      const h24 = parseInt(parts[0], 10) || 0;
      tmMins = parseInt(parts[1], 10) || 0;
      // 24h (stored) -> 12h + AM/PM (picker)
      tmAmPm = h24 < 12 ? 'AM' : 'PM';
      tmHours = h24 % 12 || 12;
    } else {
      // Clamp to the wheel ranges so an odd stored duration (0m, 30h, 58m)
      // can't silently snap to a different value when the modal opens.
      const totalMin = existing.durationMin || 0;
      tmHours = Math.min(23, Math.floor(totalMin / 60));
      tmMins = Math.min(55, Math.round((totalMin % 60) / 5) * 5);
    }
  } else {
    tmHours = mode === 'deadline' ? 9 : 1;
    tmMins = 0;
    tmAmPm = 'AM';
  }
  document.getElementById('item-modal-title').textContent =
    mode === 'deadline'
      ? (id ? '✏️ Edit Deadline' : '＋ New Deadline')
      : (id ? '✏️ Edit Task' : '＋ New Task');
  document.getElementById('im-time-label').textContent =
    mode === 'deadline' ? '⏰ Due time' : '⏱ Time it takes';
  // Category picker only exists for daily tasks.
  imCategory = existing && existing.category ? existing.category : '';
  document.getElementById('im-cat-label').hidden = mode !== 'task';
  document.getElementById('im-cats').hidden = mode !== 'task';
  // Unhide the modal FIRST so the wheels have real layout when they're
  // built (building them while display:none would clamp scrollTop to 0 and
  // snap the selection to 00:00 regardless of the chosen default).
  document.getElementById('task-modal').hidden = false;
  document.getElementById('im-name').value = existing ? existing.name : '';
  buildCalendar();
  const hWheel = document.getElementById('im-wheel-h');
  const mWheel = document.getElementById('im-wheel-m');
  const apWheel = document.getElementById('im-wheel-ampm');
  if (mode === 'deadline') {
    // Deadlines: 12-hour clock (1-12) + an AM/PM wheel; minutes step by 5.
    apWheel.hidden = false;
    buildWheel(hWheel, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], tmHours, (v) => { tmHours = v; });
    buildWheel(mWheel, wheelValues(5, 60), tmMins, (v) => { tmMins = v; });
    buildWheel(apWheel, ['AM', 'PM'], tmAmPm, (v) => { tmAmPm = v; });
  } else {
    // Tasks: the wheels pick a duration (0-23h), so no AM/PM. Hours step by 1
    // — 0h is a valid option (pair it with minutes, e.g. 0h 30m). The step
    // MUST be 1 here: wheelValues(0, 24) would loop forever (v += 0) and
    // freeze the renderer the moment the modal opens.
    apWheel.hidden = true;
    buildWheel(hWheel, wheelValues(1, 24), tmHours, (v) => { tmHours = v; });
    buildWheel(mWheel, wheelValues(5, 60), tmMins, (v) => { tmMins = v; });
  }
  if (mode === 'task') buildCatChips();
  setTimeout(() => document.getElementById('im-name').focus(), 60);
}

function hideAddTaskModal() {
  const m = document.getElementById('task-modal');
  if (m) m.hidden = true;
}

function saveItemModal() {
  const nameEl = document.getElementById('im-name');
  const name = nameEl.value.trim();
  if (!name) { showToast('✏️ Give it a name'); nameEl.focus(); return; }
  const due = tmDate
    ? tmDate.getFullYear() + '-' + pad2(tmDate.getMonth() + 1) + '-' + pad2(tmDate.getDate())
    : ''; // no date picked = undated item (deadlines show "No date", tasks group as undated)
  if (imMode === 'deadline') {
    // 12h + AM/PM (picker) -> 24h "HH:MM" (stored). 12 AM = 00, 12 PM = 12.
    const h24 = (tmHours % 12) + (tmAmPm === 'PM' ? 12 : 0);
    const time = pad2(h24) + ':' + pad2(tmMins);
    if (imEditId) {
      const dl = deadlines.find(x => x.id === imEditId);
      if (dl) { dl.name = name; dl.due = due; dl.time = time; }
    } else {
      deadlines.unshift({ id: Date.now(), name, due, time, done: false });
    }
    saveDeadlines();
    renderDeadlines();
    refreshActiveView();
    showToast(imEditId ? '✏️ Deadline updated' : '✅ Deadline added');
    tickDeadlineReminders(); // re-arm reminders for the newly saved deadline
  } else {
    const durationMin = tmHours * 60 + tmMins;
    if (durationMin < 1) { showToast('⏱ Add a time estimate'); return; }
    if (imEditId) {
      const t = tasks.find(x => x.id === imEditId);
      if (t) { t.name = name; t.due = due; t.durationMin = durationMin; t.category = imCategory; }
    } else {
      tasks.unshift({ id: Date.now(), name, due, durationMin, done: false, category: imCategory, progressMin: 0 });
    }
    saveTasks();
    renderTasks();
    refreshActiveView();
    showToast(imEditId ? '✏️ Task updated' : '✅ Task added');
  }
  hideAddTaskModal();
}

// Mini calendar grid with prev/next month navigation.
function buildCalendar() {
  const wrap = document.getElementById('tm-calendar');
  const y = tmMonth.getFullYear(), m = tmMonth.getMonth();
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const todayKey = dayKeyNow();
  const isSel = (d, mm) => !!tmDate && tmDate.getFullYear() === y && tmDate.getMonth() === m + mm && tmDate.getDate() === d;
  let html = '<div class="tm-cal-head"><button class="tm-cal-nav" type="button" id="cal-prev">‹</button>' +
    '<span class="tm-cal-title">' + MONTH_NAMES[m] + ' ' + y + '</span>' +
    '<button class="tm-cal-nav" type="button" id="cal-next">›</button></div><div class="tm-cal-grid">';
  DOW_NAMES.forEach((d) => { html += '<span class="tm-cal-dow">' + d + '</span>'; });
  for (let i = 0; i < firstDow; i++) {
    const d = prevDays - firstDow + 1 + i;
    html += '<button class="tm-cal-day other" type="button" data-d="' + d + '" data-m="-1">' + d + '</button>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    html += '<button class="tm-cal-day' + (key === todayKey ? ' today' : '') + (isSel(d, 0) ? ' selected' : '') +
      '" type="button" data-d="' + d + '" data-m="0">' + d + '</button>';
  }
  const trail = 7 - ((firstDow + daysInMonth) % 7 || 7);
  for (let i = 1; i <= trail; i++) {
    html += '<button class="tm-cal-day other" type="button" data-d="' + i + '" data-m="1">' + i + '</button>';
  }
  html += '</div>';
  wrap.innerHTML = html;
  wrap.querySelector('#cal-prev').addEventListener('click', () => { tmMonth = new Date(y, m - 1, 1); buildCalendar(); });
  wrap.querySelector('#cal-next').addEventListener('click', () => { tmMonth = new Date(y, m + 1, 1); buildCalendar(); });
  wrap.querySelectorAll('.tm-cal-day').forEach((b) => {
    b.addEventListener('click', () => {
      tmDate = new Date(y, m + parseInt(b.dataset.m, 10), parseInt(b.dataset.d, 10));
      buildCalendar();
    });
  });
}

// === Calendar view (month grid on top, that day's deadlines + tasks below) ===
// The sidebar's second view mode: a month calendar with red dots on days that
// have deadlines and green dots for tasks. Clicking a day shows everything
// planned for it underneath, reusing the normal row builders.
function setViewSwitch(view) {
  document.querySelectorAll('#view-switch .vs-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

function setAppView(view) {
  appView = view === 'calendar' ? 'calendar' : 'tasks';
  document.body.classList.toggle('view-calendar', appView === 'calendar');
  document.body.classList.remove('view-week');
  setViewSwitch(appView);
  const cv = document.getElementById('calendar-view');
  if (cv) cv.hidden = appView !== 'calendar';
  if (appView === 'calendar') { renderCalendar(); renderCalDayItems(); }
  sendInteractiveBounds();
}

function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  const title = document.getElementById('cal-title');
  if (!grid || !title) return;
  if (!calMonth) calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  if (!calSelectedKey) calSelectedKey = dayKeyNow();
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const todayKey = dayKeyNow();
  title.textContent = MONTH_NAMES[m] + ' ' + y;
  let html = '';
  DOW_NAMES.forEach((d) => { html += '<span class="cal-dow">' + d + '</span>'; });
  const cell = (key, num, extra) => {
    // Days that already passed are treated as completed: no dots, dimmed.
    const past = key < todayKey;
    // Dots mark days with something still to do (finished items don't count).
    const hasDl = !past && deadlines.some(dl => !dl.done && dl.due === key);
    const hasT = !past && tasks.some(t => !t.done && t.due === key);
    const dots = (hasDl ? '<i class="cal-dot dot-dl" title="Deadline"></i>' : '') +
                 (hasT ? '<i class="cal-dot dot-tk" title="Task"></i>' : '');
    return '<button class="cal-day ' + extra + (key === calSelectedKey ? ' sel' : '') + (past ? ' past' : '') + '" data-key="' + key + '" type="button">' +
      '<span class="cal-num">' + num + '</span>' + (dots ? '<span class="cal-dots">' + dots + '</span>' : '') + '</button>';
  };
  for (let i = 0; i < firstDow; i++) {
    const d = prevDays - firstDow + 1 + i;
    const y2 = m === 0 ? y - 1 : y, m2 = m === 0 ? 11 : m - 1;
    html += cell(y2 + '-' + pad2(m2 + 1) + '-' + pad2(d), d, 'other');
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = y + '-' + pad2(m + 1) + '-' + pad2(d);
    html += cell(key, d, key === todayKey ? 'today' : '');
  }
  const trail = 7 - ((firstDow + daysInMonth) % 7 || 7);
  for (let i = 1; i <= trail; i++) {
    const y2 = m === 11 ? y + 1 : y, m2 = m === 11 ? 0 : m + 1;
    html += cell(y2 + '-' + pad2(m2 + 1) + '-' + pad2(i), i, 'other');
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.cal-day').forEach((b) => {
    b.addEventListener('click', () => selectCalDay(b.dataset.key));
  });
}

function selectCalDay(key) {
  calSelectedKey = key;
  renderCalendar();
  renderCalDayItems();
  sendInteractiveBounds();
}

function renderCalDayItems() {
  const title = document.getElementById('cal-day-title');
  const list = document.getElementById('cal-day-list');
  if (!title || !list) return;
  const d = parseDateKey(calSelectedKey);
  // Days that already passed are read-only history: every task and deadline
  // on them is shown crossed out as completed.
  const past = calSelectedKey < dayKeyNow();
  title.textContent = (d
    ? d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    : 'No date') + (past ? ' · past' : '');
  title.classList.toggle('past', past);
  list.innerHTML = '';
  const dls = deadlines.filter(dl => dl.due === calSelectedKey);
  const tks = tasks.filter(t => t.due === calSelectedKey);
  if (!dls.length && !tks.length) {
    list.innerHTML = '<div class="cal-empty">' + (past ? 'Nothing was planned for this day ✨' : 'Nothing planned for this day ✨') + '</div>';
    return;
  }
  dls.forEach(dl => list.appendChild(buildDeadlineRow(dl, { past, historic: past })));
  tks.forEach(t => list.appendChild(buildTaskRow(t, { past, historic: past })));
}

// Re-render the active view after an item changed (the row builders only
// refresh the two-half lists).
function refreshActiveView() {
  if (appView === 'calendar') { renderCalendar(); renderCalDayItems(); }
}

// Category chips inside the task modal (None / School / Work / … / Manage).
function buildCatChips() {
  const wrap = document.getElementById('im-cats');
  wrap.innerHTML = '';
  const mkBase = (id, label, color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cat-chip';
    if (color) {
      b.classList.add('colored');
      b.style.setProperty('--cat-color', color);
    }
    if (imCategory === id) b.classList.add('sel');
    b.textContent = label;
    return b;
  };
  const none = mkBase('', 'None');
  none.addEventListener('click', () => selectChip(none, ''));
  wrap.appendChild(none);
  categories.forEach(c => {
    const b = mkBase(c.id, c.name, c.color);
    b.addEventListener('click', () => selectChip(b, c.id));
    wrap.appendChild(b);
  });
  const manage = mkBase('__manage__', '＋ Manage');
  manage.classList.add('chip-manage');
  manage.addEventListener('click', (e) => {
    e.stopPropagation();
    openCategoriesPanel();
  });
  wrap.appendChild(manage);
}

function selectChip(btn, id) {
  imCategory = id;
  btn.parentElement.querySelectorAll('.cat-chip').forEach(c => c.classList.toggle('sel', c === btn));
}

// Scroll-wheel picker: values step by the given amount (hours +1, mins +5).
function wheelValues(step, max) {
  const out = [];
  for (let v = 0; v < max; v += step) out.push(v);
  return out;
}

function buildWheel(wrapEl, values, selected, onChange) {
  const list = wrapEl.querySelector('.tm-wheel-list');
  const ITEM_H = 34;
  const fmt = (v) => (typeof v === 'number' ? String(v).padStart(2, '0') : String(v));
  const items = values.map((v) =>
    '<div class="tm-wheel-item' + (v === selected ? ' sel' : '') + '" data-v="' + fmt(v) + '">' + fmt(v) + '</div>'
  ).join('');
  list.innerHTML = '<div class="tm-wheel-pad"></div>' + items + '<div class="tm-wheel-pad"></div>';
  const selIdx = values.indexOf(selected);
  const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
  list.scrollTop = Math.max(0, Math.min(maxScroll, selIdx * ITEM_H));
  const apply = () => {
    const idx = Math.max(0, Math.min(values.length - 1, Math.round(list.scrollTop / ITEM_H)));
    onChange(values[idx]);
    list.querySelectorAll('.tm-wheel-item').forEach((el, k) => el.classList.toggle('sel', k === idx));
  };
  // The modal is rebuilt on every open, so these listeners MUST be rebound
  // from scratch each time — otherwise scroll/click handlers stack up on the
  // persistent wheel element and fire dozens of times per interaction.
  if (list._wheelApply) list.removeEventListener('scroll', list._wheelApply);
  list._wheelApply = apply;
  list.addEventListener('scroll', apply, { passive: true });
  if (list._wheelClick) list.removeEventListener('click', list._wheelClick);
  list._wheelClick = (e) => {
    const it = e.target.closest('.tm-wheel-item');
    if (!it) return;
    const v = values.find((x) => fmt(x) === it.dataset.v);
    if (v === undefined) return;
    list.scrollTop = Math.max(0, Math.min(maxScroll, values.indexOf(v) * ITEM_H));
    apply();
  };
  list.addEventListener('click', list._wheelClick);
  wrapEl.querySelectorAll('.tm-wheel-btn').forEach((btn) => {
    if (btn._wheelBtn) btn.removeEventListener('click', btn._wheelBtn);
    btn._wheelBtn = () => {
      const dir = parseInt(btn.dataset.dir, 10);
      list.scrollTop = Math.max(0, Math.min(maxScroll, list.scrollTop + dir * ITEM_H));
      apply();
    };
    btn.addEventListener('click', btn._wheelBtn);
  });
  apply();
}

// === Planner UI wiring ===
document.getElementById('tasks-hide').addEventListener('click', (e) => { e.stopPropagation(); hidePlanner(); });
// View switcher: 🎯 tasks / 📅 calendar / 📆 week (week runs in its own
// top-of-screen window — main.js hides this sidebar while it's active).
document.querySelectorAll('#view-switch .vs-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    api.setMode(btn.dataset.view);
  });
});
// Calendar month navigation.
document.getElementById('cal-prev').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!calMonth) calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
  renderCalendar();
});
document.getElementById('cal-next').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!calMonth) calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
  renderCalendar();
});
document.getElementById('deadline-add').addEventListener('click', (e) => { e.stopPropagation(); openItemModal('deadline'); });
document.getElementById('task-add').addEventListener('click', (e) => { e.stopPropagation(); openItemModal('task'); });
document.getElementById('tasks-filter').addEventListener('click', (e) => {
  const chip = e.target.closest('.fchip');
  if (chip) setTaskFilter(Number(chip.dataset.days));
});
document.getElementById('task-modal-close').addEventListener('click', (e) => { e.stopPropagation(); hideAddTaskModal(); });
document.getElementById('im-save').addEventListener('click', (e) => { e.stopPropagation(); saveItemModal(); });
// "No date" button: clears the selected date so the item can be saved undated.
document.getElementById('im-none').addEventListener('click', (e) => {
  e.stopPropagation();
  tmDate = null;
  buildCalendar();
});
document.getElementById('im-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveItemModal(); });
const taskModalEl = document.getElementById('task-modal');
if (taskModalEl) taskModalEl.addEventListener('click', (e) => {
  if (e.target === taskModalEl) {
    // Clicking the dimmed backdrop: first close the categories sidebar if it
    // is open over the modal, otherwise dismiss the modal.
    if (!categoriesPanel.classList.contains('panel-hidden')) {
      closeCategoriesPanel();
      return;
    }
    hideAddTaskModal();
  }
});

// Escape closes the topmost overlay first (categories sidebar, then modal).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!categoriesPanel.classList.contains('panel-hidden')) {
    closeCategoriesPanel();
    return;
  }
  if (!document.getElementById('task-modal').hidden) hideAddTaskModal();
});

// Ctrl/Cmd+Shift+S = sleep/wake: hide the planner (and the app chrome) from
// the screen, then summon it back. In Electron the main process's global
// shortcut usually consumes the combo before this runs; this keeps the
// browser preview working and acts as a safety net if the global hook failed.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'S' || e.key === 's') && !e.altKey) {
    e.preventDefault();
    api.toggleSleep();
  }
});

// === Toast ===
function showToast(msg, cls, ms) {
  const toast = document.createElement('div');
  toast.className = 'toast' + (cls ? ' ' + cls : '');
  toast.textContent = msg;
  document.body.appendChild(toast); requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, ms || 2000);
}

// === Deadline reminders + daily streak ===
// Reminder plan: toasts at 30 / 20 / 10 / 5 minutes before a deadline, then a
// full-screen animated alert at the due moment that must be acknowledged with
// a checkbox. Each milestone fires ONCE per deadline (persisted, so restarts
// don't re-fire); acknowledging the alert clears the record.
const REMINDER_MILESTONES = [30, 20, 10, 5];
let reminderState = loadReminderState();

function loadReminderState() {
  try { return JSON.parse(localStorage.getItem('wolf-reminders')) || {}; } catch (e) { return {}; }
}
function saveReminderState(s) { localStorage.setItem('wolf-reminders', JSON.stringify(s)); }

function tickDeadlineReminders() {
  const now = Date.now();
  let changed = false;
  deadlines.forEach((dl) => {
    if (dl.done) return; // finished deadlines never remind
    const ts = dueTs(dl);
    if (ts === Infinity) return; // undated deadlines have no reminder
    const minsLeft = Math.ceil((ts - now) / 60000);
    const rec = reminderState[dl.id] || (reminderState[dl.id] = { milestones: {}, alerted: false });
    const time = fmtTimeOfDay(dl.time);
    if (minsLeft > 0) {
      const milestone = REMINDER_MILESTONES.find((m, i) =>
        !rec.milestones[m] && minsLeft <= m && minsLeft > (REMINDER_MILESTONES[i + 1] || 0));
      if (milestone !== undefined) {
        rec.milestones[milestone] = true;
        changed = true;
        const urgent = milestone === 5;
        const label = time ? ' (' + time + ')' : '';
        showToast(
          '⏰ "' + dl.name + '" due in ' + Math.max(1, minsLeft) + ' min' + label + (urgent ? ' — GO NOW!' : ''),
          urgent ? 'toast-warn' : 'toast-alert',
          urgent ? 5000 : 3200
        );
      }
    }
  });
  // Due (or overdue within 10 min): collect them all, then show ONE
  // full-screen alert listing the first + a count of the rest. Each gets its
  // record flagged so they never re-alert; acknowledging clears them all.
  const dueNow = [];
  deadlines.forEach((dl) => {
    if (dl.done) return;
    const ts = dueTs(dl);
    if (ts === Infinity) return;
    const minsLeft = Math.ceil((ts - Date.now()) / 60000);
    const rec = reminderState[dl.id] || (reminderState[dl.id] = { milestones: {}, alerted: false });
    if (!rec.alerted && minsLeft <= 0 && minsLeft > -10) {
      rec.alerted = true;
      changed = true;
      dueNow.push(dl);
    }
  });
  if (dueNow.length) {
    const first = dueNow[0];
    const name = dueNow.length > 1 ? first.name + ' (+' + (dueNow.length - 1) + ' more)' : first.name;
    api.showDeadlineAlert({ id: first.id, name, time: fmtTimeOfDay(first.time) });
  }
  if (changed) saveReminderState(reminderState);
}

// === Daily streak (consecutive days with at least one completed item) ===
// State: { last, count } — last = day key of the most recent counted day.
function loadStreak() {
  try { return JSON.parse(localStorage.getItem('wolf-streak')) || { last: '', count: 0 }; } catch (e) { return { last: '', count: 0 }; }
}
let streak = loadStreak();

// A streak whose last counted day was more than a day ago is broken — the
// chip reads 0 until the next completion starts a new one.
function validateStreak() {
  if (!streak.last) return;
  const today = dayKeyNow();
  // Calendar-accurate "yesterday" (setDate, not a ms subtraction — the latter
  // can land on the same calendar day across a DST transition).
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yesterday = dayKey(yd);
  if (streak.last !== today && streak.last !== yesterday) {
    streak.last = '';
    streak.count = 0;
    localStorage.setItem('wolf-streak', JSON.stringify(streak));
  }
}

function bumpStreak() {
  const today = dayKeyNow();
  if (streak.last === today) { renderStreak(); return; }
  const y = new Date(); y.setDate(y.getDate() - 1);
  // Consecutive day -> grow the streak; a gap resets it to 1.
  streak.count = (streak.last === dayKey(y)) ? (streak.count || 0) + 1 : 1;
  streak.last = today;
  localStorage.setItem('wolf-streak', JSON.stringify(streak));
  renderStreak();
}

function renderStreak() {
  const el = document.getElementById('streak-chip');
  if (!el) return;
  validateStreak();
  const n = streak.count || 0;
  el.textContent = '🔥 ' + n + (n === 1 ? ' day' : ' days');
  el.title = n > 0
    ? (n + (n === 1 ? ' day' : ' days') + ' streak — keep it going! 🔥')
    : 'Complete a task or deadline today to start your streak!';
}

// === Browser Screenshot (fallback when no Electron) ===
function startBrowserScreenshot() {
  let overlay, box, startX, startY;
  overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.25);z-index:99999;cursor:crosshair;';
  box = document.createElement('div');
  box.style.cssText = 'position:absolute;border:2px dashed #fff;background:rgba(255,255,255,0.08);display:none;';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  showToast('Drag to capture region inside the window 📷');

  overlay.addEventListener('mousedown', (e) => { startX = e.clientX; startY = e.clientY; box.style.display = 'block'; });
  overlay.addEventListener('mousemove', (e) => {
    if (!startX) return;
    box.style.left = Math.min(startX, e.clientX) + 'px';
    box.style.top = Math.min(startY, e.clientY) + 'px';
    box.style.width = Math.abs(e.clientX - startX) + 'px';
    box.style.height = Math.abs(e.clientY - startY) + 'px';
  });
  // The overlay div itself never receives focus, so Escape is listened for on
  // the document. Function declarations are hoisted, so the two helpers can
  // reference each other.
  function onOverlayKey(e) { if (e.key === 'Escape') cancelOverlay(); }
  function cancelOverlay() { overlay.remove(); document.removeEventListener('keydown', onOverlayKey); }
  document.addEventListener('keydown', onOverlayKey);
  overlay.addEventListener('mouseup', () => {
    const rect = box.getBoundingClientRect();
    cancelOverlay();
    if (rect.width < 5 || rect.height < 5) { showToast('Selection too small 📷'); return; }
    html2canvasCapture(rect);
  });
}

function html2canvasCapture(rect) {
  const canvas = document.createElement('canvas');
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#faf5ed';
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.font = '14px Comfortaa, sans-serif';
  ctx.fillStyle = '#3a3226';
  ctx.textAlign = 'center';
  ctx.fillText('✨ EZCompanion • Screenshot', rect.width / 2, rect.height / 2 - 10);
  ctx.font = '11px Comfortaa, sans-serif';
  ctx.fillStyle = '#8b7355';
  ctx.fillText(rect.width + '×' + rect.height + 'px', rect.width / 2, rect.height / 2 + 12);
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Screenshot copied to clipboard! 📋');
    } catch (e) {
      showToast('Screenshot captured (' + Math.round(rect.width) + '×' + Math.round(rect.height) + ') 📷 (Full capture needs Electron)');
    }
  });
}

// === Focus session history ===
// Every completed/paused session is recorded so the user can see how much
// focused time each task has accumulated.
let focusHistory = loadFocusHistory();
const FOCUS_HISTORY_KEY = 'wolf-focus-history';
const MAX_HISTORY = 30;

function loadFocusHistory() {
  try { return JSON.parse(localStorage.getItem(FOCUS_HISTORY_KEY)) || []; } catch (e) { return []; }
}
function saveFocusHistory() {
  localStorage.setItem(FOCUS_HISTORY_KEY, JSON.stringify(focusHistory));
}
function recordFocusSession(taskId, minutes) {
  if (!minutes || minutes < 0.5) return;
  const t = tasks.find((x) => String(x.id) === String(taskId));
  focusHistory.unshift({
    id: Date.now() + Math.random(),
    taskId: taskId || '',
    name: t ? t.name : 'Custom session',
    minutes: Math.round(minutes),
    time: Date.now(),
  });
  focusHistory = focusHistory.slice(0, MAX_HISTORY);
  saveFocusHistory();
}

function renderFocusHistory() {
  const wrap = document.getElementById('focus-history');
  const list = document.getElementById('focus-history-list');
  if (!wrap || !list) return;
  if (!focusHistory.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.innerHTML = '';
  focusHistory.slice(0, 8).forEach((s) => {
    const item = document.createElement('div');
    item.className = 'fh-item';
    const name = document.createElement('span');
    name.className = 'fh-name'; name.textContent = s.name; name.title = s.name;
    const min = document.createElement('span');
    min.className = 'fh-min'; min.textContent = fmtMin(s.minutes);
    const when = document.createElement('span');
    when.className = 'fh-when'; when.textContent = timeAgo(s.time);
    item.append(name, min, when);
    list.appendChild(item);
  });
}

// === Focus Timer (select a task, it counts down) ===
// A task-linked countdown: pick a task (or use a custom duration), then
// start/pause/reset. Drift-free — the remaining time comes from wall-clock
// timestamps, so throttled ticks can never slow or speed it up. The timer
// keeps running even while the panel is closed (the ⏱ header button pulses
// and its tooltip shows the time left).
let focusTimer = {
  taskId: '',        // selected task id ('' = custom session)
  totalMs: 25 * 60000,
  remainingMs: 25 * 60000,
  running: false,
  endAt: 0,          // wall-clock timestamp the running session ends at
  sessionStartAt: 0, // wall-clock timestamp this running session began (progress)
  interval: null,
};
let focusBeeper = null; // lazy AudioContext for the completion chime

const focusEl = (id) => document.getElementById(id);

function fmtFocus(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec);
}

function focusTaskName() {
  if (!focusTimer.taskId) return '';
  const t = tasks.find((x) => String(x.id) === focusTimer.taskId);
  return t ? t.name : '';
}

function renderFocusDisplay() {
  const timeEl = focusEl('focus-time');
  const ringEl = focusEl('focus-ring');
  const nameEl = focusEl('focus-task-name');
  if (timeEl) timeEl.textContent = fmtFocus(focusTimer.remainingMs);
  if (ringEl && focusTimer.totalMs > 0) {
    const p = Math.max(0, Math.min(1, focusTimer.remainingMs / focusTimer.totalMs));
    ringEl.style.setProperty('--p', (p * 360).toFixed(1));
  }
  if (nameEl) nameEl.textContent = focusTaskName();
  const openBtn = focusEl('focus-open');
  if (openBtn) {
    openBtn.title = focusTimer.running
      ? 'Focus: ' + fmtFocus(focusTimer.remainingMs) + ' left'
      : 'Focus timer';
  }
  renderFocusMini();
}

// Slim top bar under the planner header: shows the focused task + the
// ticking countdown whenever a session is active (running or paused).
function renderFocusMini() {
  const mini = document.getElementById('focus-mini');
  if (!mini) return;
  const active = focusTimer.running ||
    (focusTimer.remainingMs > 0 && focusTimer.remainingMs < focusTimer.totalMs);
  mini.hidden = !active;
  if (!active) return;
  const nameEl = document.getElementById('focus-mini-name');
  const timeEl = document.getElementById('focus-mini-time');
  if (nameEl) nameEl.textContent = focusTaskName() || 'Custom session';
  if (timeEl) timeEl.textContent = fmtFocus(focusTimer.remainingMs) + (focusTimer.running ? '' : ' (paused)');
}

// Commit the elapsed focus time into the focused task's progressMin (capped
// at its duration) and re-render the bars — called on pause/reset/finish so
// focused minutes are weighted into both the row bar and the daily bar.
function commitFocusProgress() {
  if (!focusTimer.taskId || !focusTimer.sessionStartAt) return;
  const t = tasks.find((x) => String(x.id) === String(focusTimer.taskId));
  const elapsed = (Date.now() - focusTimer.sessionStartAt) / 60000;
  focusTimer.sessionStartAt = 0;
  if (!t || t.done || elapsed <= 0) return;
  const dur = Math.max(1, t.durationMin || 60);
  t.progressMin = Math.min(dur, (t.progressMin || 0) + elapsed);
  saveTasks();
  if (t.progressMin >= dur) {
    // Focus filled the task's whole estimate → auto-complete.
    t.done = true;
    t.completedAt = Date.now();
    saveTasks();
    bumpStreak();
    showToast('🎉 "' + t.name + '" completed from focus!', 'toast-focus', 4000);
  }
}

// Rebuild the task dropdown from the live task list (done tasks excluded);
// keeps the currently selected task when the list refreshes mid-session.
function renderFocusTasks() {
  const sel = focusEl('focus-task');
  if (!sel) return;
  const prev = focusTimer.taskId;
  // If the focused task was deleted or completed since, drop the stale id so
  // the dropdown and the session stay in sync.
  const stillExists = !!prev && tasks.some((t) => String(t.id) === prev && !t.done);
  if (!stillExists) focusTimer.taskId = '';
  sel.innerHTML = '<option value="">— Choose a task… —</option>';
  tasks.filter((t) => !t.done).forEach((t) => {
    const o = document.createElement('option');
    o.value = String(t.id);
    o.textContent = t.name + (t.durationMin ? ' (' + fmtMin(t.durationMin) + ')' : '');
    sel.appendChild(o);
  });
  sel.value = stillExists ? prev : '';
}

function openFocusPanel(taskId) {
  if (taskId) focusTimer.taskId = String(taskId);
  renderFocusTasks();
  // Picking a task pre-fills the minutes from its stored duration (only when
  // not running, so a live session is never reset underneath the user).
  if (taskId && !focusTimer.running) {
    const t = tasks.find((x) => String(x.id) === String(taskId));
    if (t && t.durationMin) {
      const m = Math.max(1, Math.min(720, Math.round(t.durationMin)));
      focusEl('focus-minutes').value = m;
      focusTimer.totalMs = m * 60000;
      focusTimer.remainingMs = focusTimer.totalMs;
    }
  }
  infoPopup.classList.add('popup-hidden');
  settingsPanel.classList.add('panel-hidden');
  vaultPanel.classList.add('popup-hidden');
  notesPanel.classList.add('panel-hidden');
  focusPanel.classList.remove('popup-hidden');
  renderFocusDisplay();
  renderFocusHistory();
  sendInteractiveBounds();
}

function closeFocusPanel() {
  focusPanel.classList.add('popup-hidden');
  sendInteractiveBounds();
}

function tickFocus() {
  const left = Math.max(0, focusTimer.endAt - Date.now());
  focusTimer.remainingMs = left;
  renderFocusDisplay();
  // Progress bars creep up in real time while the session runs.
  updateLiveProgressBars();
  if (left <= 0) finishFocus();
}

function startFocus() {
  if (focusTimer.running) return;
  ensureFocusBeeper(); // prime audio on this user gesture so the chime plays
  if (focusTimer.remainingMs <= 0) focusTimer.remainingMs = focusTimer.totalMs;
  focusTimer.running = true;
  focusTimer.endAt = Date.now() + focusTimer.remainingMs;
  focusTimer.sessionStartAt = Date.now();
  focusEl('focus-start').textContent = '❚❚ Pause';
  focusPanel.classList.add('running');
  focusEl('focus-open').classList.add('running');
  tickFocus();
  focusTimer.interval = setInterval(tickFocus, 250);
}

function pauseFocus() {
  if (!focusTimer.running) return;
  focusTimer.running = false;
  focusTimer.remainingMs = Math.max(0, focusTimer.endAt - Date.now());
  clearInterval(focusTimer.interval);
  focusTimer.interval = null;
  const elapsed = (Date.now() - focusTimer.sessionStartAt) / 60000;
  commitFocusProgress();
  recordFocusSession(focusTimer.taskId, elapsed);
  focusEl('focus-start').textContent = '▶ Resume';
  focusPanel.classList.remove('running');
  focusEl('focus-open').classList.remove('running');
  renderFocusDisplay();
  renderTasks(); // rebuild rows so the committed progress shows on the bar
  renderDailyProgress();
  renderFocusHistory();
}

function resetFocus() {
  focusTimer.running = false;
  clearInterval(focusTimer.interval);
  focusTimer.interval = null;
  commitFocusProgress();
  focusTimer.remainingMs = focusTimer.totalMs;
  focusEl('focus-start').textContent = '▶ Start';
  focusPanel.classList.remove('running');
  focusEl('focus-open').classList.remove('running');
  renderFocusDisplay();
  renderTasks();
  renderDailyProgress();
}

function finishFocus() {
  const name = focusTaskName();
  const elapsed = focusTimer.sessionStartAt ? (Date.now() - focusTimer.sessionStartAt) / 60000 : 0;
  focusTimer.running = false;
  clearInterval(focusTimer.interval);
  focusTimer.interval = null;
  commitFocusProgress(); // the focused minutes weight into the task + daily bars
  recordFocusSession(focusTimer.taskId, elapsed);
  focusTimer.remainingMs = 0;
  renderFocusDisplay();
  focusEl('focus-start').textContent = '▶ Start';
  focusPanel.classList.remove('running');
  focusEl('focus-open').classList.remove('running');
  showToast('🎉 ' + (name ? '"' + name + '"' : 'Focus') + ' complete — great work!', 'toast-focus', 5000);
  focusBeep();
  // Flash the progress ring so the completion is unmistakable.
  const ring = focusEl('focus-ring');
  if (ring) {
    ring.classList.add('flash');
    setTimeout(() => ring.classList.remove('flash'), 1300);
  }
  renderTasks();
  renderDailyProgress();
  renderFocusHistory();
}

// Create/unlock the shared AudioContext (Chromium only lets audio start after
// a user gesture, so the beep below is primed by the Start click).
function ensureFocusBeeper() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || focusBeeper) return;
    focusBeeper = new AC();
    if (focusBeeper.state === 'suspended') focusBeeper.resume();
  } catch (e) { /* audio unavailable — the toast + flash still fire */ }
}

// Play a short ascending chime (G5 G5 C6) — a satisfying "time's up".
function focusBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!focusBeeper) focusBeeper = new AC();
    if (focusBeeper.state === 'suspended') focusBeeper.resume();
    const t0 = focusBeeper.currentTime;
    [0, 0.22, 0.44].forEach((off, i) => {
      const o = focusBeeper.createOscillator();
      const g = focusBeeper.createGain();
      o.type = 'sine';
      o.frequency.value = i === 2 ? 1046.5 : 783.99; // G5 G5 C6
      g.gain.setValueAtTime(0.0001, t0 + off);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.28);
      o.connect(g);
      g.connect(focusBeeper.destination);
      o.start(t0 + off);
      o.stop(t0 + off + 0.3);
    });
  } catch (e) { /* audio unavailable — the toast + flash still fire */ }
}

// === Focus Timer UI wiring ===
const focusOpenBtn = document.getElementById('focus-open');
if (focusOpenBtn) {
  focusOpenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (focusPanel.classList.contains('popup-hidden')) openFocusPanel();
    else closeFocusPanel();
  });
}
// The slim top mini-bar opens the focus panel when clicked.
const focusMiniEl = document.getElementById('focus-mini');
if (focusMiniEl) {
  focusMiniEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (focusPanel.classList.contains('popup-hidden')) openFocusPanel();
    else closeFocusPanel();
  });
}
document.getElementById('focus-close').addEventListener('click', (e) => { e.stopPropagation(); closeFocusPanel(); });
document.getElementById('focus-start').addEventListener('click', () => {
  if (focusTimer.running) pauseFocus(); else startFocus();
});
document.getElementById('focus-reset').addEventListener('click', resetFocus);
// Picking a task pre-fills its duration; typing a custom value overrides.
document.getElementById('focus-task').addEventListener('change', (e) => {
  if (focusTimer.running) return; // never swap targets mid-session
  focusTimer.taskId = e.target.value || '';
  const t = focusTimer.taskId ? tasks.find((x) => String(x.id) === focusTimer.taskId) : null;
  if (t && t.durationMin) {
    const m = Math.max(1, Math.min(720, Math.round(t.durationMin)));
    document.getElementById('focus-minutes').value = m;
    focusTimer.totalMs = m * 60000;
  }
  focusTimer.remainingMs = focusTimer.totalMs;
  renderFocusDisplay();
});
document.getElementById('focus-minutes').addEventListener('change', () => {
  if (focusTimer.running) return;
  const m = Math.max(1, Math.min(720, parseInt(document.getElementById('focus-minutes').value, 10) || 25));
  document.getElementById('focus-minutes').value = m;
  focusTimer.totalMs = m * 60000;
  focusTimer.remainingMs = focusTimer.totalMs;
  renderFocusDisplay();
});

// === Initialize ===
init();

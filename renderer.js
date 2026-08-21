/* === Halo Renderer (planner sidebar; works with or without Electron) === */

// DOM elements
const app = document.getElementById('app');
const infoPopup = document.getElementById('info-popup');
const settingsPanel = document.getElementById('settings-panel');
const vaultPanel = document.getElementById('clipboard-vault');
const assistantPanel = document.getElementById('assistant-panel');
const notesPanel = document.getElementById('notes-panel');
const tasksPanel = document.getElementById('tasks-panel');
const categoriesPanel = document.getElementById('categories-panel');
const classesPanel = document.getElementById('classes-panel');
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
// The assistant's knowledge base: remembered classes (name + days + time, so
// "history homework" resolves against the user's History class) and facts.
const MEMORY_KEY = 'wolf-memory'; // declared BEFORE loadMemory() below (TDZ)
let assistantMemory = loadMemory(); // { classes: [{id, name, days, time}], facts: [{id, text, at}] }
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
  aiKey: '',              // OpenRouter API key for the AI assistant fallthrough (set in Settings)
  assistantMode: 'online', // 'online' (AI-first) or 'offline' (local terminal commands only)
  conflictWindowMin: 30,   // minutes: deadlines within this window on the same day "overlap"
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
  openStats() {
    if (hasElectron) window.electronAPI.openStats();
    else showToast('📊 Stats page runs in the desktop app');
  },
  openInfo() {
    // Electron: the info card is its own window (clock/weather/quote) parked
    // in the middle column. Browser preview falls back to the in-window popup.
    if (hasElectron) window.electronAPI.openInfo();
    else toggleInfoPopup();
  },
  fullView() {
    if (hasElectron) window.electronAPI.fullView();
    else {
      // Browser preview: open every in-window panel at once.
      showPlanner();
      toggleInfoPopup();
      openNotesPanel();
    }
  },
  writeClipboard(text) {
    if (hasElectron) return window.electronAPI.writeClipboard(text);
    return navigator.clipboard.writeText(text).then(() => true);
  },
  getClipboardHistory() {
    if (hasElectron) return window.electronAPI.getClipboardHistory();
    return Promise.resolve([]);
  },
  deleteClipboardItem(key) { if (hasElectron) window.electronAPI.deleteClipboardItem(key); },
  clearClipboardHistory() { if (hasElectron) window.electronAPI.clearClipboardHistory(); },
  getClipboardImage(hash) {
    if (hasElectron) return window.electronAPI.getClipboardImage(hash);
    return Promise.resolve('');
  },
  writeClipboardImage(hash) {
    if (hasElectron) return window.electronAPI.writeClipboardImage(hash);
    return Promise.resolve(false);
  },
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
  // Focus session — the planner unsummons into a slim focus bar while a
  // timer runs; the bar's buttons come back here as commands.
  setFocusSession(state) { if (hasElectron) window.electronAPI.setFocusSession(state); },
  onFocusBarCmd(cb) { if (hasElectron) window.electronAPI.onFocusBarCmd(cb); },
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
  // Self-heal old class/category ids that collided (the AI could save many
  // classes in one response with identical Date.now() ids). Runs before any
  // render so tags resolve to the correct class.
  repairMemoryIds();
  // Panels opened from the floating launcher button window.
  api.onOpenPanel(({ action }) => {
    switch (action) {
      case 'info': toggleInfoPopup(); break;
      case 'clipboard': openClipboardVault(); break;
      case 'assistant': openAssistantPanel(); break;
      case 'tasks': showPlanner(); break;
      case 'focus': openFocusPanel(); break;
      case 'settings': openSettingsPanel(); break;
      case 'categories': openCategoriesPanel(); break;
      case 'classes': openClassesPanel(); break;
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
      // Futuristic slide-up + fade-in on summon (one-shot, removed after it
      // finishes so the panel's own transform/opacity rules stay in charge).
      const glass = document.querySelector('.tasks-panel-glass');
      if (glass) {
        glass.classList.remove('wake-in');
        void glass.offsetWidth; // restart the animation on every summon
        glass.classList.add('wake-in');
        const onWakeEnd = (e) => {
          if (e.target !== glass) return;
          glass.classList.remove('wake-in');
          glass.removeEventListener('animationend', onWakeEnd);
        };
        glass.addEventListener('animationend', onWakeEnd);
      }
    }
    sendInteractiveBounds();
    // Toast floats above the faded planner so the action is always confirmed.
    showToast(value ? '😴 App hidden — Ctrl+Shift+S to summon it back' : '✨ Welcome back!');
  });
  api.onAltDim((s) => {
    document.body.classList.toggle('alt-dim', !!(s && s.active));
    sendInteractiveBounds();
  });
  // Commands from the slim focus bar (shown while a session runs — the
  // planner is unsummoned, so the bar owns pause/resume/stop).
  api.onFocusBarCmd(({ action }) => {
    if (action === 'pause') pauseFocus();
    else if (action === 'resume') startFocus();
    else if (action === 'stop') resetFocus();
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

  // The app ships with a single signature look: the black glass theme. It is
  // forced here (not read from storage) so every window is always black,
  // whatever was persisted by an older build with a theme picker.
  document.body.dataset.theme = 'black';
  applyProtocol(); // daily-protocol accent (cyan default until one is chosen)

  updateClock();
  setInterval(updateClock, 1000);
  updateWeather();
  updateQuote();
  loadSettings();

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
  // Re-announce the focus state to main on every load: if this renderer was
  // reloaded mid-session (crash, devtools), the timer state is gone — main
  // must un-set its focusSessionActive flag or it would keep the planner
  // unsummoned forever with no bar to show. Idle state sends {active:false},
  // which restores the active mode's windows.
  syncFocusBar();
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
  // time even while the planner is hidden. Class reminders ride the same tick.
  tickDeadlineReminders();
  setInterval(tickDeadlineReminders, 30000);
  tickClassReminders();
  setInterval(tickClassReminders, 30000);
}

// The centered startup screen now lives in its own always-on-top window
// (boot.html). When the user clicks through it, main sends `boot-done` here
// so the planner can show the daily protocol picker (if not chosen today).
if (window.electronAPI && window.electronAPI.onBootDone) {
  window.electronAPI.onBootDone(() => {
    // The Jarvis card is dismissed — glide the planner glass up underneath.
    const glass = document.querySelector('.tasks-panel-glass');
    if (glass) {
      glass.classList.remove('boot-summon');
      void glass.offsetWidth; // restart the animation on every boot-through
      glass.classList.add('boot-summon');
      // Drop the class once the animation ends: its fill-mode would keep
      // overriding the panel's own transforms/opacity (e.g. a later
      // panel-hidden collapse would never visually hide the glass). Only the
      // glass's OWN animationend counts — child animations bubble too.
      const onSummonEnd = (e) => {
        if (e.target !== glass) return;
        glass.classList.remove('boot-summon');
        glass.removeEventListener('animationend', onSummonEnd);
      };
      glass.addEventListener('animationend', onSummonEnd);
    }
    maybeShowProtocol();
  });
}

// === Daily Protocol (startup choice: Productive / Workout / Rest / Play) ===
// Persisted per-day; the dashboard's accent color follows the chosen mode.
const PROTOCOL_KEY = 'wolf-protocol';
function todayProtocol() {
  try { return JSON.parse(localStorage.getItem(PROTOCOL_KEY)) || null; } catch (e) { return null; }
}
function currentProtocol() {
  const p = todayProtocol();
  const today = dayKey(new Date());
  return (p && p.date === today && p.protocol) ? p.protocol : null;
}
function broadcastProtocol() {
  if (hasElectron && window.electronAPI && window.electronAPI.sendProtocol) {
    window.electronAPI.sendProtocol(currentProtocol());
  }
}
function applyProtocol() {
  const protocol = currentProtocol();
  if (protocol) document.body.dataset.protocol = protocol;
  else delete document.body.dataset.protocol;
  broadcastProtocol();
}
function selectProtocol(protocol) {
  localStorage.setItem(PROTOCOL_KEY, JSON.stringify({ protocol, date: dayKey(new Date()) }));
  document.body.dataset.protocol = protocol;
  broadcastProtocol();
  dismissProtocolModal();
  showToast('Protocol: ' + protocol.charAt(0).toUpperCase() + protocol.slice(1));
}
function showProtocolModal() {
  const modal = document.getElementById('protocol-modal');
  if (!modal) return;
  modal.classList.remove('closing');
  modal.classList.add('open');
}
function dismissProtocolModal() {
  const modal = document.getElementById('protocol-modal');
  if (!modal) return;
  modal.classList.add('closing');
  modal.classList.remove('open');
  setTimeout(() => modal.classList.remove('closing'), 350);
}
function maybeShowProtocol() {
  const p = todayProtocol();
  const today = dayKey(new Date());
  if (!p || p.date !== today) showProtocolModal();
}
(function wireProtocolUI() {
  const modal = document.getElementById('protocol-modal');
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    const card = e.target.closest('.protocol-card');
    if (card && card.dataset.protocol) selectProtocol(card.dataset.protocol);
    // Locked: clicking the backdrop does NOT dismiss the picker — the user
    // must choose a protocol for the day.
  });
})();

// === Send interactive element bounds to main process for cursor polling ===
// The planner glass, popups and modal are interactive at once (no hover-arm
// anymore). The renderer refreshes these on a 400ms timer so the hit-regions
// always track the live layout.
// Bounds are re-sent only when they actually change: the 400ms tick and the
// state-change hooks all funnel through here, and the cursor poll in main
// only needs the regions when they move. Skipping the IPC when nothing
// changed cuts ~2.5 renderer→main wakes/sec down to ~0 while the layout is
// static (the common case).
let lastSentBoundsKey = '';
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
    !assistantPanel.classList.contains('popup-hidden') ||
    !notesPanel.classList.contains('panel-hidden') ||
    !categoriesPanel.classList.contains('panel-hidden') ||
    !focusPanel.classList.contains('popup-hidden');
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

  const key = JSON.stringify(bounds);
  if (key === lastSentBoundsKey) return;
  lastSentBoundsKey = key;
  window.electronAPI.updateInteractiveBounds(bounds);
}

// === Custom tooltips ===
// Every interactive element's native title bubble is replaced by a clean
// glass tooltip in the app's font (the OS bubble can't be styled). The
// first hover on a [title] element steals its text into data-tip and drops
// the native attribute; later hovers reuse data-tip instantly.
let appTipEl = null;
let appTipTimer = null;
function ensureAppTip() {
  if (appTipEl) return appTipEl;
  appTipEl = document.createElement('div');
  appTipEl.className = 'app-tooltip';
  document.body.appendChild(appTipEl);
  return appTipEl;
}
function showAppTip(el, text) {
  const tip = ensureAppTip();
  tip.textContent = text;
  const r = el.getBoundingClientRect();
  const w = Math.min(240, tip.offsetWidth || 160);
  const h = tip.offsetHeight || 30;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
  // Above the element, flipping below when it sits near the top edge.
  const top = r.top > 70 ? r.top - h - 10 : r.bottom + 10;
  tip.style.left = left + 'px';
  tip.style.top = Math.max(6, Math.min(top, window.innerHeight - h - 6)) + 'px';
  tip.classList.add('visible');
}
function hideAppTip() {
  if (appTipTimer) { clearTimeout(appTipTimer); appTipTimer = null; }
  if (appTipEl) appTipEl.classList.remove('visible');
}
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[title],[data-tip]');
  if (!el || el.closest('.app-tooltip')) return;
  // Task/deadline rows have their own detailed hover card — skip the plain
  // name tooltip there, but keep the row's action-button tooltips.
  if (el.closest('.item-row') && !el.closest('button')) return;
  let text = el.dataset.tip;
  if (text == null) {
    text = el.getAttribute('title') || '';
    if (!text) return;
    el.setAttribute('data-tip', text);
    el.removeAttribute('title');
  }
  if (appTipTimer) clearTimeout(appTipTimer);
  appTipTimer = setTimeout(() => showAppTip(el, text), 180);
});
document.addEventListener('mouseout', (e) => {
  const from = e.target.closest && e.target.closest('[title],[data-tip]');
  const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[title],[data-tip]') : null;
  if (from && from !== to) hideAppTip();
});
// Dismiss when the planner scrolls under the cursor or anything is clicked.
document.addEventListener('scroll', hideAppTip, true);
document.addEventListener('click', hideAppTip, true);

// === Clock ===
function updateClock() {
  const now = new Date();
  popupTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  popupDate.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// === Weather (live forecast via Open-Meteo — free, no key) ===
// window.HaloWeather is the shared module loaded by weather.js; it caches the
// forecast + IP-based location in localStorage so the Info window reuses the
// same fetch (one call per 10 min for the whole app).
function updateWeather() {
  if (!settings.weather) {
    weatherIcon.textContent = '—'; weatherTemp.textContent = ''; weatherDesc.textContent = 'Weather off'; return;
  }
  if (!window.HaloWeather || !window.HaloWeather.get) {
    weatherIcon.textContent = '🌡️'; weatherTemp.textContent = ''; weatherDesc.textContent = 'Weather unavailable'; return;
  }
  window.HaloWeather.get().then((w) => {
    if (!settings.weather) return; // toggled off while fetching
    weatherIcon.textContent = w.icon || '—';
    weatherTemp.textContent = w.temp || '';
    weatherDesc.textContent = w.desc ? (w.desc + (w.city ? ' · ' + w.city : '')) : '';
  });
}
setInterval(() => { if (settings.weather) updateWeather(); }, 600000);

// === Quotes ===
const quotes = [
  "You're doing great today! ✨", 'Every step forward counts. 🌱',
  "Take a deep breath — you've got this. 💪", 'Small progress is still progress. 🌻',
  'You are capable of amazing things. ⭐', 'One task at a time. You rule! 🎯',
  'Rest is productive too. 😌', 'Believe in yourself — I do! 💖',
];
function updateQuote() { quoteText.textContent = quotes[Math.floor(Math.random() * quotes.length)]; }

// Close popups when clicking anywhere else (the launcher and its ring are
// excluded — they toggle their own state). Each open card handles its own
// inside clicks; clicking the planner/backdrop outside any card closes it.
app.addEventListener('click', (e) => {
  if (e.target.closest('#browser-launcher')) return;
  if (e.target.closest('#radial-menu')) return;
  if (e.target.closest('#tasks-panel')) return;
  if (e.target.closest('#categories-panel')) return;
  if (e.target.closest('#classes-panel')) return;
  if (e.target.closest('.popup-glass') || e.target.closest('.panel-glass')) return;
  closeRadialMenu();
  closeClipboardVault();
  closeAssistantPanel();
  if (!infoPopup.classList.contains('popup-hidden')) { infoPopup.classList.add('popup-hidden'); }
  closeNotesPanel();
  closeCategoriesPanel();
  closeClassesPanel();
  closeFocusPanel();
  if (!settingsPanel.classList.contains('panel-hidden')) {
    settingsPanel.classList.add('panel-hidden');
  }
  sendInteractiveBounds();
});

// Browser-only launcher button (hidden in Electron — the desktop app uses
// the assistant's suggestion chips instead). Clicking it opens the ring.
const launcherEl = document.getElementById('browser-launcher');
if (launcherEl) {
  launcherEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRadialMenu();
  });
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
const aiKeyInput = document.getElementById('setting-ai-key');
if (aiKeyInput) aiKeyInput.addEventListener('change', function() {
  settings.aiKey = this.value.trim();
  saveSettings();
});
const conflictMinInput = document.getElementById('setting-conflict-min');
if (conflictMinInput) conflictMinInput.addEventListener('change', function() {
  const n = parseInt(this.value, 10);
  settings.conflictWindowMin = isNaN(n) || n < 0 ? 0 : n;
  saveSettings();
});
const exportBtn = document.getElementById('export-data');
if (exportBtn) exportBtn.addEventListener('click', () => doExportData());

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
  const aiKeyEl = document.getElementById('setting-ai-key');
  if (aiKeyEl) aiKeyEl.value = settings.aiKey || '';
  const cmEl = document.getElementById('setting-conflict-min');
  if (cmEl) cmEl.value = settings.conflictWindowMin != null ? settings.conflictWindowMin : 30;
  // Apply the saved on-top preference at startup — the window is created
  // always-on-top, so without this the toggle only worked mid-session.
  api.setAlwaysOnTop(settings.alwaysOnTop);
}
function saveSettings() { localStorage.setItem('wolf-pet-settings', JSON.stringify(settings)); }

// Export tasks/deadlines/notes/settings to a JSON file (Electron save dialog
// or a browser download as a fallback).
function doExportData() {
  const payload = {
    app: 'halo',
    exportedAt: new Date().toISOString(),
    tasks,
    deadlines,
    categories,
    notes: loadNotes(),
    settings,
  };
  const json = JSON.stringify(payload, null, 2);
  if (hasElectron && window.electronAPI && window.electronAPI.exportData) {
    window.electronAPI.exportData(json).then((ok) => showToast(ok ? '💾 Data exported' : 'Export cancelled'));
  } else {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wolf-data.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    showToast('💾 Data exported (download)');
  }
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
// View switching (tasks/calendar/week) lives in the planner's own view bar,
// so the ring only carries the feature shortcuts.
const RING_ACTIONS = [
  { action: 'info', icon: 'ℹ️', label: 'Info' },
  { action: 'clipboard', icon: '📋', label: 'Clipboard' },
  { action: 'assistant', icon: '🗨️', label: 'Assistant' },
  { action: 'notes', icon: '📝', label: 'Notes' },
  { action: 'focus', icon: '⏱️', label: 'Focus' },
  { action: 'screenshot', icon: '📷', label: 'Screenshot' },
  { action: 'settings', icon: '⚙️', label: 'Settings' },
];

// Accent hue per action — feeds both the glow identity and the SVG
// gradient paint servers for each wedge + glass button.
const ACTION_COLORS = {
  info: '#38bdf8', clipboard: '#2dd4bf', assistant: '#e879f9', notes: '#fbbf24',
  focus: '#a3e635', screenshot: '#f472b6', settings: '#94a3b8',
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
  assistantPanel.classList.add('popup-hidden');
  notesPanel.classList.add('panel-hidden');
  categoriesPanel.classList.add('panel-hidden');
  classesPanel.classList.add('panel-hidden');
  focusPanel.classList.add('popup-hidden');
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
      case 'assistant':
        openAssistantPanel();
        break;
      case 'notes':
        api.openNotesPanel();
        break;
      case 'focus':
        openFocusPanel();
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
    const meta = document.createElement('span');
    meta.className = 'vault-meta';
    meta.textContent = timeAgo(item.time);

    const del = document.createElement('button');
    del.className = 'vault-del';
    del.textContent = '✕';
    del.title = 'Remove from history';

    if (item.type === 'image') {
      // Screenshot / copied picture — thumbnail, click to copy back.
      row.className = 'vault-item vault-item-img';
      const imgEl = document.createElement('img');
      imgEl.className = 'vault-img';
      imgEl.alt = 'Clipboard image';
      api.getClipboardImage(item.hash).then((url) => { if (url) imgEl.src = url; });
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        api.deleteClipboardItem(item.hash);
      });
      row.append(imgEl, meta, del);
      row.addEventListener('click', () => copyHistoryImage(item.hash));
      list.appendChild(row);
      return;
    }

    row.className = 'vault-item';
    const txt = document.createElement('span');
    txt.className = 'vault-text';
    txt.textContent = item.text;
    txt.title = item.text;

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

function copyHistoryImage(hash) {
  api.writeClipboardImage(hash).then((ok) => {
    if (ok) showToast('Image copied to clipboard! 📋');
  });
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

// === Assistant (chat that manages your day) ===
// Rule-based natural-language commands over the same tasks/deadlines state
// the planner uses — no AI needed, works offline, replies in the chat.
let assistantBooted = false;
let assistantHistory = [];          // recent {role, content} turns, fed to the AI for follow-up context
const ASSISTANT_PENDING = { q: null }; // follow-up selection state

const ASSISTANT_HELP =
  "I manage your day. Try things like:\n" +
  '• "add task write report for 2h by Friday 3pm"\n' +
  '• "I have a test next Thursday at 2pm"\n' +
  '• "completed the report for 35 mins"\n' +
  '• "delete task report" · "reopen task report" · "delete the history test"\n' +
  '• "edit the math test to next Thursday 2pm" · "rename write report to write essay"\n' +
  '• "start the focus timer for write report"\n' +
  '• "remind me at 5pm to call mom"\n' +
  '• "remember my history class is Monday Wednesday at 9am"\n' +
  '• "my schedule: history mon wed 9am, math tue thu 10am" (multiple at once)\n' +
  '• "history homework due tomorrow" (auto-dates to your class)\n' +
  '• "what classes do I have?" · "what\'s my next class?"\n' +
  '• "show my stats" · "switch to week view"\n' +
  '• "plan my day: gym at 7am; standup 9:30; deep work"\n' +
  '• "how was my week?" · "what\'s due today?"\n' +
  '• "show clipboard" · "show screenshots" · "help"';

function openAssistantPanel() {
  assistantPanel.classList.remove('popup-hidden');
  infoPopup.classList.add('popup-hidden');
  settingsPanel.classList.add('panel-hidden');
  notesPanel.classList.add('panel-hidden');
  closeClipboardVault();
  sendInteractiveBounds();
  if (!assistantBooted) {
    assistantBooted = true;
    assistantSay(ASSISTANT_HELP);
  }
  setTimeout(() => document.getElementById('assistant-input').focus(), 60);
}

function closeAssistantPanel() {
  assistantPanel.classList.add('popup-hidden');
  sendInteractiveBounds();
}

function assistantSay(text, who) {
  const msgs = document.getElementById('assistant-msgs');
  const b = document.createElement('div');
  b.className = 'a-msg ' + (who === 'user' ? 'a-user' : 'a-bot');
  b.textContent = text;
  msgs.appendChild(b);
  msgs.scrollTop = msgs.scrollHeight;
}

function assistantSend() {
  const input = document.getElementById('assistant-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  autoGrowAssistantInput(); // reset the textarea back to one line
  assistantSay(q, 'user');
  assistantAnswer(q).then(assistantEmit);
}

// Route a reply to wherever the user is talking: the floating assistant
// window (Electron) and/or the in-planner panel (browser fallback).
function assistantEmit(reply) {
  if (hasElectron && window.electronAPI && window.electronAPI.sendAssistantReply) {
    window.electronAPI.sendAssistantReply(reply);
  }
  if (assistantPanel && !assistantPanel.classList.contains('popup-hidden')) {
    if (reply && typeof reply === 'object' && reply.kind === 'clipboard') {
      assistantSay(reply.text);
      assistantSay('(In the browser preview there\'s no clipboard history — this works in the app.)');
    } else {
      assistantSay(typeof reply === 'string' ? reply : (reply && reply.text) || '');
    }
  }
}

// Pure natural-language parser (extracted to assistant-parser.js so it can be
// unit-tested in isolation). Loaded as a <script> before renderer.js.
const { assistantCleanName, assistantExtractWhen, assistantExtractRecur, nextRecurDate, assistantExtractClassDef, assistantExtractClassDefs, assistantMatchClass, nextClassDate, nextClassDateTime } = window.AssistantParser;

// === Terminal-style slash commands (work in BOTH online & offline modes) ===
const SLASH_HELP =
  'Offline terminal commands — fields are comma-separated (only name is required):\n' +
  '/task <name>, <date?>, <category?>, <time?>, <duration?>\n' +
  '/deadline <name>, <date?>, <time?>\n' +
  '/complete <name>   ·   /delete <name>   ·   /reopen <name>   ·   /move <name>, <when>   ·   /progress <name>, <minutes>\n' +
  '/focus <name?>, <minutes?>   ·   /view tasks|calendar|week   ·   /stats\n' +
  '/plan <item>; <item>; …   ·   /week (weekly recap)\n' +
  '/classes (my classes)   ·   /forget <class>   ·   /list   ·   /due   ·   /help   ·   /mode online|offline\n' +
  '🧠 I remember your classes — tell me e.g. "remember my history class is Monday Wednesday at 9am", then "history homework due tomorrow" just works.';

function parseDurationField(a) {
  const m = String(a).trim().match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/i);
  if (!m) return 0;
  return Math.round(m[2][0].toLowerCase() === 'h' ? parseFloat(m[1]) * 60 : parseFloat(m[1]));
}
function parseTimeField(a) {
  const s = String(a).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (m) {
    let h = parseInt(m[1], 10); const min = parseInt(m[2], 10); const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return pad2(h) + ':' + pad2(min);
  }
  m = s.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (m) {
    let h = parseInt(m[1], 10); const ap = m[2].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return pad2(h) + ':00';
  }
  return '';
}
function parseDateField(a) {
  const s = String(a).trim();
  if (/^(none|-|n\/a|skip)$/i.test(s)) return ''; // explicit "no date"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const w = assistantExtractWhen(s);
  return w ? w.due : null;
}

function assistantSlashCommand(q) {
  const segments = q.slice(1).split(',').map((s) => s.trim());
  const head = (segments[0] || '').split(/\s+/);
  const cmd = (head[0] || '').toLowerCase();
  const args = [head.slice(1).join(' '), ...segments.slice(1)].map((s) => s.trim()).filter(Boolean);

  if (cmd === 'task' || cmd === 't' || cmd === 'todo') {
    let name = args[0];
    let recur = '';
    if (name) { const rr = assistantExtractRecur(name); if (rr) { name = rr.rest; recur = rr.recur; } }
    if (!name) return 'Usage: /task <name>, <date?>, <category?>, <time?>, <duration?>';
    let due = '', time = '', category = '', durationMin = 0;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const d = parseDurationField(a); if (d) { durationMin = d; continue; }
      const t = parseTimeField(a); if (t) { time = t; continue; }
      const dt = parseDateField(a); if (dt !== null) { due = dt; continue; }
      const c = categories.find((x) => x.name.toLowerCase() === a.toLowerCase());
      if (c) { category = c.id; continue; }
    }
    tasks.unshift({ id: nextItemId(), name, due, durationMin, done: false, category, recur, progressMin: 0 });
    saveTasks(); renderTasks(); refreshActiveView();
    let r = '✅ Added "' + name + '"';
    if (due) r += ' · due ' + fmtDateShort(due);
    if (durationMin) r += ' · ' + fmtMin(durationMin);
    if (category) { const c = categories.find((x) => x.id === category); if (c) r += ' · in ' + c.name; }
    return r + '.';
  }

  if (cmd === 'deadline' || cmd === 'dl' || cmd === 'event') {
    const name = args[0];
    if (!name) return 'Usage: /deadline <name>, <date?>, <time?>';
    let due = '', time = '';
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const t = parseTimeField(a); if (t) { time = t; continue; }
      const dt = parseDateField(a); if (dt !== null) { due = dt; continue; }
    }
    const dl = { id: nextItemId(), name, due, time, done: false };
    deadlines.unshift(dl);
    saveDeadlines(); renderDeadlines(); refreshActiveView(); tickDeadlineReminders();
    warnDeadlineConflict(dl);
    let r = '✅ Deadline added: "' + name + '"';
    if (due) r += ' · ' + fmtDateShort(due);
    if (time) r += ' at ' + fmtTimeOfDay(time);
    return r + '.';
  }

  if (cmd === 'complete' || cmd === 'done' || cmd === 'finish') return assistantPickTask(args.join(' '), 'complete', {});
  if (cmd === 'delete' || cmd === 'rm' || cmd === 'remove') return assistantPickTask(args.join(' '), 'delete', null);
  if (cmd === 'reopen') return assistantPickTask(args.join(' '), 'reopen', null);
  if (cmd === 'move' || cmd === 'reschedule' || cmd === 'mv') {
    if (!args.length || !args[1]) return 'Usage: /move <name>, <when>';
    return assistantReschedule(args[0] + ' to ' + args.slice(1).join(' '));
  }
  if (cmd === 'progress' || cmd === 'log') {
    const name = args[0] || '';
    if (!name) return 'Usage: /progress <name>, <minutes>';
    let mins = 15;
    const m = args.find(a => /^\d+\s*(?:m|min|mins|minutes?)$/i.test(a));
    if (m) mins = parseInt(m, 10) || 15;
    return assistantPickTask(name, 'progress', { minutes: mins });
  }
  if (cmd === 'focus' || cmd === 'pomodoro') {
    const name = args[0] || '';
    let mins = 0;
    const m = args.find(a => /^\d+\s*(?:m|min|mins|minutes?|h|hr|hours?)$/i.test(a));
    if (m) { const n = parseInt(m, 10) || 0; mins = /\bh/i.test(m) ? n * 60 : n; }
    return assistantStartFocus(name, mins);
  }
  if (cmd === 'view') {
    const v = (args[0] || '').toLowerCase();
    if (v === 'tasks' || v === 'calendar' || v === 'week') { api.setMode(v); return '✅ Switched to ' + v + ' view.'; }
    return 'Usage: /view tasks | calendar | week';
  }
  if (cmd === 'plan' || cmd === 'schedule') {
    const raw = args.join(' ').trim();
    if (!raw) return 'Usage: /plan <item>; <item>; … (times → deadlines, no time → tasks)';
    return assistantPlan(raw);
  }
  if (cmd === 'stats' || cmd === 'progress' || cmd === 'summary') { api.openStats(); return '📊 Opening your daily stats…'; }
  if (cmd === 'list' || cmd === 'tasks' || cmd === 'ls') return assistantList();
  if (cmd === 'due') return assistantDue();
  if (cmd === 'week' || cmd === 'recap' || cmd === 'weekly') return assistantWeekRecap();
  if (cmd === 'classes' || cmd === 'class' || cmd === 'schedule') return assistantListClasses();
  if (cmd === 'forget' || cmd === 'unremember') {
    const n = args.join(' ');
    if (!n) return 'Usage: /forget <class name>';
    return forgetClass(n);
  }
  if (cmd === 'help' || cmd === 'h') return SLASH_HELP;
  if (cmd === 'mode') {
    const m = (args[0] || '').toLowerCase();
    if (m === 'online' || m === 'on') { settings.assistantMode = 'online'; saveSettings(); updateAssistantModeUI(); broadcastAssistantMode(); return '🌐 Online mode — free-form messages use the AI (OpenRouter).';
    }
    if (m === 'offline' || m === 'off') { settings.assistantMode = 'offline'; saveSettings(); updateAssistantModeUI(); broadcastAssistantMode(); return '📴 Offline mode — instant local commands only (no AI).';
    }
    return 'Current mode: ' + (settings.assistantMode === 'offline' ? '📴 offline' : '🌐 online') + '. Use /mode online or /mode offline.';
  }
  return 'Unknown command "/' + cmd + '". Type /help for the list.';
}

// The assistant's brain: turns a natural-language message into a reply
// string (or a { kind: 'clipboard', ... } payload) and performs the action
// on the real tasks/deadlines data. Used by the floating window AND the
// in-planner panel — one parser, two UIs.
function assistantHandleText(raw) {
  let q = String(raw || '').replace(/\s+/g, ' ').trim();
  // Filler words people type before getting to the point.
  q = q.replace(/^(oh|so|um|uh|ok|okay|hey|hi|yo|like|well|hmm|also)[,\s]+/i, '');
  if (!q) return 'Say something like "I have a test next Thursday at 2pm" or "show screenshots".';
  const lq = q.toLowerCase();

  // Terminal-style slash commands take priority in both modes.
  if (q[0] === '/') return assistantSlashCommand(q);

  // Follow-up selection: "1", "the second one", "#3", or a time answer.
  if (ASSISTANT_PENDING.q) {
    const r = assistantHandleFollowUp(q);
    if (r !== null) return r;
    return ASSISTANT_PENDING.q.hint || 'Could you rephrase that? (reply with a number or a time)';
  }

  if (/^(help|what can you do|commands|help me)\b/.test(lq)) return ASSISTANT_HELP;
  // Clipboard/screenshot queries. Bare "history" is deliberately NOT a
  // trigger — it's a school subject ("history homework"), so only
  // clipboard-flavored phrases open the vault.
  if (/(?:clipboard|screenshots?|screen\s*shot|copied\s*(?:items?|text)?|(?:paste|copy|clipboard)\s+history|recent\s+copies)/i.test(lq)) return assistantClipboard(lq);
  if (/(?:stats|statistics|progress|how\s+(?:much|many)\s+(?:have\s+i\s+)?(?:done|progress)|productivity|today'?s\s+(?:summary|report))/i.test(lq)) { api.openStats(); return '📊 Opening your daily stats…'; }
  if (/(?:start|begin|launch|run)\s+(?:a\s+|the\s+)?(?:focus|pomodoro)\s+(?:timer|session)?/i.test(lq)) return assistantFocusCommand(q);
  if (/\b(?:switch|go|change)\s+(?:to|the)?\s*(?:week|calendar|tasks)\s*(?:view)?\b/i.test(lq)) return assistantViewCommand(q);
  if (/(?:info|weather|forecast|temperature)\b/.test(lq)) { api.openInfo(); return 'ℹ️ Opened Info & Weather.'; }
  if (/(?:settings?|preferences?|config)\b/.test(lq)) { openSettingsPanel(); return '⚙️ Opened Settings.'; }
  if (/(?:notes?|jot|memo)\b/.test(lq)) { api.openNotesPanel(); return '📝 Opened Quick Notes.'; }
  if (lq.includes('remind')) return assistantRemind(q);
  // "what's my next class?" / "when is history class?" — answered from memory.
  if (/(?:what|when|which)\s*(?:is|'s)?\s*(?:my\s+)?(?:next|first|upcoming)?\s*(?:class|period)\b|when\s+is\s+.+?\s+class\b/i.test(lq)) {
    const r = assistantNextClass(q);
    if (r) return r;
  }
  // Memory: "remember my history class is Monday Wednesday at 9am" / "my
  // schedule: history mon wed 9am, math tue thu 10am" / "my classes are
  // history, math". Falls through when the text is not a class definition
  // ("add history class homework" is a task, not a schedule).
  if (/(?:remember|save|note|set|add|log|store)\b[^\n]*\b(?:class|course|subject|schedule|timetable)\b/i.test(q) ||
      /(?:my|the|our)\s+(?:classes?|courses?|subjects?|schedule|timetable)\b/i.test(lq)) {
    const r = assistantRememberClass(q);
    if (r !== null) return r;
  }
  // Memory: "what classes do I have?" / "show my schedule"
  if (/(?:what|show|list|display)\b[^\n]*\b(?:classes?|courses?|subjects?|schedule|timetable)\b/i.test(lq)) {
    const r = assistantListClasses();
    if (r !== null) return r;
  }
  if (/^(?:please\s+)?(?:add|create|new)\s+/.test(lq)) return assistantAdd(q);
  // Events phrased without "add": "I have a test next Thursday at 2pm".
  if (/(^|\s)(?:i\s+have|i've\s+got|ive\s+got|i\s+got|got|there'?s|there\s+is|we\s+have)\s+(?:a\s+|an\s+|the\s+)?/.test(lq)) {
    const r = assistantEvent(q);
    if (r) return r;
  }
  // Class homework without "I have": "history homework due tomorrow" /
  // "history test on friday" → routed as an add so the remembered class
  // tags it and dates it. Not for pure questions ("what's due tomorrow?").
  if (assistantMatchClass(assistantMemory, q) && /\b(?:due|by|tomorrow|tonight|today|next|on|at)\b/i.test(q) && !/^(?:what|show|list|is|are|when|do)\b/.test(lq)) {
    const r = assistantAdd('add ' + q.replace(/^(?:please\s+)?/i, ''));
    if (r) return r;
  }
  if (/(?:complete|completed|done|finish|finished|did|knocked|checked)/.test(lq)) return assistantComplete(q);
  if (/(?:delete|remove|get\s+rid|drop)/.test(lq)) return assistantDelete(q);
  if (/\b(?:reschedule|move|snooze|postpone|push|bump)\b/.test(lq)) return assistantReschedule(q);
  // "edit/rename/change/update <name>…" — change a task or deadline's name,
  // date, time, duration or category from the chat.
  if (/^(?:please\s+)?(?:edit|update|rename|change|modify)\s+/.test(lq)) return assistantEdit(q);
  // Weekly recap: "how was my week?" / "weekly summary".
  if (/(?:how\s+was\s+my\s+week|week(?:ly)?\s+(?:recap|summary|report|review)|my\s+week\s+(?:recap|summary|report)|recap\s+(?:my\s+)?week)/i.test(lq)) return assistantWeekRecap();
  // "plan my day: …" → split a list into tasks/deadlines.
  if (/^(?:please\s+)?plan\s+(?:my\s+|the\s+)?(?:day|today|tomorrow)\b/i.test(lq)) {
    return assistantPlan(q.replace(/^(?:please\s+)?plan\s+(?:my\s+|the\s+)?(?:day|today|tomorrow)[:,\s]*/i, ''));
  }
  // "I'll work on this deadline now" / "work on <deadline> for 2h" → a task
  // due today with the deadline's name + class tag (kept above the generic
  // "deadline" fallback so the word "deadline" doesn't swallow it).
  const workOn = assistantWorkOnDeadline(q);
  if (workOn !== null) return workOn;
  if (/(?:due|today|tomorrow|schedule|plan|what'?s\s+(?:on|up)|deadline)/.test(lq)) return assistantDue();
  if (/(?:list|show|my\s+tasks|all\s+tasks)/.test(lq)) return assistantList();
  return null; // no rule matched — the AI fallthrough handles it (or a helpful hint)
}

// === AI fallthrough: when no rule matches, ask a real LLM (OpenRouter) to turn
// the message into a structured app action. Needs an API key in Settings. ===
// Records the conversation and routes to the core handler. assistantHistory
// feeds the AI's context so it can follow up across messages.
async function assistantAnswer(raw) {
  const reply = await assistantAnswerCore(raw);
  assistantHistory.push({ role: 'user', content: raw });
  assistantHistory.push({ role: 'assistant', content: reply });
  if (assistantHistory.length > 20) assistantHistory = assistantHistory.slice(-20);
  return reply;
}

async function assistantAnswerCore(raw) {
  const key = (settings.aiKey || '').trim();
  const q = String(raw || '').replace(/\s+/g, ' ').trim()
    .replace(/^(oh|so|um|uh|ok|okay|hey|hi|yo|like|well|hmm|also)[,\s]+/i, '');
  const lq = q.toLowerCase();

  // These stay offline & instant: follow-up answers ("2"), help, and the
  // clipboard/screenshot view toggles. Everything else goes to the AI first
  // when a key is set (so free-form requests are actually understood), with
  // the offline rule parser as the fallback.
  const offlineFirst =
    !!ASSISTANT_PENDING.q ||
    q[0] === '/' ||
    /^(help|what can you do|commands|help me)\b/.test(lq) ||
    /(?:clipboard|screenshots?|screen\s*shot|copied\s*(?:items?|text)?|(?:paste|copy|clipboard)\s+history|recent\s+copies)/i.test(lq) ||
    /(?:stats|statistics|how\s+(?:much|many)\s+(?:have\s+i\s+)?(?:done|progress)|productivity|today'?s\s+(?:summary|report))/i.test(lq) ||
    /(?:start|begin|launch|run)\s+(?:a\s+|the\s+)?(?:focus|pomodoro)\s+(?:timer|session)?/i.test(lq) ||
    /\b(?:switch|go|change)\s+(?:to|the)?\s*(?:week|calendar|tasks)\s*(?:view)?\b/i.test(lq) ||
    /(?:info|weather|forecast|temperature|settings?|preferences?|config|notes?|jot|memo)\b/i.test(lq) ||
    /(?:how\s+was\s+my\s+week|week(?:ly)?\s+(?:recap|summary|report|review)|my\s+week\s+(?:recap|summary|report)|recap\s+(?:my\s+)?week)/i.test(lq) ||
    /^(?:please\s+)?plan\s+(?:my\s+|the\s+)?(?:day|today|tomorrow)\b/i.test(lq) ||
    /(?:what|when|which)\s*(?:is|'s)?\s*(?:my\s+)?(?:next|first|upcoming)?\s*(?:class|period)\b|when\s+is\s+.+?\s+class\b/i.test(lq) ||
    /(?:remember|save|note|set|add|log|store)\b[^\n]*\b(?:class|course|subject|schedule|timetable)\b/i.test(q) ||
    /(?:my|the|our)\s+(?:classes?|courses?|subjects?|schedule|timetable)\b/i.test(lq);

  let aiReason = null;
  const offline = settings.assistantMode === 'offline';
  if (key && !offline && !offlineFirst) {
    const ai = await assistantAIFallback(raw);
    if (ai.ok) {
      console.log('[assistant] AI handled:', q);
      return '🤖 ' + ai.reply;
    }
    aiReason = ai.reason;
    console.log('[assistant] AI unavailable (' + aiReason + ') — falling back offline');
  }

  const r = assistantHandleText(raw);
  if (r !== null) {
    console.log('[assistant] offline handled:', q);
    return r;
  }

  if (aiReason === 'bad-key') return '⚠️ Your OpenRouter key was rejected. Check it in Settings ⚙️ (it should start with sk-or-…). Offline commands still work: say help.';
  if (aiReason) return '⚠️ AI unavailable right now (free models are rate-limited) and I couldn\'t match that offline. Offline commands still work: say help.';
  return 'Hmm, I did not catch that — I understand tasks, deadlines, reminders, clipboard and screenshots. Say help for examples.\n\n💡 Add an OpenRouter API key in Settings (⚙️) to let me handle free-form requests with AI.';
}

// Free models on OpenRouter often wrap JSON in markdown fences or add prose,
// so extract the first balanced JSON object instead of assuming raw JSON.
function parseAssistantJson(content) {
  const text = String(content);
  try { return JSON.parse(text); } catch (e) { /* fall through to extraction */ }
  const first = text.indexOf('{');
  if (first === -1) throw new Error('no JSON object in response');
  let depth = 0, inStr = false, esc = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(first, i + 1)); }
  }
  throw new Error('unterminated JSON object in response');
}

// Free models on OpenRouter are rate-limited per-provider (20 req/min,
// ~50–1000 req/day) AND churn over time, so try a few in turn — a throttled
// or delisted upstream never blocks the whole assistant. Ordered fastest
// first for the structured-JSON extraction this assistant needs.
const AI_MODELS = [
  'inclusionai/ling-3.0-flash:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

async function assistantAIFallback(raw) {
  const key = (settings.aiKey || '').trim();
  if (!key) return { ok: false, reason: 'no-key' };

  const now = new Date();
  const state = {
    now: now.toISOString(),
    today: dayKey(now),
    tasks: tasks.map((t) => ({
      name: t.name,
      due: t.due || null,
      durationMin: t.durationMin || 0,
      done: !!t.done,
      category: (categories.find((c) => c.id === t.category) || {}).name || null,
    })),
    deadlines: deadlines.map((d) => ({ name: d.name, due: d.due || null, time: d.time || null, done: !!d.done })),
    categories: categories.map((c) => c.name),
    // The assistant's knowledge base: what the user told it about their
    // world (classes/schedule + facts). Sent so it can resolve homework
    // against remembered classes and answer schedule questions.
    memory: {
      classes: assistantMemory.classes,
      facts: assistantMemory.facts,
    },
    history: assistantHistory.slice(-10),
  };

  const system = [
    'You are the assistant inside a desktop productivity app. You control it by replying with a SINGLE JSON object and nothing else.',
    'Schema: {reply: short answer, actions: [{type, ...}, ...]}.',
    'Action types:',
    '  add_task — fields: name, due (YYYY-MM-DD or null), durationMin (number or null), category (name or null).',
    '  add_deadline — fields: name, due (YYYY-MM-DD or null), time (HH:MM 24h or null), category (class name or null).',
    '  complete_task, delete_task, reopen_task, edit_item — field: taskQuery or name (matches tasks AND deadlines).',
    '  edit_item — fields: name or taskQuery (item to change), newName (optional new name), due (YYYY-MM-DD or null), time (HH:MM or null), durationMin (number or null), category (name or null).',
    '  mark_progress — fields: taskQuery, minutes (number).',
    '  start_focus — fields: taskQuery (optional), durationMin (optional number).',
    '  set_view — field: view (one of tasks, calendar, week).',
    '  show_clipboard, show_screenshots, show_stats, open_settings, open_notes — no fields.',
    '  set_mode — field: mode (online or offline).',
    '  reschedule_item — fields: name (the task or deadline to move), due (YYYY-MM-DD), time (HH:MM 24h or null).',
    '  remember_class — fields: name (class name), days (array of 3-letter weekday abbreviations like ["mon","wed","fri"], empty if unknown), time (HH:MM 24h or null).',
    '  remember_fact — field: text (anything the user wants you to keep track of).',
    '  none — no app change; put the full answer in reply.',
    'The app has: tasks (add/complete/delete/reopen/mark progress, with category, duration, due date, recurring), deadlines (with reminders 30/20/10/5 min before), a focus timer (start for a task or a custom duration), three views (tasks/calendar/week), clipboard history, screenshots, quick notes, a daily-stats page, and settings.',
    'The state includes a memory: classes (name, days like ["mon","wed"], time) and facts. Use it to understand the user\'s school/work schedule.',
    'When the user tells you about their classes or schedule, save EACH class with its OWN remember_class action — one message can describe several ("history Mon/Wed 9am, math Tue/Thu 10am" → two actions). Normalize names: title case, drop a trailing "class" word, keep abbreviations like "AP us history".',
    'If a class is given without days or time, save it anyway (empty days/time) and ask in the reply for the missing days and time.',
    'When a task or deadline mentions a remembered class (e.g. "history homework"), set category to that class name for BOTH add_task and add_deadline. When NO date is given, set due to the NEXT occurrence of that class computed from the current date.',
    'When the user says they will work on an existing deadline NOW (e.g. "I\'ll work on this deadline now", "work on <deadline> for 2 hours"), add_task with name = that deadline\'s name, due = today (YYYY-MM-DD), durationMin = any time they mention, and category = that deadline\'s class. Do NOT create a new deadline.',
    'When the user asks to move, reschedule, postpone, or snooze an item ("move X to Friday", "reschedule Y for tomorrow 3pm"), use reschedule_item with the item name and the new absolute due/time.',
    'Answer schedule questions ("what is my next class?", "when is history class?", "what days is math?") with type none, computing the next occurrence from memory.classes days + time and the provided current time — never invent a schedule.',
    'Rules: output valid JSON only; convert relative dates and times (tomorrow, next Thursday, 3pm, in 2 hours) to absolute values using the provided current time; dates are YYYY-MM-DD, times are 24-hour HH:MM.',
    'For questions (what is due, what can you do, what is my progress), use type none and put the full answer in reply using the provided state.',
    'Only complete/delete/reopen/edit items that actually exist in the provided state; match by name. Tasks AND deadlines can be completed, deleted, reopened and edited (edit_item changes whichever matches). When several items match, pick the best one or ask in reply.',
    'Never invent tasks or deadlines. Use the lists you are given.',
    'When a request lists several items (e.g. "plan my day: gym at 7am, standup at 9:30, deep work 10 to 12"), return one action for EACH item in the actions array.',
    'Match the user intent to the best action type. For "start the focus timer for X", use start_focus with taskQuery X. For "show me how much I have done today", use show_stats. For "switch to week view", use set_view.',
  ].join('\n');

  let lastError = null;
  let badKey = false;
  for (const model of AI_MODELS) {
    if (badKey) break;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
          'HTTP-Referer': 'https://localhost',
          'X-Title': 'Halo Assistant',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify({ request: raw, state }) },
          ],
        }),
      });
      if (res.status === 401 || res.status === 403) {
        badKey = true;
        throw new Error('key rejected (HTTP ' + res.status + ')');
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastError = new Error('HTTP ' + res.status + (body ? ' ' + body.slice(0, 160) : ''));
        continue; // free model rate-limited upstream — try the next one
      }
      const data = await res.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) { lastError = new Error('empty response'); continue; }
      const parsed = parseAssistantJson(content);
      const list = parsed && Array.isArray(parsed.actions) ? parsed.actions
        : (parsed && parsed.action ? [parsed.action] : (parsed && parsed.type ? [parsed] : []));
      const applied = assistantApplyActions(list);
      if (applied) return { ok: true, reply: applied };
      const reply = (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) || 'I understood, but I could not map that to an app action.';
      return { ok: true, reply };
    } catch (e) {
      lastError = e;
    }
  }
  if (badKey) return { ok: false, reason: 'bad-key' };
  return { ok: false, reason: 'unavailable' };
}

// Execute a structured action returned by the AI against the real data.
function assistantApplyAction(action) {
  if (!action || typeof action !== 'object') return null;
  const type = action.type;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(action.due || '') ? action.due : '';
  const time = /^\d{2}:\d{2}$/.test(action.time || '') ? action.time : '';
  const durationMin = typeof action.durationMin === 'number' && action.durationMin > 0 ? Math.round(action.durationMin) : 0;

  if (type === 'add_task') {
    let name = assistantCleanName(action.name || '');
    let recur = '';
    if (name) { const rr = assistantExtractRecur(name); if (rr) { name = rr.rest; recur = rr.recur; } }
    if (!name) return 'What should the task be called?';
    let category = '';
    if (action.category) {
      const found = categories.find((c) => c.name.toLowerCase() === String(action.category).toLowerCase());
      if (found) category = found.id;
    }
    // Class-aware: a remembered class tags the category and (without a date)
    // defaults the due date to the class's next meeting.
    let dueDate = due;
    const clsInfo = applyClassTo(name, dueDate ? { due: dueDate, time, rest: name } : null);
    if (clsInfo.when) dueDate = clsInfo.when.due;
    if (!category && clsInfo.category) category = clsInfo.category;
    const t = { id: nextItemId(), name, due: dueDate, durationMin, done: false, category, recur, progressMin: 0 };
    tasks.unshift(t);
    saveTasks(); renderTasks(); refreshActiveView();
    let r = '✅ Added "' + name + '"';
    if (dueDate) r += ' · due ' + fmtDateShort(dueDate);
    if (durationMin) r += ' · ' + Math.round(durationMin / 60 * 10) / 10 + 'h';
    if (category) { const c = categories.find((x) => x.id === category); if (c) r += ' · in ' + c.name; }
    if (clsInfo.cls && clsInfo.classDue) r += ' (next ' + clsInfo.cls.name + ' class)';
    return r + '.';
  }
  if (type === 'remember_class') {
    const def = {
      name: assistantCleanName(action.name || ''),
      days: Array.isArray(action.days) ? action.days : [],
      time: /^\d{2}:\d{2}$/.test(action.time || '') ? action.time : '',
    };
    if (!def.name) return 'What class should I remember?';
    const cls = rememberClass(def.name, def.days, def.time);
    if (!cls) return 'What class should I remember?';
    let r = '🧠 Remembered: ' + cls.name + ' class';
    if (cls.days && cls.days.length) r += ' · ' + cls.days.map((d) => DAY_SHORT[d] || d).join(', ');
    if (cls.time) r += ' · ' + fmtTimeOfDay(cls.time);
    // No schedule yet → ask for it, and route the user's answer through the
    // same follow-up flow the offline parser uses.
    if (!def.days.length && !def.time) {
      ASSISTANT_PENDING.q = {
        mode: 'class-schedule',
        pending: [cls.name],
        hint: 'Tell me the schedule, e.g. "history Mon Wed at 9am".',
      };
      return r + '. What days and time is it? (e.g. "Mon Wed at 9am")';
    }
    return r + '. I will auto-date homework for this class.';
  }
  if (type === 'remember_fact') {
    const text = String(action.text || action.name || '').trim();
    if (!text) return 'What should I remember?';
    assistantMemory.facts.push({ id: nextItemId(), text, at: Date.now() });
    if (assistantMemory.facts.length > 100) assistantMemory.facts = assistantMemory.facts.slice(-100);
    saveMemory();
    return '🧠 Noted — I will remember that.';
  }
  if (type === 'add_deadline') {
    const name = assistantCleanName(action.name || '');
    if (!name) return 'What should the deadline be called?';
    // Class-aware: a remembered class fills in a missing date (next meeting)
    // and tags the deadline so it shows in the class's color.
    const clsInfo = applyClassTo(name, due ? { due, time, rest: name } : null);
    const dlDue = clsInfo.when ? clsInfo.when.due : '';
    const dlTime = clsInfo.when ? clsInfo.when.time : '';
    let category = '';
    if (action.category) {
      const found = categories.find((c) => c.name.toLowerCase() === String(action.category).toLowerCase());
      if (found) category = found.id;
    }
    if (!category && clsInfo.category) category = clsInfo.category;
    const d = { id: nextItemId(), name, due: dlDue, time: dlTime, done: false, category };
    deadlines.unshift(d);
    saveDeadlines(); renderDeadlines(); refreshActiveView(); tickDeadlineReminders();
    warnDeadlineConflict(d);
    let r = '✅ Deadline added: "' + name + '"';
    if (dlDue) r += ' · ' + fmtDateShort(dlDue) + (dlTime ? ' at ' + fmtTimeOfDay(dlTime) : '');
    if (category) { const c = categories.find((x) => x.id === category); if (c) r += ' · in ' + c.name; }
    if (clsInfo.cls && clsInfo.classDue) r += ' (next ' + clsInfo.cls.name + ' class)';
    return r + '. I will remind you 30/20/10/5 min before.';
  }
  if (type === 'complete_task') {
    const q = String(action.taskQuery || action.name || '').trim();
    if (!q) return 'Which task did you finish? (name it)';
    return assistantPickTask(q, 'complete', {});
  }
  if (type === 'delete_task') {
    const q = String(action.taskQuery || action.name || '').trim();
    if (!q) return 'Which task should I remove? (name it)';
    return assistantPickTask(q, 'delete', null);
  }
  if (type === 'reopen_task') {
    const q = String(action.taskQuery || action.name || '').trim();
    if (!q) return 'Which task should I reopen? (name it)';
    return assistantPickTask(q, 'reopen', null);
  }
  if (type === 'mark_progress') {
    const q = String(action.taskQuery || action.name || '').trim();
    const mins = Math.max(1, Math.round(action.minutes || 15));
    if (!q) return 'Which task did you work on? (name it)';
    return assistantPickTask(q, 'progress', { minutes: mins });
  }
  if (type === 'start_focus') {
    const q = String(action.taskQuery || action.name || '').trim();
    const mins = typeof action.durationMin === 'number' && action.durationMin > 0 ? Math.round(action.durationMin) : 0;
    return assistantStartFocus(q, mins);
  }
  if (type === 'set_view') {
    const v = String(action.view || '').toLowerCase();
    if (v === 'tasks' || v === 'calendar' || v === 'week') { api.setMode(v); return '✅ Switched to ' + v + ' view.'; }
    return null;
  }
  if (type === 'reschedule_item') {
    const name = String(action.name || action.taskQuery || '').trim();
    if (!name) return 'What should I reschedule? (name it)';
    const when = { due: due || dayKeyNow(), time };
    const r = rescheduleByName(name, when);
    if (r.error) return r.error;
    const where = fmtDateShort(r.when.due) + (r.when.time ? ' at ' + fmtTimeOfDay(r.when.time) : '');
    return '🔁 Moved "' + r.name + '" to ' + where + '.';
  }
  if (type === 'edit_item') {
    const q = String(action.taskQuery || action.name || '').trim();
    if (!q) return 'Which item should I edit? (name it)';
    const extra = {
      newName: String(action.newName || '').trim(),
      due: /^\d{4}-\d{2}-\d{2}$/.test(action.due || '') ? action.due : '',
      time: /^\d{2}:\d{2}$/.test(action.time || '') ? action.time : '',
      durationMin: typeof action.durationMin === 'number' && action.durationMin > 0 ? Math.round(action.durationMin) : 0,
      category: String(action.category || '').trim(),
    };
    if (!extra.newName && !extra.due && !extra.time && !extra.durationMin && !extra.category) {
      return 'What should I change about "' + q + '"? (e.g. due, time, durationMin, category, newName)';
    }
    return assistantEditSearch(q, { ...extra, when: null });
  }
  if (type === 'show_clipboard') { openClipboardVault(); return '📋 Opened your clipboard history.'; }
  if (type === 'show_screenshots') { api.openScreenshotOverlay(); return '📷 Screenshot tool opened — drag to capture.'; }
  if (type === 'show_stats') { api.openStats(); return '📊 Opened your daily stats.'; }
  if (type === 'open_settings') { openSettingsPanel(); return '⚙️ Opened Settings.'; }
  if (type === 'open_notes') { api.openNotesPanel(); return '📝 Opened Quick Notes.'; }
  if (type === 'set_mode') {
    const m = String(action.mode || '').toLowerCase();
    if (m === 'offline' || m === 'online') { settings.assistantMode = m; saveSettings(); updateAssistantModeUI(); broadcastAssistantMode(); return m === 'offline' ? '📴 Offline mode — instant local commands only.' : '🌐 Online mode — AI-first.'; }
    return null;
  }
  return null; // none / unknown → use the model reply
}

// Apply a list of actions (multi-action responses like "plan my day").
function assistantApplyActions(actions) {
  if (!Array.isArray(actions)) return null;
  const replies = [];
  for (const a of actions) {
    const r = assistantApplyAction(a);
    if (r) replies.push(r);
  }
  return replies.length ? replies.join('\n') : null;
}

// Start the focus timer for a task (by name) or a custom session.
function assistantStartFocus(query, minutes) {
  const lq = String(query || '').toLowerCase().trim();
  let t = null;
  if (lq) {
    t = tasks.find(x => !x.done && x.name.toLowerCase().includes(lq));
    if (!t) t = tasks.find(x => x.name.toLowerCase().includes(lq));
  }
  if (lq && !t) return 'No task matching "' + query + '" — try "list my tasks".';
  if (t) openFocusPanel(t.id);
  else openFocusPanel();
  if (minutes > 0) {
    const m = Math.max(1, Math.min(720, Math.round(minutes)));
    focusTimer.totalMs = m * 60000;
    focusTimer.remainingMs = focusTimer.totalMs;
    const minEl = document.getElementById('focus-minutes');
    if (minEl) minEl.value = m;
  }
  startFocus();
  return '⏱️ Focus started' + (t ? ' for "' + t.name + '"' : '') + ' — ' + fmtFocus(focusTimer.totalMs) + '.';
}

const DAY_SHORT = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

// "remember my history class is Monday Wednesday at 9am" → store the class.
// One message can describe several ("my schedule: history mon wed 9am, math
// tue thu 10am") — all are saved. A bare name list ("my classes are history,
// math, bio") is saved too, then the schedule is asked for as a follow-up.
function assistantRememberClass(q) {
  const defs = assistantExtractClassDefs(q);
  if (!defs || !defs.length) return null; // not a class definition — fall through to other handlers
  const saved = defs.map((d) => rememberClass(d.name, d.days, d.time)).filter(Boolean);
  if (!saved.length) return null;

  const hasSchedule = (c) => (c.days && c.days.length) || c.time;
  const withSchedule = saved.filter(hasSchedule);
  const bare = saved.filter((c) => !hasSchedule(c));

  if (!withSchedule.length) {
    ASSISTANT_PENDING.q = {
      mode: 'class-schedule',
      pending: bare.map((c) => c.name),
      hint: 'Tell me the schedule, e.g. "history Mon Wed at 9am, math Tue Thu at 10am".',
    };
    return '🧠 Saved: ' + bare.map((c) => c.name).join(', ') + '.\nWhat days and times? e.g. "history Mon Wed at 9am, math Tue Thu at 10am"';
  }

  let r = '🧠 Remembered: ' + withSchedule.map((c) => {
    let s = c.name + ' class';
    if (c.days && c.days.length) s += ' · ' + c.days.map((d) => DAY_SHORT[d] || d).join(', ');
    if (c.time) s += ' · ' + fmtTimeOfDay(c.time);
    return s;
  }).join('\n');

  if (bare.length) {
    ASSISTANT_PENDING.q = {
      mode: 'class-schedule',
      pending: bare.map((c) => c.name),
      hint: 'Tell me the schedule, e.g. "history Mon Wed at 9am, math Tue Thu at 10am".',
    };
    r += '\nAlso saved: ' + bare.map((c) => c.name).join(', ') + ' — what days and times?';
  } else {
    r += '\nI will auto-date homework for these classes (next class day when you give no date). Say "what classes do I have?" to review.';
  }
  return r;
}

// "what classes do I have?" → list the remembered classes.
function assistantListClasses() {
  if (!assistantMemory.classes.length) return 'No classes remembered yet — tell me e.g. "remember my history class is Monday Wednesday at 9am".';
  const lines = assistantMemory.classes.map((c, i) => {
    let s = (i + 1) + '. ' + c.name + ' class';
    if (c.days && c.days.length) s += ' · ' + c.days.map((d) => DAY_SHORT[d] || d).join(', ');
    if (c.time) s += ' · ' + fmtTimeOfDay(c.time);
    return s;
  });
  return '🧠 Your classes:\n' + lines.join('\n');
}

// "what's my next class?" / "when is history class?" — answered from memory.
function assistantNextClass(q) {
  if (!assistantMemory.classes.length) {
    return 'No classes remembered yet — tell me your schedule, e.g. "remember my schedule: history Mon Wed 9am".';
  }
  const now = new Date();
  // Specific class: "when is history class?" → its next meeting.
  const specific = q.match(/when\s+is\s+(?:the\s+|my\s+)?(.+?)\s+class\b/i);
  if (specific) {
    const name = assistantCleanName(specific[1]);
    const cls = assistantMemory.classes.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!cls) return 'I don\'t remember a "' + name + '" class. Say "what classes do I have?" to see them.';
    return formatNextClass(cls, now);
  }
  // "what's my next class?" → the earliest upcoming meeting across all classes.
  const upcoming = assistantMemory.classes
    .map((c) => ({ cls: c, dt: nextClassDateTime(c, now) }))
    .filter((x) => x.dt)
    .sort((a, b) => a.dt.getTime() - b.dt.getTime());
  if (!upcoming.length) {
    return 'Your remembered classes have no days yet — set them in the 🏫 Classes panel or tell me e.g. "history Mon Wed at 9am".';
  }
  return formatNextClass(upcoming[0].cls, now, upcoming[0].dt);
}

function formatNextClass(cls, now, dt) {
  dt = dt || nextClassDateTime(cls, now);
  if (!dt) return cls.name + ' class has no schedule yet.';
  let s = '🏫 ' + (cls.days && cls.days.length ? 'Next ' : '') + cls.name + ' class: ' + fmtDateShort(dayKey(dt));
  if (cls.time) s += ' at ' + fmtTimeOfDay(cls.time);
  return s + '.';
}

// If an item mentions a remembered class, tag its category and (when no date
// was given) due it on the class's next meeting. Returns { when, category,
// cls, classDue } — classDue is true when the date was filled from the class.
function applyClassTo(name, when) {
  const cls = assistantMatchClass(assistantMemory, name);
  if (!cls) return { when, category: '', classDue: false };
  let category = '';
  const c = categories.find((x) => x.name.toLowerCase() === cls.name.toLowerCase());
  if (c) category = c.id;
  let classDue = false;
  if (!when && cls.days && cls.days.length) {
    const d = nextClassDate(cls, new Date());
    if (d) { when = { due: d, time: '', rest: name }; classDue = true; }
  }
  return { when, category, cls, classDue };
}

function assistantAdd(q) {
  const explicitTask = /^add\s+(?:a\s+|an\s+)?task\b/i.test(q);
  let rest = q.replace(/^(?:please\s+)?(?:add|create|new)\s+(?:a\s+|an\s+)?(?:task\s+)?/i, '');
  // "add a test ..." / "add deadline ..." / "add meeting ..." → deadline
  // (explicit "add task ..." always makes a task).
  const isDeadline = !explicitTask && /\b(?:deadline|event|test|exam|quiz|meeting|appointment|appt|reminder|call)\b/i.test(rest);

  // Duration: "for 2h" / "for 35 minutes" / "lasting 45 min"
  let durationMin = 0;
  const dur = rest.match(/(?:for|lasting|about)\s+(\d+(?:\.\d+)?)\s*(h(?:ours?)?|hrs?|m(?:ins?)?|min(?:utes?)?)\b/i);
  if (dur) {
    const n = parseFloat(dur[1]);
    durationMin = Math.round(dur[2][0].toLowerCase() === 'h' ? n * 60 : n);
    rest = rest.replace(dur[0], ' ');
  }

  // Category: "in <category>" at the end (tasks only)
  let category = '';
  let warn = '';
  if (!isDeadline) {
    const cat = rest.match(/\bin\s+([a-z0-9 _-]+?)\s*$/i);
    if (cat) {
      const found = categories.find(c => c.name.toLowerCase() === cat[1].trim().toLowerCase());
      if (found) {
        category = found.id;
        rest = rest.replace(cat[0], ' ');
      } else {
        warn = ' (no category "' + cat[1].trim() + '" found — added without one)';
      }
    }
  }

  let when = assistantExtractWhen(rest);
  let name = assistantCleanName(when ? when.rest : rest);
  let recur = '';
  if (name) { const rr = assistantExtractRecur(name); if (rr) { name = rr.rest; recur = rr.recur; } }
  if (!name) {
    return isDeadline
      ? 'What should the deadline be called? Try: "add a test next Thursday at 2pm"'
      : 'What should the task be called? Try: "add task <name> for 2h by Friday 3pm"';
  }

  // Class-aware: a remembered class tags the category and (without a date)
  // defaults the due date to the class's next meeting.
  const clsInfo = applyClassTo(name, when);
  when = clsInfo.when;
  if (!category && clsInfo.category) category = clsInfo.category;

  if (isDeadline) {
    const dl = { id: nextItemId(), name, due: when ? when.due : '', time: when ? when.time : '', done: false, category };
    deadlines.unshift(dl);
    saveDeadlines();
    renderDeadlines();
    refreshActiveView();
    tickDeadlineReminders();
    warnDeadlineConflict(dl);
    let r = '✅ Deadline added: "' + name + '"';
    if (when) r += ' · ' + fmtDateShort(when.due) + (when.time ? ' at ' + fmtTimeOfDay(when.time) : '');
    if (clsInfo.cls && !clsInfo.classDue && !when) r += ' · 🧠 ' + clsInfo.cls.name + ' class (tell me its days to auto-date)';
    r += '. I\'ll remind you 30/20/10/5 min before.';
    return r;
  }

  tasks.unshift({ id: nextItemId(), name, due: when ? when.due : '', durationMin, done: false, category, recur, progressMin: 0 });
  saveTasks();
  renderTasks();
  refreshActiveView();
  let reply = '✅ Added "' + name + '"';
  if (durationMin) reply += ' · ' + Math.round(durationMin / 60 * 10) / 10 + 'h';
  if (when) reply += ' · due ' + fmtDateShort(when.due) + (when.time ? ' at ' + fmtTimeOfDay(when.time) : '');
  if (clsInfo.cls && !clsInfo.classDue && !when) reply += ' · 🧠 ' + clsInfo.cls.name + ' class (tell me its days to auto-date)';
  if (category) {
    const c = categories.find(x => x.id === category);
    if (c) reply += ' · in ' + c.name;
  }
  return reply + '.' + warn;
}

function assistantComplete(q) {
  let rest = q;
  let actualMin = 0;
  const dur = rest.match(/for\s+(\d+(?:\.\d+)?)\s*(h(?:ours?)?|hrs?|mins?|minutes?)\b/i);
  if (dur) {
    const n = parseFloat(dur[1]);
    actualMin = Math.round(dur[2][0].toLowerCase() === 'h' ? n * 60 : n);
    rest = rest.replace(dur[0], ' ');
  }
  const query = rest
    .replace(/^(?:i\s+)?(?:have\s+|just\s+)?(?:completed?|done|finished?|did|knocked\s+out|checked\s+off|got\s+done)\s+(?:with\s+)?(?:the\s+)?(?:task\s+)?/i, '')
    .trim();
  return assistantPickTask(query, 'complete', { actualMin });
}

function assistantDelete(q) {
  const query = q
    .replace(/^(?:please\s+)?(?:delete|remove|drop|get\s+rid\s+of)\s+(?:the\s+)?(?:task\s+)?/i, '')
    .trim();
  return assistantPickTask(query, 'delete', null);
}

// Move the matching task (preferred) or deadline to a new date/time.
function rescheduleByName(name, when) {
  const tl = String(name || '').toLowerCase().trim();
  if (!tl) return { error: 'Which item should I move? (name it)' };
  const t = tasks.find((x) => !x.done && x.name.toLowerCase().includes(tl))
         || tasks.find((x) => x.name.toLowerCase().includes(tl));
  const d = !t
    ? (deadlines.find((x) => !x.done && x.name.toLowerCase().includes(tl))
       || deadlines.find((x) => x.name.toLowerCase().includes(tl)))
    : null;
  if (!t && !d) return { error: 'No task or deadline matching "' + name + '" — try "list my tasks".' };
  if (t) {
    t.due = when.due;
    saveTasks(); renderTasks(); refreshActiveView();
    return { moved: 'task', name: t.name, when };
  }
  d.due = when.due; d.time = when.time;
  saveDeadlines(); renderDeadlines(); refreshActiveView(); tickDeadlineReminders(); warnDeadlineConflict(d);
  return { moved: 'deadline', name: d.name, when };
}

// "move <name> to <when>" / "reschedule <name> for <when>" / "snooze <name>
// until <when>" — moves a task or deadline to a new date/time.
function assistantReschedule(q) {
  let rest = String(q || '').replace(/^(?:please\s+)?(?:reschedule|move|snooze|postpone|push|bump)\s+(?:the\s+|my\s+|that\s+)?/i, '');
  const m = rest.match(/^(.*?)\s+(?:to|for|until|till|on|by|at)\s+(.+)$/i);
  if (!m) return 'Move what, to when? Try: "move <name> to tomorrow 3pm".';
  const name = assistantCleanName(m[1]);
  const when = assistantExtractWhen(m[2]);
  if (!name) return 'Which item should I move? (name it)';
  if (!when) return 'Move it to when? Try "tomorrow 3pm" or "next Thursday at 2pm".';
  const r = rescheduleByName(name, when);
  if (r.error) return r.error;
  const where = fmtDateShort(r.when.due) + (r.when.time ? ' at ' + fmtTimeOfDay(r.when.time) : '');
  return '🔁 Moved "' + r.name + '" to ' + where + '.';
}

function assistantPickTask(query, mode, extra) {
  if (!query) {
    return mode === 'complete' ? 'Which task or deadline did you finish? (name it)' : 'Which task or deadline should I remove? (name it)';
  }
  const lq = query.toLowerCase();
  const numMatch = lq.match(/^task\s*(\d+)$/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (ASSISTANT_PENDING.q && ASSISTANT_PENDING.q.matches) {
      const t = ASSISTANT_PENDING.q.matches[n - 1];
      if (t) { const p = ASSISTANT_PENDING.q; ASSISTANT_PENDING.q = null; return assistantApply(p.mode, t, p.extra); }
    }
    const t = tasks[n - 1];
    if (t) return assistantApply(mode, { kind: 'task', item: t }, extra);
    return 'I don\'t see task #' + n + '.';
  }
  // Drop trailing kind words so "complete the math test deadline" matches
  // the item named "math test" instead of hunting for a row called
  // "math test deadline".
  const cleanLq = lq.replace(/\s+(?:deadline|task|reminder|event|item|appointment|meeting|assignment)\s*$/, '');
  let matches = tasks.filter(t => !t.done && t.name.toLowerCase().includes(cleanLq)).map(item => ({ kind: 'task', item }));
  if (!matches.length) matches = tasks.filter(t => t.name.toLowerCase().includes(cleanLq)).map(item => ({ kind: 'task', item }));
  // Deadlines can be completed/deleted/reopened too.
  if (!matches.length) matches = deadlines.filter(d => !d.done && d.name.toLowerCase().includes(cleanLq)).map(item => ({ kind: 'deadline', item }));
  if (!matches.length) matches = deadlines.filter(d => d.name.toLowerCase().includes(cleanLq)).map(item => ({ kind: 'deadline', item }));
  if (!matches.length) {
    return 'No task or deadline matching "' + query + '" — try "list my tasks" to see what\'s there.';
  }
  if (matches.length === 1) return assistantApply(mode, matches[0], extra);
  ASSISTANT_PENDING.q = {
    mode, matches: matches.slice(0, 5), extra,
    hint: 'I asked which one — reply with the number (e.g. "2").',
  };
  const lines = matches.slice(0, 5).map((m, i) =>
    (i + 1) + '. "' + m.item.name + '"' + (m.item.due ? ' · ' + fmtDateShort(m.item.due) : '')).join('\n');
  return 'I found a few — which one?\n' + lines + '\n\n(Reply with the number)';
}

// Apply an action to a matched {kind: 'task'|'deadline', item} (a raw task
// object is also accepted and treated as a task). Handles complete/delete/
// reopen for BOTH kinds, progress for tasks, and edit for both.
function assistantApply(mode, entry, extra) {
  const t = entry && entry.item ? entry.item : entry; // tolerate raw task objects
  const isDeadline = !!(entry && entry.kind === 'deadline');
  if (mode === 'complete') {
    if (isDeadline) {
      if (t.done) return '"' + t.name + '" is already done ✅';
      completeDeadline(t.id);
      return '✅ Completed "' + t.name + '". Nice work! 🎉';
    }
    if (t.done) return '"' + t.name + '" is already done ✅';
    if (extra && extra.actualMin) t.actualMin = extra.actualMin;
    completeTask(t.id);
    return '✅ Completed "' + t.name + '"' + (extra && extra.actualMin ? ' — logged ' + extra.actualMin + ' min' : '') + '. Nice work! 🎉';
  } else if (mode === 'delete') {
    if (isDeadline) deleteDeadline(t.id);
    else deleteTask(t.id);
    return '🗑 Removed "' + t.name + '".';
  } else if (mode === 'reopen') {
    if (!t.done) return '"' + t.name + '" is already open.';
    if (isDeadline) reopenDeadline(t.id);
    else reopenTask(t.id);
    return '🔓 Reopened "' + t.name + '".';
  } else if (mode === 'progress') {
    if (isDeadline) return 'Progress tracking applies to tasks — for the deadline try "complete ' + t.name + '" or "edit ' + t.name + '".';
    if (t.done) return '"' + t.name + '" is already done — reopen it first.';
    const mins = (extra && extra.minutes) || 15;
    const dur = Math.max(1, t.durationMin || 60);
    t.progressMin = Math.min(dur, (t.progressMin || 0) + mins);
    recordProgressLog(t.id, mins);
    saveTasks(); renderTasks(); refreshActiveView();
    const pct = taskProgressPct(t);
    return '📈 Logged ' + mins + ' min on "' + t.name + '" — now ' + pct + '% done.';
  } else if (mode === 'edit') {
    return applyItemEdit(entry, extra || {});
  }
  return '';
}

// "edit <name> …" / "rename <name> to <new>" / "update <name> …" — change a
// task or deadline's name / date / time / duration / category from the chat.
function assistantEdit(q) {
  const isRename = /^(?:please\s+)?rename\b/i.test(q);
  let rest = String(q || '').replace(/^(?:please\s+)?(?:edit|update|modify|change|rename)\s+(?:the\s+|my\s+|that\s+)?/i, '');
  let newName = '';
  const rn = rest.match(/^(.*?)\s+to\s+(?:be\s+)?(.+)$/i);
  if (isRename) {
    if (!rn) return 'Rename what, to what? Try: "rename write report to write essay".';
    rest = rn[1];
    newName = assistantCleanName(rn[2]);
  }
  const when = assistantExtractWhen(rest);
  const name = assistantCleanName(when ? when.rest : rest);
  if (!name) return 'What should I edit? Try: "edit the math test to next Thursday 2pm".';
  // Duration: "for 2h" / "for 35 minutes" (tasks only).
  let durationMin = 0;
  const dur = rest.match(/(?:for|lasting|about)\s+(\d+(?:\.\d+)?)\s*(h(?:ours?)?|hrs?|m(?:ins?)?|min(?:utes?)?)\b/i);
  if (dur) {
    const n = parseFloat(dur[1]);
    durationMin = Math.round(dur[2][0].toLowerCase() === 'h' ? n * 60 : n);
  }
  // Category / class tag: "in <category>" at the end.
  let category = '';
  const cat = rest.match(/\bin\s+([a-z0-9 _-]+?)\s*$/i);
  if (cat) {
    const found = categories.find(c => c.name.toLowerCase() === cat[1].trim().toLowerCase());
    if (found) category = found.id;
  }
  const extra = { newName, when, durationMin, category };
  if (!newName && !when && !durationMin && !category) {
    return 'What should I change? Try "edit <name> to tomorrow 3pm" or "rename <name> to <new name>".';
  }
  return assistantEditSearch(name, extra);
}

// Find the item to edit (task OR deadline); ask which one when several match.
function assistantEditSearch(query, extra) {
  const lq = String(query || '').toLowerCase().replace(/\s+(?:deadline|task|reminder|event|item|appointment|meeting|assignment)\s*$/, '');
  const tks = tasks.filter(t => !t.done && t.name.toLowerCase().includes(lq)).map(item => ({ kind: 'task', item }));
  const dls = deadlines.filter(d => !d.done && d.name.toLowerCase().includes(lq)).map(item => ({ kind: 'deadline', item }));
  const all = [...tks, ...dls];
  if (!all.length) {
    return 'No task or deadline matching "' + query + '" — try "list my tasks" to see what\'s there.';
  }
  if (all.length === 1) return applyItemEdit(all[0], extra);
  ASSISTANT_PENDING.q = { mode: 'edit', matches: all.slice(0, 5), extra, hint: 'I asked which one — reply with the number (e.g. "2").' };
  const lines = all.slice(0, 5).map((m, i) =>
    (i + 1) + '. "' + m.item.name + '"' + (m.item.due ? ' · ' + fmtDateShort(m.item.due) : '')).join('\n');
  return 'I found a few — edit which one?\n' + lines + '\n\n(Reply with the number)';
}

// Apply a change set to a matched {kind, item}. Empty fields mean "leave as
// is" — only what the user actually specified is overwritten.
function applyItemEdit(entry, extra) {
  const it = entry.item;
  const changes = [];
  const when = extra.when || null;
  const newName = String(extra.newName || '').trim();
  const rawDue = extra.due != null ? String(extra.due) : (when ? when.due : '');
  const rawTime = extra.time != null ? String(extra.time) : (when ? when.time : '');
  const durationMin = typeof extra.durationMin === 'number' && extra.durationMin > 0 ? Math.round(extra.durationMin) : 0;
  // The AI passes a category NAME; resolve it to the stored id exactly like
  // add_task / add_deadline do, so the tag keeps its color and label.
  let category = '';
  if (extra.category) {
    const found = categories.find((c) => c.name.toLowerCase() === String(extra.category).trim().toLowerCase());
    if (found) category = found.id;
  }

  if (newName) { it.name = newName; changes.push('renamed to "' + it.name + '"'); }
  if (rawDue) { it.due = rawDue; changes.push('due ' + fmtDateShort(rawDue) + (rawTime ? ' at ' + fmtTimeOfDay(rawTime) : '')); }
  else if (rawTime && entry.kind === 'deadline') { it.due = dayKeyNow(); it.time = rawTime; changes.push('today at ' + fmtTimeOfDay(rawTime)); }
  if (rawTime && entry.kind === 'deadline') { it.time = rawTime; }
  if (durationMin && entry.kind === 'task') { it.durationMin = durationMin; changes.push('now ' + fmtMin(durationMin)); }
  if (category) { it.category = category; const c = categories.find(x => x.id === category); if (c) changes.push('in ' + c.name); }
  if (!changes.length) return 'Nothing to change for "' + it.name + '" — say what to update.';
  if (entry.kind === 'deadline') {
    saveDeadlines(); renderDeadlines(); refreshActiveView(); tickDeadlineReminders(); warnDeadlineConflict(it);
  } else {
    saveTasks(); renderTasks(); refreshActiveView();
  }
  return '✏️ "' + it.name + '" ' + changes.join(' · ') + '.';
}

function assistantHandleFollowUp(q) {
  const p = ASSISTANT_PENDING.q;
  if (!p) return null;

  // Reminder awaiting a "when" answer — parse the time phrase from the reply.
  if (p.mode === 'remind' && !p.matches) {
    const when = assistantExtractWhen(q);
    if (!when) return null;
    ASSISTANT_PENDING.q = null;
    const dl = { id: nextItemId(), name: p.name, due: when.due, time: when.time, done: false };
    deadlines.unshift(dl);
    saveDeadlines();
    renderDeadlines();
    refreshActiveView();
    tickDeadlineReminders();
    warnDeadlineConflict(dl);
    return '✅ Reminder set: "' + p.name + '" · ' + fmtDateShort(when.due) + (when.time ? ' at ' + fmtTimeOfDay(when.time) : '') + '.';
  }

  // Schedule answer for classes saved without days/times — parse the reply's
  // class definitions and attach them to the matching pending classes.
  if (p.mode === 'class-schedule') {
    let defs = assistantExtractClassDefs(q);
    // The answer usually has no "schedule:" introducer — force schedule
    // context so bare "history Mon Wed at 9am, math Tue Thu at 10am" parses.
    if (!defs || !defs.length) defs = assistantExtractClassDefs('schedule: ' + q);
    // A bare schedule with no names ("mon wed at 9am") attaches to the single
    // pending class.
    if ((!defs || !defs.length) && p.pending && p.pending.length === 1) {
      const d = assistantExtractClassDefs('schedule: ' + p.pending[0] + ' ' + q)[0];
      if (d) defs = [d];
    }
    if (!defs || !defs.length) return null; // keep waiting for the schedule
    const out = [];
    defs.forEach((d) => {
      const match = (p.pending || []).find((n) => n.toLowerCase() === d.name.toLowerCase());
      out.push(rememberClass(match || d.name, d.days, d.time));
    });
    const hasSchedule = (c) => (c.days && c.days.length) || c.time;
    const still = out.filter((c) => !hasSchedule(c));
    if (still.length) {
      ASSISTANT_PENDING.q = { mode: 'class-schedule', pending: still.map((c) => c.name), hint: 'Tell me the schedule, e.g. "history Mon Wed at 9am".' };
    } else {
      ASSISTANT_PENDING.q = null;
    }
    let r = '✅ Updated schedule:\n' + out.map((c) => {
      let s = c.name + ' · ' + (c.days && c.days.length ? c.days.map((d) => DAY_SHORT[d] || d).join(', ') : 'no days');
      if (c.time) s += ' · ' + fmtTimeOfDay(c.time);
      return s;
    }).join('\n');
    if (still.length) r += '\nStill need days/times for: ' + still.map((c) => c.name).join(', ') + '.';
    return r;
  }

  if (!p.matches) return null;
  const lq = q.toLowerCase();
  const wordMatch = lq.match(/^(?:the\s+)?(?:first|1st|second|2nd|third|3rd)\b/);
  const numMatch = lq.match(/(?:^|\s)(\d{1,2})\s*[.)]?$/);
  let n = 0;
  if (wordMatch) n = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3 }[wordMatch[1]] || 0;
  else if (numMatch) n = parseInt(numMatch[1], 10);
  if (!n) return null;
  const t = p.matches[n - 1];
  if (!t) return 'That number isn\'t on the list — pick one of the ones I showed.';
  ASSISTANT_PENDING.q = null;
  return assistantApply(p.mode, t, p.extra);
}

function assistantRemind(q) {
  let rest = q.replace(/^remind\s+(me\s+)?(to\s+)?/i, '');
  const when = assistantExtractWhen(rest);
  if (!when) {
    const name = assistantCleanName(rest);
    if (name) {
      ASSISTANT_PENDING.q = { mode: 'remind', matches: null, name, hint: 'Tell me a time, like "at 5pm" or "tomorrow 9am".' };
      return '⏰ When should I remind you about "' + name + '"? (try "at 5pm", "in 30 minutes", "tomorrow 9am")';
    }
    return 'What should I remind you about — and when? Try: "remind me at 5pm to call mom"';
  }
  const name = assistantCleanName(when.rest);
  if (!name) return 'Remind you about what? Try: "remind me at 5pm to call mom"';
  const dl = { id: nextItemId(), name, due: when.due, time: when.time, done: false };
  deadlines.unshift(dl);
  saveDeadlines();
  renderDeadlines();
  refreshActiveView();
  tickDeadlineReminders();
  warnDeadlineConflict(dl);
  return '✅ Reminder set: "' + name + '" · ' + fmtDateShort(when.due) + (when.time ? ' at ' + fmtTimeOfDay(when.time) : '') + '.\nYou\'ll get a heads-up 30/20/10/5 min before.';
}

function assistantDue() {
  const todayK = dayKey(new Date());
  const tomorrowK = dayKey(new Date(Date.now() + 86400000));
  const dueTasks = tasks.filter(t => !t.done && t.due === todayK);
  const dueDl = deadlines.filter(d => !d.done && d.due === todayK);
  const tmTasks = tasks.filter(t => !t.done && t.due === tomorrowK);
  const tmDl = deadlines.filter(d => !d.done && d.due === tomorrowK);
  if (!dueTasks.length && !dueDl.length && !tmTasks.length && !tmDl.length) {
    return 'Nothing due today or tomorrow — enjoy the calm! ☕';
  }
  const lines = [];
  if (dueTasks.length) lines.push('📌 Today\'s tasks: ' + dueTasks.map(t => '"' + t.name + '"' + (t.durationMin ? ' (' + Math.round(t.durationMin / 60 * 10) / 10 + 'h)' : '')).join(', '));
  if (dueDl.length) lines.push('⏰ Today\'s deadlines: ' + dueDl.map(d => '"' + d.name + '" at ' + fmtTimeOfDay(d.time)).join(', '));
  if (tmTasks.length) lines.push('🗓️ Tomorrow: ' + tmTasks.map(t => '"' + t.name + '"').join(', '));
  if (tmDl.length) lines.push('🗓️ Tomorrow deadlines: ' + tmDl.map(d => '"' + d.name + '" at ' + fmtTimeOfDay(d.time)).join(', '));
  return '📅 Today — ' + fmtDateShort(todayK) + ':\n' + lines.join('\n');
}

function assistantList() {
  const open = tasks.filter(t => !t.done);
  const dls = deadlines.filter(d => !d.done);
  if (!open.length && !dls.length) {
    return 'No open tasks or deadlines — add one: "add task <name> for 1h by Friday"';
  }
  const lines = [];
  if (open.length) {
    lines.push('🗒️ Tasks (' + open.length + '):');
    open.slice(0, 12).forEach((t, i) => lines.push(
      (i + 1) + '. "' + t.name + '" · ' + (t.due ? fmtDateShort(t.due) + (t.durationMin ? ' · ' + Math.round(t.durationMin / 60 * 10) / 10 + 'h' : '') : 'no date')));
  }
  if (dls.length) {
    lines.push('⏰ Deadlines (' + dls.length + '):');
    dls.slice(0, 8).forEach(d => lines.push('• "' + d.name + '" · ' + fmtDateShort(d.due) + (d.time ? ' ' + fmtTimeOfDay(d.time) : '')));
  }
  return lines.join('\n');
}

// "how was my week?" — a quick recap of completed items, focus time,
// deadlines and the streak for the current Mon→Sun week.
function assistantWeekRecap() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday 00:00
  const startMs = start.getTime();

  const doneTasks = tasks.filter(t => t.done && (t.completedAt || 0) >= startMs);
  const doneDls = deadlines.filter(d => d.done && (d.completedAt || 0) >= startMs);
  const focusMin = focusHistory
    .filter(s => (s.time || 0) >= startMs)
    .reduce((a, s) => a + (s.minutes || 0), 0);
  const weekKey = dayKey(start);
  const dueThisWeek = deadlines.filter(d => d.due && d.due >= weekKey && d.due <= dayKeyNow());
  const pending = dueThisWeek.filter(d => !d.done);

  const total = doneTasks.length + doneDls.length;
  const lines = [
    '📊 Your week · since ' + start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ':',
    '• ✅ ' + total + ' item' + (total === 1 ? '' : 's') + ' completed',
    '• ⏱️ ' + fmtMin(focusMin) + ' of focused time logged',
    '• 🔥 streak: ' + (streak.count || 0) + ' day' + (streak.count === 1 ? '' : 's'),
  ];
  if (dueThisWeek.length) {
    const met = dueThisWeek.filter(d => d.done).length;
    lines.push('• ⏰ ' + met + '/' + dueThisWeek.length + ' deadlines met' + (pending.length ? ' (' + pending.length + ' ahead)' : ' — all done! 🎉'));
  }
  if (total === 0 && focusMin === 0) lines.push('\nNothing logged yet this week — a 25-min focus session counts. 🌱');
  return lines.join('\n');
}

// "plan my day: gym at 7am; standup 9:30; deep work 10 to 12" — split a list
// into items; anything with a clock becomes a deadline, the rest become tasks.
function assistantPlan(raw) {
  const items = String(raw || '').split(/;\s*|\n|(?:\s+and\s+)/i).map(s => s.trim()).filter(Boolean);
  if (!items.length) return 'Give me your list, e.g. "plan my day: gym at 7am; standup 9:30; deep work 10 to 12".';
  let dls = 0, tks = 0;
  items.forEach(item => {
    const when = assistantExtractWhen(item);
    const name = assistantCleanName(when ? when.rest : item);
    if (!name) return;
    if (when && when.time) {
      deadlines.unshift({ id: nextItemId(), name, due: when.due || dayKeyNow(), time: when.time, done: false });
      dls++;
    } else {
      tasks.unshift({ id: nextItemId(), name, due: (when && when.due) || '', durationMin: 0, done: false, recur: '', progressMin: 0 });
      tks++;
    }
  });
  if (!dls && !tks) return 'I could not find anything to plan there — try "plan my day: gym at 7am; standup 9:30".';
  saveDeadlines(); saveTasks(); renderDeadlines(); renderTasks(); refreshActiveView(); tickDeadlineReminders();
  const parts = [];
  if (dls) parts.push(dls + ' deadline' + (dls === 1 ? '' : 's'));
  if (tks) parts.push(tks + ' task' + (tks === 1 ? '' : 's'));
  return '🗓️ Planned ' + parts.join(' + ') + '.';
}

// "I have a test next Thursday at 2pm" → a deadline with reminders. Without a
// date, a remembered class fills it in: "I have history homework" → the next
// History class.
function assistantEvent(q) {
  const rest = q
    .replace(/(?:i\s+have|i've\s+got|ive\s+got|i\s+got|got|there'?s|there\s+is|we\s+have)\s+(?:a\s+|an\s+|the\s+)?/i, '');
  const when0 = assistantExtractWhen(rest);
  const name = assistantCleanName(when0 ? when0.rest : rest);
  if (!name) return null;
  const clsInfo = applyClassTo(name, when0);
  const when = clsInfo.when;
  if (!when) return null; // no date at all → let other handlers try
  const dl = { id: nextItemId(), name, due: when.due, time: when.time, done: false, category: clsInfo.category };
  deadlines.unshift(dl);
  saveDeadlines();
  renderDeadlines();
  refreshActiveView();
  tickDeadlineReminders();
  warnDeadlineConflict(dl);
  let r = '✅ Added "' + name + '" as a deadline · ' + fmtDateShort(when.due) + (when.time ? ' at ' + fmtTimeOfDay(when.time) : '');
  if (clsInfo.cls && clsInfo.classDue) r += ' (next ' + clsInfo.cls.name + ' class)';
  return r + '.\nI\'ll remind you 30/20/10/5 min before.';
}

// "I'll work on this deadline now" / "work on <deadline> for 2h" → turn a
// deadline into a task you do TODAY, keeping the deadline's name and class tag.
function assistantWorkOnDeadline(q) {
  const m = q.match(/\b(?:work\s+on|start\s+(?:working\s+on|on)|tackle|get\s+started\s+on|grind\s+on)\s+(.+)$/i);
  if (!m) return null; // not a "work on …" phrase — let other handlers try
  let rest = m[1].trim();

  // Time it takes: "for 2h" / "for 30 min" / "in 2 hours".
  let durationMin = 0;
  const dur = rest.match(/(?:for|in|lasting|about)\s+(\d+(?:\.\d+)?)\s*(h(?:ours?)?|hrs?|m(?:ins?)?|min(?:utes?)?)\b/i);
  if (dur) {
    durationMin = Math.round(parseFloat(dur[1]) * (dur[2][0].toLowerCase() === 'h' ? 60 : 1));
    rest = rest.replace(dur[0], ' ');
  }
  // Trailing time words: "now", "right now", "today".
  rest = rest.replace(/\b(?:right\s+now|now|today)\b/gi, ' ').replace(/\s+/g, ' ').trim();

  // "this/that deadline" (or nothing left) → the most recent open deadline.
  let target = null;
  const bare = /^(?:this|that|it|one)$/i.test(rest);
  const withNoun = /^(?:this|that|the|my|it)\s+(?:deadline|task|one|assignment|thing)$/i.test(rest);
  if (!rest || bare || withNoun) {
    target = deadlines.find((d) => !d.done) || deadlines[0];
  } else {
    const lname = assistantCleanName(rest).toLowerCase();
    target = deadlines.find((d) => !d.done && d.name.toLowerCase().includes(lname))
          || deadlines.find((d) => d.name.toLowerCase().includes(lname));
  }
  if (!target) return 'Which deadline do you want to work on? Say "work on <name> now" or "work on this deadline now".';

  let category = target.category || '';
  if (!category) {
    const clsInfo = applyClassTo(target.name, null);
    if (clsInfo.category) category = clsInfo.category;
  }
  tasks.unshift({ id: nextItemId(), name: target.name, due: dayKey(new Date()), durationMin: durationMin || 0, done: false, category, recur: '', progressMin: 0 });
  saveTasks(); renderTasks(); refreshActiveView();
  let r = '✅ Made "' + target.name + '" a task for today';
  if (durationMin) r += ' · ' + fmtMin(durationMin);
  if (category) { const c = categories.find((x) => x.id === category); if (c) r += ' · in ' + c.name; }
  return r + '. Get after it! 🔥';
}

// "start the focus timer for X" / "start a 25 minute focus" → focus timer.
function assistantFocusCommand(q) {
  let rest = q.replace(/^(?:please\s+)?(?:start|begin|launch|run)\s+(?:a\s+|an\s+|the\s+)?(?:focus|pomodoro)\s+(?:timer|session)?\s*/i, '');
  // Custom duration: "25 minutes", "25 min", "25m"
  let minutes = 0;
  const dur = rest.match(/\b(\d+)\s*(?:min|mins|minutes?)\b/i) || rest.match(/\b(\d+)\s*h(?:ours?|rs?)?\b/i);
  if (dur) {
    const n = parseInt(dur[1], 10);
    minutes = /\bh/i.test(dur[0]) ? n * 60 : n;
    rest = rest.replace(dur[0], ' ');
  }
  const name = assistantCleanName(rest.replace(/^(?:for|on|with)\s+/i, ''));
  return assistantStartFocus(name, minutes);
}

// "switch to week view" / "go to calendar" → change the active view.
function assistantViewCommand(q) {
  const m = q.match(/\b(tasks|calendar|week)\b/i);
  if (!m) return null;
  const v = m[1].toLowerCase();
  api.setMode(v);
  return '✅ Switched to ' + v + ' view.';
}

// "show clipboard" / "show screenshots" → the window renders the history
// as clickable cards; the in-planner panel just gets the header text.
function assistantClipboard(lq) {
  const wantImages = /screenshot|screen\s*shot|image|picture|photo|img/.test(lq);
  return {
    kind: 'clipboard',
    filter: wantImages ? 'image' : null,
    text: wantImages
      ? '🖼️ Your recent screenshots & images — click any one to copy it back:'
      : '📋 Your clipboard history — click any item to copy it back:',
  };
}

document.getElementById('assistant-close').addEventListener('click', (e) => { e.stopPropagation(); closeAssistantPanel(); });
document.getElementById('assistant-send').addEventListener('click', (e) => { e.stopPropagation(); assistantSend(); });
// Enter sends; Shift+Enter inserts a newline (the input is a growing
// textarea so multi-line messages are possible).
document.getElementById('assistant-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    assistantSend();
  }
});
// Auto-grow the textarea up to a few lines; Enter keeps sending.
function autoGrowAssistantInput() {
  const el = document.getElementById('assistant-input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(96, el.scrollHeight) + 'px';
}
document.getElementById('assistant-input').addEventListener('input', autoGrowAssistantInput);
document.getElementById('assistant-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  e.stopPropagation();
  const input = document.getElementById('assistant-input');
  input.value = chip.dataset.q || '';
  assistantSend();
});
// "Full view" opens the whole workspace (AI + notes + stats + planner + info).
document.getElementById('assistant-fullview')?.addEventListener('click', (e) => {
  e.stopPropagation();
  api.fullView();
});

// Assistant window (Electron): answer its messages with the same brain.
if (window.electronAPI && window.electronAPI.onAssistantMessage) {
  window.electronAPI.onAssistantMessage(({ text }) => {
    if (!text) return;
    assistantAnswer(text).then(assistantEmit);
  });
}

// === Assistant mode (online/offline) sync + slash-command skeleton hint ===
function broadcastAssistantMode() {
  if (hasElectron && window.electronAPI && window.electronAPI.sendAssistantMode) {
    window.electronAPI.sendAssistantMode(settings.assistantMode);
  }
}
if (window.electronAPI && window.electronAPI.onAssistantSetMode) {
  window.electronAPI.onAssistantSetMode((mode) => {
    settings.assistantMode = mode === 'offline' ? 'offline' : 'online';
    saveSettings();
    updateAssistantModeUI();
    broadcastAssistantMode();
  });
}
if (window.electronAPI && window.electronAPI.onAssistantGetMode) {
  window.electronAPI.onAssistantGetMode(() => broadcastAssistantMode());
}
// A panel window just opened and wants the current daily-protocol accent.
if (window.electronAPI && window.electronAPI.onProtocolGet) {
  window.electronAPI.onProtocolGet(() => broadcastProtocol());
}
if (window.electronAPI && window.electronAPI.onConflictResolve) {
  window.electronAPI.onConflictResolve(({ id }) => {
    if (!id) return;
    deadlines = deadlines.filter((d) => d.id !== id);
    saveDeadlines(); renderDeadlines(); refreshActiveView();
    showToast('🗑 Removed the new deadline');
  });
}

// === Live stats sync to the stats window ===
// The planner owns the data; push a fresh snapshot to the stats window
// whenever tasks/deadlines/streak/focus change so the dashboard updates in
// real time instead of waiting on the old 3s poll.
function buildStatsPayload() {
  return {
    tasks: Array.isArray(tasks) ? tasks : [],
    deadlines: Array.isArray(deadlines) ? deadlines : [],
    streak: streak || { last: '', count: 0 },
    focusHistory: Array.isArray(focusHistory) ? focusHistory : [],
  };
}
function pushStats() {
  if (hasElectron && window.electronAPI && window.electronAPI.sendStats) {
    window.electronAPI.sendStats(buildStatsPayload());
  }
}
if (window.electronAPI && window.electronAPI.onStatsRequest) {
  window.electronAPI.onStatsRequest(() => pushStats());
}

const SLASH_SKELETONS = {
  task: ['name', 'date', 'category', 'time', 'duration'],
  deadline: ['name', 'date', 'time'],
  complete: ['task name'], done: ['task name'], finish: ['task name'],
  delete: ['task name'], rm: ['task name'], remove: ['task name'], reopen: ['task name'],
  progress: ['task name', 'minutes'], log: ['task name', 'minutes'],
  focus: ['task name?', 'minutes?'], pomodoro: ['task name?', 'minutes?'],
  view: ['tasks | calendar | week'],
  plan: ['item; item; …'], schedule: ['item; item; …'],
  week: ['(weekly recap)'], recap: ['(weekly recap)'], weekly: ['(weekly recap)'],
  classes: ['(list my classes)'], class: ['(list my classes)'],
  forget: ['class name'],
  mode: ['online | offline'],
};
function updateAssistantHint() {
  const hint = document.getElementById('assistant-hint');
  if (!hint) return;
  const input = document.getElementById('assistant-input');
  const v = input ? input.value : '';
  if (!v || v[0] !== '/') { hint.hidden = true; hint.textContent = ''; return; }
  const m = v.match(/^\/([a-z]+)/i);
  const cmd = m ? m[1].toLowerCase() : '';
  const fields = SLASH_SKELETONS[cmd];
  if (!fields) { hint.hidden = false; hint.textContent = 'Commands: /task · /deadline · /complete · /delete · /reopen · /progress · /focus · /view · /plan · /week · /classes · /forget · /stats · /list · /due · /help · /mode'; return; }
  const typed = v.slice(m[0].length);
  const commas = (typed.match(/,/g) || []).length;
  const idx = Math.min(commas, fields.length - 1);
  hint.innerHTML = '';
  const pre = document.createElement('span'); pre.textContent = '/' + cmd + ' '; pre.style.opacity = '0.55'; hint.appendChild(pre);
  fields.forEach((f, i) => {
    if (i > 0) { const c = document.createElement('span'); c.textContent = ', '; c.style.opacity = '0.45'; hint.appendChild(c); }
    const s = document.createElement('span'); s.textContent = f;
    if (i === idx) { s.style.color = '#67e8f9'; s.style.fontWeight = '700'; }
    else { s.style.opacity = '0.5'; }
    hint.appendChild(s);
  });
  hint.hidden = false;
}
function updateAssistantModeUI() {
  const btn = document.getElementById('assistant-mode-toggle');
  if (btn) btn.textContent = settings.assistantMode === 'offline' ? '📴' : '🌐';
  updateAssistantHint();
}
(function initAssistantModeUI() {
  document.getElementById('assistant-mode-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    settings.assistantMode = settings.assistantMode === 'offline' ? 'online' : 'offline';
    saveSettings();
    updateAssistantModeUI();
    broadcastAssistantMode();
  });
  document.getElementById('assistant-input')?.addEventListener('input', updateAssistantHint);
  updateAssistantModeUI();
})();

// === Quick Notes (browser fallback panel) ===
function loadNotes() {
  try { return JSON.parse(localStorage.getItem('wolf-notes')) || []; } catch (e) { return []; }
}
function saveNotes() { localStorage.setItem('wolf-notes', JSON.stringify(notes)); }

// The note currently open in the textarea (null = composing a fresh note).
// Persisted (key 'wolf-notes-open') so the last note stays open when the
// panel is reopened — no need to re-select it.
let notesOpenId = null;
let notesSaveTimer = null;

function notesPersistOpen() {
  try { localStorage.setItem('wolf-notes-open', notesOpenId == null ? '' : String(notesOpenId)); } catch (e) {}
}
function notesReadOpen() {
  try { const v = localStorage.getItem('wolf-notes-open'); return v ? Number(v) : null; } catch (e) { return null; }
}

function openNotesPanel() {
  notesPanel.classList.remove('panel-hidden');
  infoPopup.classList.add('popup-hidden');
  settingsPanel.classList.add('panel-hidden');
  vaultPanel.classList.add('popup-hidden');
  // Restore the last-open note (or the most recent one on first ever open).
  const savedId = notesReadOpen();
  const initial = notes.find(x => x.id === savedId) || notes[0] || null;
  notesOpenId = initial ? initial.id : null;
  const input = document.getElementById('notes-input');
  if (input) input.value = initial ? initial.text : '';
  notesPersistOpen();
  renderNotes();
  sendInteractiveBounds();
}

function closeNotesPanel() {
  notesFlushSave();
  notesPanel.classList.add('panel-hidden');
  sendInteractiveBounds();
}

// Autosave: typing updates the open note in place and saves in real time
// (debounced so localStorage isn't thrashed on every keystroke).
function notesFlushSave() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = null;
  const input = document.getElementById('notes-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    // Empty note: drop the one we were editing (an empty note is useless).
    if (notesOpenId != null) {
      notes = notes.filter(x => x.id !== notesOpenId);
      notesOpenId = null;
      notesPersistOpen();
      saveNotes();
      renderNotes();
    }
    return;
  }
  if (notesOpenId != null) {
    const n = notes.find(x => x.id === notesOpenId);
    if (n) { n.text = text; n.time = Date.now(); }
    else notesOpenId = null; // note deleted elsewhere — fall through to create
  }
  if (notesOpenId == null) {
    notesOpenId = Date.now();
    notes.unshift({ id: notesOpenId, text, time: Date.now() });
    notes = notes.slice(0, 50);
    notesPersistOpen();
  }
  saveNotes();
  renderNotes();
}

function notesOpenNote(id) {
  notesOpenId = id;
  const n = notes.find(x => x.id === id);
  const input = document.getElementById('notes-input');
  input.value = n ? n.text : '';
  notesPersistOpen();
  renderNotes();
  input.focus();
}

function notesNewNote() {
  notesFlushSave(); // commit anything still pending before starting fresh
  notesOpenId = null;
  const input = document.getElementById('notes-input');
  input.value = '';
  notesPersistOpen();
  renderNotes();
  input.focus();
}

function renderNotes() {
  const list = document.getElementById('notes-list');
  const prevScroll = list.scrollTop;
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
    txt.title = 'Click to view';

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
      if (notesOpenId === n.id) {
        notesOpenId = null;
        const input = document.getElementById('notes-input');
        if (input) input.value = '';
        notesPersistOpen();
      }
      saveNotes();
      renderNotes();
    });

    row.append(txt, meta, copyBtn, delBtn);
    // Click a saved note to open it in the big textarea.
    row.addEventListener('click', () => notesOpenNote(n.id));
    if (n.id === notesOpenId) row.classList.add('editing');
    list.appendChild(row);
  });
  list.scrollTop = Math.min(prevScroll, list.scrollHeight);
}

// Wire up autosave + the new-note/close buttons once at startup.
(function bindNotesUI() {
  const input = document.getElementById('notes-input');
  const newBtn = document.getElementById('notes-new');
  const closeBtn = document.getElementById('notes-close');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(notesSaveTimer);
      notesSaveTimer = setTimeout(notesFlushSave, 350);
    });
    input.addEventListener('blur', notesFlushSave);
  }
  if (newBtn) newBtn.addEventListener('click', (e) => { e.stopPropagation(); notesNewNote(); });
  if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeNotesPanel(); });
})();

// === Categories sidebar (slide-in from the left) ===
const CATEGORY_PALETTE = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#f97316'];

// First palette colour not already claimed by an existing category, so every
// remembered class gets its own distinct accent (cycles only once all 8 are
// taken). Keeps class tags from colliding with the seeded School/Work colours.
function unusedPaletteColor() {
  const used = new Set(categories.map((c) => String(c.color || '').toLowerCase()));
  for (const color of CATEGORY_PALETTE) {
    if (!used.has(color.toLowerCase())) return color;
  }
  return CATEGORY_PALETTE[categories.length % CATEGORY_PALETTE.length];
}

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

document.getElementById('categories-open').addEventListener('click', (e) => { e.stopPropagation(); openCategoriesPanel(); });
document.getElementById('categories-close').addEventListener('click', (e) => { e.stopPropagation(); closeCategoriesPanel(); });
document.getElementById('categories-add').addEventListener('click', (e) => { e.stopPropagation(); addCategory(); });

// === Classes sidebar (the assistant's remembered schedule — editable here) ===
const CLASS_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLASS_DAY_LABELS = { sun: 'S', mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S' };

function openClassesPanel() {
  classesPanel.classList.remove('panel-hidden');
  renderClasses();
  sendInteractiveBounds();
}

function closeClassesPanel() {
  classesPanel.classList.add('panel-hidden');
  sendInteractiveBounds();
}

// The color category that visually tags a class (created on demand).
function classCategory(cls) {
  let c = categories.find((x) => x.name.toLowerCase() === cls.name.toLowerCase());
  if (!c) {
    c = { id: freshId('cat-'), name: cls.name, color: unusedPaletteColor() };
    categories.push(c);
    saveCategories();
  }
  return c;
}

function renderClasses() {
  const list = document.getElementById('classes-list');
  list.innerHTML = '';
  if (!assistantMemory.classes.length) {
    list.innerHTML = '<div class="cat-empty">No classes yet — tell the assistant “remember my schedule: history Mon Wed 9am” or add one! 🏫</div>';
    return;
  }
  assistantMemory.classes.forEach((cls) => {
    const cat = classCategory(cls);
    const row = document.createElement('div');
    row.className = 'cls-row';
    row.style.setProperty('--cat-color', cat.color);

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'cat-color-input';
    swatch.value = cat.color;
    swatch.title = 'Change color';
    swatch.addEventListener('change', () => {
      cat.color = swatch.value;
      saveCategories();
      renderClasses();
      refreshCategoryUI();
    });

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'cat-name';
    name.value = cls.name;
    name.maxLength = 24;
    name.title = 'Rename';
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v) { name.value = cls.name; return; }
      cls.name = v;
      const c2 = categories.find((x) => x.id === cat.id);
      if (c2) c2.name = v;
      saveMemory();
      saveCategories();
      renderClasses();
      refreshCategoryUI();
    });

    const days = document.createElement('div');
    days.className = 'cls-days';
    CLASS_DAY_KEYS.forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cls-day' + ((cls.days || []).includes(d) ? ' on' : '');
      b.textContent = CLASS_DAY_LABELS[d];
      b.title = DAY_SHORT[d] || d;
      b.addEventListener('click', () => {
        const arr = cls.days || (cls.days = []);
        const i = arr.indexOf(d);
        if (i >= 0) arr.splice(i, 1); else arr.push(d);
        arr.sort((a, b2) => CLASS_DAY_KEYS.indexOf(a) - CLASS_DAY_KEYS.indexOf(b2));
        saveMemory();
        renderClasses();
      });
      days.appendChild(b);
    });

    const time = document.createElement('input');
    time.type = 'time';
    time.className = 'cls-time';
    time.value = cls.time || '';
    time.title = 'Start time';
    time.addEventListener('change', () => {
      cls.time = /^\d{2}:\d{2}$/.test(time.value) ? time.value : '';
      saveMemory();
    });

    const bell = document.createElement('button');
    bell.type = 'button';
    bell.className = 'cls-bell' + (cls.remind === false ? ' off' : '');
    bell.textContent = cls.remind === false ? '🔕' : '🔔';
    bell.title = cls.remind === false ? 'Class reminders off' : 'Remind me before this class';
    bell.addEventListener('click', () => {
      cls.remind = cls.remind === false ? true : false;
      saveMemory();
      renderClasses();
    });

    const del = document.createElement('button');
    del.className = 'cat-del';
    del.textContent = '🗑';
    del.title = 'Delete class';
    del.addEventListener('click', () => deleteClassRow(cls));

    // Labeled schedule row: "Days" + the day toggles, then "Time" + the
    // start-time picker — so it's obvious the class days and time are
    // editable right here.
    const daysWrap = document.createElement('div');
    daysWrap.className = 'cls-field';
    const daysLbl = document.createElement('span');
    daysLbl.className = 'cls-fld';
    daysLbl.textContent = 'Days';
    daysWrap.appendChild(daysLbl);
    daysWrap.appendChild(days);

    const timeWrap = document.createElement('div');
    timeWrap.className = 'cls-field';
    const timeLbl = document.createElement('span');
    timeLbl.className = 'cls-fld';
    timeLbl.textContent = 'Time';
    timeWrap.appendChild(timeLbl);
    timeWrap.appendChild(time);

    row.append(swatch, name, bell, del, daysWrap, timeWrap);
    list.appendChild(row);
  });
}

function addClassRow() {
  assistantMemory.classes.push({ id: freshId('cls-'), name: 'New class', days: [], time: '', remind: true });
  saveMemory();
  renderClasses();
  const input = document.getElementById('classes-list').querySelector('.cls-row:last-child .cat-name');
  if (input) { input.focus(); input.select(); }
}

function deleteClassRow(cls) {
  assistantMemory.classes = assistantMemory.classes.filter((c) => c !== cls);
  saveMemory();
  const cat = categories.find((c) => c.name.toLowerCase() === cls.name.toLowerCase());
  if (cat) {
    let changed = false;
    tasks.forEach((t) => { if (t.category === cat.id) { t.category = ''; changed = true; } });
    categories = categories.filter((c) => c !== cat);
    saveCategories();
    if (changed) saveTasks();
  }
  renderClasses();
  refreshCategoryUI();
  showToast('🏫 Class deleted');
}

document.getElementById('classes-open').addEventListener('click', (e) => { e.stopPropagation(); openClassesPanel(); });
document.getElementById('classes-close').addEventListener('click', (e) => { e.stopPropagation(); closeClassesPanel(); });
document.getElementById('classes-add').addEventListener('click', (e) => { e.stopPropagation(); addClassRow(); });

// The planner is always visible in the sidebar; these just toggle its glass.
function showPlanner() {
  tasksPanel.classList.remove('panel-hidden');
  renderDeadlines();
  renderTasks();
  sendInteractiveBounds();
}

// === Planner: Deadlines (top half) + Daily Tasks (bottom half) ===
function loadTasks() {
  try {
    const arr = JSON.parse(localStorage.getItem('wolf-tasks')) || [];
    return arr.map(t => Object.assign({ category: '', progressMin: 0 }, t));
  } catch (e) { return []; }
}
function saveTasks() { localStorage.setItem('wolf-tasks', JSON.stringify(tasks)); pushStats(); }

function loadDeadlines() {
  try {
    const arr = JSON.parse(localStorage.getItem('wolf-deadlines')) || [];
    return arr.map(d => Object.assign({ category: '' }, d));
  } catch (e) { return []; }
}
function saveDeadlines() { localStorage.setItem('wolf-deadlines', JSON.stringify(deadlines)); pushStats(); }

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

// === Assistant memory (persistent knowledge base) ===
// The AI keeps track of the user's world: their classes/schedule (so a
// message like "history homework due tomorrow" resolves against a remembered
// History class) plus arbitrary facts. Stored in localStorage like every
// other piece of data the planner owns.
function loadMemory() {
  try {
    const m = JSON.parse(localStorage.getItem(MEMORY_KEY));
    return {
      classes: Array.isArray(m && m.classes) ? m.classes : [],
      facts: Array.isArray(m && m.facts) ? m.facts : [],
    };
  } catch (e) { return { classes: [], facts: [] }; }
}
function saveMemory() { localStorage.setItem(MEMORY_KEY, JSON.stringify(assistantMemory)); }

// Monotonic unique id — Date.now() alone collides when several classes are
// saved in the same millisecond (the AI can return many remember_class
// actions in one response), which made categories share an id and tasks get
// tagged with the wrong class.
let uidSeq = 0;

// === Monotonic item id ===
// Tasks and deadlines are created with `id: Date.now()`, which collides when
// several items are added in the same millisecond (the AI can return many
// add_task/add_deadline actions in ONE response, /plan loops rapidly, and a
// scheduled reminder can land on the same tick). Two items sharing an id
// silently break edit/complete/delete and the reminder records — they'd all
// target the wrong row. Numbers are kept so existing numeric comparisons
// keep working, but the sequence never reuses an id and always stays above
// every id already in storage (clock skew / restored backups can't collide).
let lastItemId = -1;
function nextItemId() {
  if (lastItemId === -1) {
    // Seed above everything already stored once, on first use.
    [tasks, deadlines].forEach((arr) => arr.forEach((x) => {
      if (typeof x.id === 'number' && x.id > lastItemId) lastItemId = x.id;
    }));
  }
  const t = Math.max(Date.now(), lastItemId + 1);
  lastItemId = t;
  return t;
}
function freshId(prefix) {
  uidSeq += 1;
  return (prefix || '') + Date.now().toString(36) + '-' + uidSeq.toString(36) + Math.random().toString(36).slice(2, 6);
}

// Store (or update) a remembered class; also creates a color category named
// after it so its tasks show tagged with the class.
function rememberClass(name, days, time) {
  name = assistantCleanName(name || '');
  // Never store a trailing "class"/"course" word in the name itself.
  name = name.replace(/\s+(?:class|course|subject)\s*$/i, '').trim();
  if (!name) return null;
  const cleanDays = Array.isArray(days)
    ? days.map((d) => String(d).toLowerCase().slice(0, 3)).filter((d) => /^(sun|mon|tue|wed|thu|fri|sat)$/.test(d))
    : [];
  const cleanTime = /^\d{2}:\d{2}$/.test(time || '') ? time : '';
  const existing = assistantMemory.classes.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) { existing.days = cleanDays; existing.time = cleanTime; }
  else assistantMemory.classes.push({ id: freshId('cls-'), name, days: cleanDays, time: cleanTime });
  saveMemory();
  // Color-tag the class so its homework shows under the class color.
  if (!categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    categories.push({ id: freshId('cat-'), name, color: unusedPaletteColor() });
    saveCategories();
  }
  return existing || assistantMemory.classes[assistantMemory.classes.length - 1];
}

// One-time self-heal for data written before ids were made collision-proof:
// the AI could save several classes in a single response, each with the same
// Date.now() id, so categories (and the class list) ended up sharing ids and
// tasks pointed at an ambiguous id. Regenerate unique ids and remap every
// task to the category whose name actually matches it.
function repairMemoryIds() {
  let changed = false;

  // Classes: drop duplicate names, guarantee unique ids.
  const seenNames = new Set();
  const seenClassIds = new Set();
  const classes = [];
  for (const c of assistantMemory.classes) {
    const name = String(c.name || '').trim();
    if (!name || seenNames.has(name.toLowerCase())) { changed = true; continue; }
    seenNames.add(name.toLowerCase());
    if (!c.id || seenClassIds.has(c.id)) { c.id = freshId('cls-'); changed = true; }
    seenClassIds.add(c.id);
    classes.push(c);
  }
  assistantMemory.classes = classes;

  // Categories: drop duplicate names, guarantee unique ids, and remember which
  // old ids were shared so tasks can be re-pointed at the right one.
  const catSeenNames = new Set();
  const idToCats = new Map();
  for (const c of categories) {
    if (!idToCats.has(c.id)) idToCats.set(c.id, []);
    idToCats.get(c.id).push(c);
  }
  const newCats = [];
  for (const c of categories) {
    const name = String(c.name || '').trim();
    if (!name || catSeenNames.has(name.toLowerCase())) { changed = true; continue; }
    catSeenNames.add(name.toLowerCase());
    const group = idToCats.get(c.id) || [c];
    if (group.length > 1 || !c.id) { c.id = freshId('cat-'); changed = true; }
    newCats.push(c);
  }
  categories = newCats;

  if (changed) {
    // Re-point tasks whose category id was shared by several categories (the
    // AI could also have tagged a task with the wrong shared id entirely —
    // e.g. "RUSH: Migration Map" pointing at the Calc BC group). Match the
    // task name against every category so it lands on the right class.
    tasks.forEach((t) => {
      if (!t.category) return;
      const group = idToCats.get(t.category);
      if (!group || group.length < 2) return; // id wasn't ambiguous — leave it
      const match = categories.find((c) => t.name.toLowerCase().includes(c.name.toLowerCase()));
      t.category = match ? match.id : group[0].id;
    });
    saveMemory();
    saveCategories();
    saveTasks();
  }
}

// Remove a remembered class (and its auto-created category).
function forgetClass(name) {
  const q = String(name || '').toLowerCase().trim();
  const cls = assistantMatchClass(assistantMemory, q) || assistantMemory.classes.find((c) => c.name.toLowerCase() === q);
  if (!cls) return 'No remembered class matching "' + name + '" — say /classes to see them.';
  assistantMemory.classes = assistantMemory.classes.filter((c) => c !== cls);
  saveMemory();
  // Drop the auto-created category too (only if it was never manually used).
  const cat = categories.find((c) => c.name.toLowerCase() === cls.name.toLowerCase());
  if (cat && !tasks.some((t) => t.category === cat.id)) {
    categories = categories.filter((c) => c !== cat);
    saveCategories();
  }
  return '🧠 Forgot the ' + cls.name + ' class.';
}

// Names the old assistant parser used to mangle ("daily task called X").
const MANGLED_NAME = /^(?:(?:the|a|an|my)\s+)?(?:(?:daily|recurring|quick|new|another)\s+)?task\s+(?:called|named|titled)\b/i;

// Migrate the legacy task shape (estimateMin/workedMin) → durationMin, clamp
// sub-minute estimates to "no duration", and repair names the old parser mangled.
function migrateTasks() {
  let changed = false;
  tasks = tasks.map(t => {
    let out = typeof t.durationMin === 'number' ? { ...t } : {
      id: t.id,
      name: t.name,
      due: t.due || '',
      durationMin: t.estimateMin || 60,
      done: !!t.done,
      completedAt: t.done ? Date.now() : undefined,
      progressMin: 0,
    };
    if (out !== t) changed = true;
    // Sub-minute estimates (0.4 etc. from old code) read as "no duration".
    if (typeof out.durationMin === 'number') {
      const rounded = Math.round(out.durationMin);
      if (rounded < 1 && out.durationMin !== 0) { out.durationMin = 0; changed = true; }
      else if (rounded !== out.durationMin) { out.durationMin = rounded; changed = true; }
    }
    // Repair mangled names only when they start with task filler, so legit
    // names like "task force notes" or "Pickleball under workout" are kept.
    if (MANGLED_NAME.test(out.name || '')) {
      const repaired = assistantCleanName(out.name);
      if (repaired !== out.name) { out.name = repaired; changed = true; }
    }
    return out;
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

// === Schedule conflict detection ===
// Deadlines are points in time; two on the same day within this window are
// treated as an overlap and raise a persistent on-screen warning.
const CONFLICT_WINDOW_MIN = 30;
function timeToMin(time) {
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
function warnDeadlineConflict(dl) {
  if (!dl || !dl.due || !dl.time) return;
  const mine = timeToMin(dl.time);
  if (mine === null) return;
  const windowMin = settings.conflictWindowMin != null ? settings.conflictWindowMin : CONFLICT_WINDOW_MIN;
  const clashes = deadlines.filter((d) => {
    if (d.done || d.id === dl.id || d.due !== dl.due || !d.time) return false;
    const t = timeToMin(d.time);
    return t !== null && Math.abs(t - mine) < windowMin;
  });
  if (!clashes.length) return;
  const detail = clashes.map((d) => '"' + d.name + '" at ' + fmtTimeOfDay(d.time)).join(', ');
  api.showDeadlineAlert({
    id: 'conflict-' + dl.id,
    kind: 'conflict',
    newId: dl.id,
    name: '"' + dl.name + '" overlaps',
    time: 'Also at ' + fmtTimeOfDay(dl.time) + ': ' + detail,
  });
}

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
  // Re-rendering wipes the list (innerHTML='') and resets its scroll to the
  // top — that made the list jump every time it re-rendered (the 60s tick,
  // a completion, …). Capture the position and restore it below, after the
  // rows are rebuilt; the restore happens in the same frame, so no flash.
  const prevScroll = list.scrollTop;
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
  // Open deadlines first (soonest on top); finished ones sink to the bottom
  // under a single "Done" divider. Each day is separated so due dates stay
  // scannable at a glance.
  const sorted = [...visible].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    const d = dueTs(a) - dueTs(b);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  let lastDay = null;
  let doneDividerShown = false;
  sorted.forEach(dl => {
    const key = dl.due || '';
    if (!dl.done) {
      if (key && key !== lastDay) { list.appendChild(buildDayDivider(key)); lastDay = key; }
    } else if (!doneDividerShown) {
      list.appendChild(buildLabelDivider('✓ Done'));
      doneDividerShown = true;
    }
    list.appendChild(buildDeadlineRow(dl));
  });
  list.scrollTop = Math.min(prevScroll, list.scrollHeight);
}

// Compact "clock" badge: how long until the deadline — 5m 2h 1d 3d (the
// chip itself is drawn as a circle around the number). Colored by urgency;
// "Overdue" pulses red.
function relativeDue(dl) {
  const ts = dueTs(dl);
  if (ts === Infinity) return { text: '', cls: '' };
  const diff = ts - Date.now();
  if (diff <= 0) return { text: 'Overdue', cls: 'past' };
  const m = Math.max(1, Math.round(diff / 60000));
  if (m < 60) return { text: m + 'm', cls: m <= 30 ? 'soon' : '' };
  const h = Math.max(1, Math.round(m / 60));
  if (h < 24) return { text: h + 'h', cls: h <= 6 ? 'soon' : '' };
  const d = Math.max(1, Math.round(h / 24));
  return { text: d + 'd', cls: d <= 1 ? 'today' : d === 2 ? 'close' : '' };
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
  // Class/category accent: colored left border + a small glowing tag, so a
  // homework deadline shows which class it belongs to at a glance.
  const cat = categoryOf(dl.category);
  if (cat) {
    row.classList.add('has-cat');
    row.style.setProperty('--cat-color', cat.color);
  }
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
  const kids = [check];
  if (cat) {
    const tag = document.createElement('span');
    tag.className = 'cat-tag';
    tag.style.setProperty('--tag-color', cat.color || '#a5b4fc');
    tag.textContent = cat.name;
    tag.title = cat.name;
    kids.push(tag);
  }
  kids.push(name, chip, dueEl);
  row.append(...kids);
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
  // Same scroll preservation as renderDeadlines: rebuild the rows but keep
  // the list exactly where the user left it (no jump on the 60s tick or
  // after marking progress). Restored in the same frame, so no flash.
  const prevScroll = list.scrollTop;
  list.innerHTML = '';
  const todayStart = todayStartMs();
  // Filter windows — taskFilter is the chip value: 0 = today only,
  // 3 = today + the next two days, 7 = the current week (Mon–Sun).
  // No past days are pulled in, so "3 Days" shows only today/tomorrow/the
  // day after (a task from yesterday no longer lingers crossed out).
  let windowStart, windowEnd;
  if (taskFilter === 0) {
    windowStart = todayStart;
    windowEnd = todayStart + 86400000 - 1;
  } else if (taskFilter === 3) {
    windowStart = todayStart;
    windowEnd = todayStart + 3 * 86400000 - 1;
  } else { // 7 — Monday 00:00 through Sunday 23:59:59 of this week
    const dow = new Date(todayStart).getDay(); // 0 = Sun … 6 = Sat
    windowStart = todayStart - ((dow + 6) % 7) * 86400000;
    windowEnd = windowStart + 7 * 86400000 - 1;
  }
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
  // tasks sink to the bottom under a single "Done" divider.
  const sorted = [...visible].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    const da = a.due || '9999-99-99', db = b.due || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return (b.durationMin || 0) - (a.durationMin || 0);
  });
  // Faint dividing line between each day (open tasks); finished tasks group
  // under one "Done" divider. Past days show their items crossed out.
  let lastDay = null;
  let doneDividerShown = false;
  sorted.forEach(t => {
    const key = t.due || '';
    if (!t.done) {
      if (key && key !== lastDay) {
        list.appendChild(buildDayDivider(key));
        lastDay = key;
      }
    } else if (!doneDividerShown) {
      list.appendChild(buildLabelDivider('✓ Done'));
      doneDividerShown = true;
    }
    list.appendChild(buildTaskRow(t, { past: isPastDay(key) }));
  });
  list.scrollTop = Math.min(prevScroll, list.scrollHeight);
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

// Faint divider label (day names, or "Done" for the completed block).
function buildLabelDivider(text) {
  const div = document.createElement('div');
  div.className = 'day-divider';
  const label = document.createElement('span');
  label.className = 'day-divider-label';
  label.textContent = text;
  div.appendChild(label);
  return div;
}
// Faint per-day divider label for the 3-day / 1-week task views.
function buildDayDivider(key) {
  return buildLabelDivider(dayLabel(key));
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
  name.className = 'item-name'; name.textContent = t.name + (t.recur ? ' ♻️' : ''); name.title = t.name;
  const chip = document.createElement('span');
  chip.className = 'item-chip';
  chip.textContent = fmtDateShort(t.due) + (Math.round(t.durationMin || 0) >= 1 ? ' · ' + fmtMin(t.durationMin) : '');
  const kids = [check];
  if (cat) {
    // Small colored tag with the class/category name, so homework shows which
    // class it belongs to at a glance.
    const tag = document.createElement('span');
    tag.className = 'cat-tag';
    tag.style.setProperty('--tag-color', cat.color || '#a5b4fc');
    tag.textContent = cat.name;
    tag.title = cat.name;
    kids.push(tag);
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
  const delta = minutes - Math.round(t.progressMin || 0);
  t.progressMin = Math.min(dur, Math.max(0, minutes));
  if (delta > 0) recordProgressLog(t.id, delta);
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
    // A short rest signals intent; ~0.65s keeps the preview card feeling
    // instant without firing on every passing flick of the cursor.
    timer = setTimeout(show, 650);
  });
  row.addEventListener('mouseleave', hide);
  row.addEventListener('click', hide);
}

// Structured payload for the hover card (full name, date, time, etc.).
function hoverPayload(item, kind) {
  if (kind === 'deadline') {
    const d = parseDateKey(item.due);
    const cat = categoryOf(item.category);
    return {
      kind: 'deadline',
      name: item.name,
      date: d ? d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : 'No date',
      time: fmtTimeOfDay(item.time) || '—',
      duration: null,
      category: cat ? cat.name : null,
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
  if (t.recur) {
    const nextDue = nextRecurDate(t.recur);
    tasks.unshift({ id: nextItemId(), name: t.name, due: nextDue, durationMin: t.durationMin, done: false, category: t.category, recur: t.recur, progressMin: 0 });
    saveTasks(); renderTasks(); refreshActiveView();
    showToast('♻️ Next "' + t.name + '" scheduled' + (nextDue ? ' · ' + fmtDateShort(nextDue) : ''));
  }
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
      // Round to the wheel's 5-minute step so a stored time like "9:07" (the
      // AI accepts any minute) lands on the closest notch instead of opening
      // on the wrong value.
      tmMins = Math.min(55, Math.round((parseInt(parts[1], 10) || 0) / 5) * 5);
      // 24h (stored) -> 12h + AM/PM (picker)
      tmAmPm = h24 < 12 ? 'AM' : 'PM';
      tmHours = h24 % 12 || 12;
    } else {
      // Clamp to the wheel ranges so an odd stored duration (0m, 30h, 58m)
      // can't silently snap to a different value when the modal opens. The
      // hours wheel spans 0–24, so a full 24h duration survives untouched.
      const totalMin = existing.durationMin || 0;
      tmHours = Math.min(24, Math.floor(totalMin / 60));
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
  // Category/class tag applies to BOTH tasks and deadlines (a deadline can
  // belong to a class, e.g. a test in History).
  imCategory = existing && existing.category ? existing.category : '';
  document.getElementById('im-cat-label').hidden = false;
  document.getElementById('im-cats').hidden = false;
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
    // Tasks: the wheels pick a duration (0–24h), so no AM/PM. Hours step by
    // 1 — 0h is a valid option (pair it with minutes, e.g. 0h 30m) and 24h
    // stays reachable. wheelValues(0, 25) = step 1, so it terminates fine.
    apWheel.hidden = true;
    buildWheel(hWheel, wheelValues(0, 25), tmHours, (v) => { tmHours = v; });
    buildWheel(mWheel, wheelValues(5, 60), tmMins, (v) => { tmMins = v; });
  }
  buildCatChips();
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
    let dl;
    if (imEditId) {
      dl = deadlines.find(x => x.id === imEditId);
      if (dl) { dl.name = name; dl.due = due; dl.time = time; dl.category = imCategory; }
    } else {
      dl = { id: nextItemId(), name, due, time, done: false, category: imCategory };
      deadlines.unshift(dl);
    }
    saveDeadlines();
    renderDeadlines();
    refreshActiveView();
    showToast(imEditId ? '✏️ Deadline updated' : '✅ Deadline added');
    tickDeadlineReminders(); // re-arm reminders for the newly saved deadline
    warnDeadlineConflict(dl);
  } else {
    const durationMin = tmHours * 60 + tmMins;
    if (durationMin < 1) { showToast('⏱ Add a time estimate'); return; }
    if (imEditId) {
      const t = tasks.find(x => x.id === imEditId);
      if (t) { t.name = name; t.due = due; t.durationMin = durationMin; t.category = imCategory; }
    } else {
      tasks.unshift({ id: nextItemId(), name, due, durationMin, done: false, category: imCategory, progressMin: 0 });
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

  // Snap `selected` to the NEAREST value rather than `indexOf` (which returns
  // -1 for a non-step value like a deadline saved at "9:07"), so the wheel
  // opens on the closest notch instead of silently landing on 00:00.
  let selIdx = values.indexOf(selected);
  if (selIdx < 0) {
    let best = 0, bestDist = Infinity;
    values.forEach((v, k) => {
      const dist = typeof v === 'number' && typeof selected === 'number'
        ? Math.abs(v - selected) : Number.MAX_SAFE_INTEGER;
      if (dist < bestDist) { bestDist = dist; best = k; }
    });
    selIdx = best;
  }

  const items = values.map((v, k) =>
    '<div class="tm-wheel-item' + (k === selIdx ? ' sel' : '') + '" data-v="' + fmt(v) + '">' + fmt(v) + '</div>'
  ).join('');
  list.innerHTML = '<div class="tm-wheel-pad"></div>' + items + '<div class="tm-wheel-pad"></div>';
  const maxScroll = () => Math.max(0, list.scrollHeight - list.clientHeight);
  const targetTop = (idx) => Math.max(0, Math.min(maxScroll(), idx * ITEM_H));

  // Re-center after layout settles — the modal may still be laying out when
  // buildWheel runs, so scrollHeight/clientHeight can briefly read 0 and the
  // wheel would open on 00:00 instead of the selected value. Multiple passes
  // (immediate + rAF + timer) guarantee the wheel opens on the right value.
  list.scrollTop = targetTop(selIdx);
  requestAnimationFrame(() => { list.scrollTop = targetTop(selIdx); });
  setTimeout(() => { list.scrollTop = targetTop(selIdx); }, 70);

  // Settle the selection only after scrolling stops — reading scrollTop on
  // every frame mid-glide made the highlight flicker onto neighbouring values.
  const apply = () => {
    const idx = Math.max(0, Math.min(values.length - 1, Math.round(list.scrollTop / ITEM_H)));
    onChange(values[idx]);
    list.querySelectorAll('.tm-wheel-item').forEach((el, k) => el.classList.toggle('sel', k === idx));
  };
  let applyTimer = null;
  const scheduleApply = () => {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(apply, 70);
  };
  // The modal is rebuilt on every open, so these listeners MUST be rebound
  // from scratch each time — otherwise scroll/click handlers stack up on the
  // persistent wheel element and fire dozens of times per interaction.
  if (list._wheelApply) list.removeEventListener('scroll', list._wheelApply);
  list._wheelApply = scheduleApply;
  list.addEventListener('scroll', scheduleApply, { passive: true });

  // Glide one value and lock the highlight now (the smooth scroll keeps the
  // selection in sync; snap alignment below guarantees it settles exactly).
  const glideTo = (idx) => {
    idx = Math.max(0, Math.min(values.length - 1, idx));
    list.scrollTo({ top: targetTop(idx), behavior: 'smooth' });
    onChange(values[idx]);
    list.querySelectorAll('.tm-wheel-item').forEach((el, k) => el.classList.toggle('sel', k === idx));
  };

  // Slower, controlled wheel: one item per paced step. Native wheel scrolled
  // the list far too fast and fought the snap — this feels deliberate.
  if (list._wheelHandler) list.removeEventListener('wheel', list._wheelHandler);
  list._wheelHandler = (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - (list._lastWheel || 0) < 150) return; // pace: one step per 150ms
    list._lastWheel = now;
    const cur = Math.max(0, Math.min(values.length - 1, Math.round(list.scrollTop / ITEM_H)));
    glideTo(cur + (e.deltaY > 0 ? 1 : -1));
  };
  list.addEventListener('wheel', list._wheelHandler, { passive: false });

  if (list._wheelClick) list.removeEventListener('click', list._wheelClick);
  list._wheelClick = (e) => {
    const it = e.target.closest('.tm-wheel-item');
    if (!it) return;
    const v = values.find((x) => fmt(x) === it.dataset.v);
    if (v === undefined) return;
    glideTo(values.indexOf(v));
  };
  list.addEventListener('click', list._wheelClick);

  wrapEl.querySelectorAll('.tm-wheel-btn').forEach((btn) => {
    if (btn._wheelBtn) btn.removeEventListener('click', btn._wheelBtn);
    btn._wheelBtn = () => {
      const dir = parseInt(btn.dataset.dir, 10);
      const cur = Math.max(0, Math.min(values.length - 1, Math.round(list.scrollTop / ITEM_H)));
      glideTo(cur + dir);
    };
    btn.addEventListener('click', btn._wheelBtn);
  });

  // Normalize the live value to the nearest notch once (independent of a
  // scrollTop that may not have settled yet), so a non-step stored value is
  // corrected immediately even if the user saves without touching the wheel.
  onChange(values[selIdx]);
}

// === Planner UI wiring ===
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

// === Class reminders: heads-up before a remembered class starts ===
// One toast per class per day ("🏫 History starts in 12 min"), persisted so
// restarts don't re-fire. Only classes with days + a start time and the bell
// enabled (remind !== false) participate.
let classReminderState = loadClassReminderState();
function loadClassReminderState() {
  try { return JSON.parse(localStorage.getItem('wolf-class-reminders')) || {}; } catch (e) { return {}; }
}
function saveClassReminderState(s) { localStorage.setItem('wolf-class-reminders', JSON.stringify(s)); }

function tickClassReminders() {
  const now = new Date();
  let changed = false;
  assistantMemory.classes.forEach((cls) => {
    if (cls.remind === false || !cls.time || !cls.days || !cls.days.length) return;
    const start = nextClassDateTime(cls, now);
    if (!start || dayKey(start) !== dayKey(now)) return; // not a class day today
    const mins = Math.round((start.getTime() - now.getTime()) / 60000);
    const key = cls.id + '|' + dayKey(now);
    if (classReminderState[key]) return; // already reminded today
    if (mins >= 0 && mins <= 15) {
      classReminderState[key] = true;
      changed = true;
      const label = mins <= 1 ? 'starts now' : 'starts in ' + mins + ' min';
      showToast('🏫 ' + cls.name + ' class ' + label + ' — get ready!', 'toast-alert', 4000);
    }
  });
  if (changed) saveClassReminderState(classReminderState);
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
    pushStats();
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
  pushStats();
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
  ctx.fillText('✨ Halo • Screenshot', rect.width / 2, rect.height / 2 - 10);
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
  pushStats();
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
    kind: 'focus',
  });
  focusHistory = focusHistory.slice(0, MAX_HISTORY);
  saveFocusHistory();
}

// "Mark progress" also lands in the same history (tagged kind:'progress') so
// the stats dashboard's Progress tile + activity graph reflect it per-day.
function recordProgressLog(taskId, minutes) {
  if (!minutes || minutes < 0.5) return;
  const t = tasks.find((x) => String(x.id) === String(taskId));
  focusHistory.unshift({
    id: Date.now() + Math.random(),
    taskId: taskId || '',
    name: t ? t.name : 'Task',
    minutes: Math.round(minutes),
    time: Date.now(),
    kind: 'progress',
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

// Stream the session state to main so it can unsummon the planner into the
// slim focus bar (and keep its ticking countdown fresh). Skipped when the
// state is unchanged, so idle renders send nothing.
let lastFocusSyncKey = '';
function syncFocusBar() {
  if (!hasElectron) return;
  let date = 'No date';
  if (focusTimer.taskId) {
    const t = tasks.find((x) => String(x.id) === String(focusTimer.taskId));
    const d = t && t.due ? parseDateKey(t.due) : null;
    if (d) date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  const state = {
    active: focusTimer.running ||
      (focusTimer.remainingMs > 0 && focusTimer.remainingMs < focusTimer.totalMs),
    running: focusTimer.running,
    name: focusTaskName() || 'Custom session',
    date,
    remaining: Math.max(0, Math.ceil(focusTimer.remainingMs / 1000)),
    total: Math.max(1, Math.ceil(focusTimer.totalMs / 1000)),
  };
  const key = state.active + '|' + state.running + '|' + state.name + '|' + state.date + '|' + state.remaining + '|' + state.total;
  if (key === lastFocusSyncKey) return;
  lastFocusSyncKey = key;
  window.electronAPI.setFocusSession(state);
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
  syncFocusBar(); // keep the focus bar (and the unsummon state) in sync
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
  const elapsed = focusTimer.sessionStartAt ? (Date.now() - focusTimer.sessionStartAt) / 60000 : 0;
  focusTimer.running = false;
  clearInterval(focusTimer.interval);
  focusTimer.interval = null;
  commitFocusProgress();
  // Stopping a session logs its elapsed minutes the same way pausing does —
  // otherwise a session ended with Reset vanished from the history.
  recordFocusSession(focusTimer.taskId, elapsed);
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

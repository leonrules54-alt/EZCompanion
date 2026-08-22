const { app, BrowserWindow, screen, ipcMain, globalShortcut, desktopCapturer, clipboard, nativeImage, Tray, Menu, shell, dialog, safeStorage } = require('electron');
const crypto = require('crypto');

// Bumped whenever the summon/wake/screen logic changes — shown in the tray
// menu so a running app can be identified as new or stale at a glance.
const BUILD_TAG = 'summon-v14';
const HALO_DEBUG = !!process.env.HALO_DEBUG;
// dlog() keeps the old console behavior when HALO_DEBUG is set, and ALWAYS
// appends to a per-launch debug log (userData/halo-debug.log) so window/
// summon/multi-monitor decisions can be diagnosed straight from the file —
// no terminal or env var needed. The log is truncated on each launch and
// capped at 512KB.
const debugLogPath = () => path.join(app.getPath('userData'), 'halo-debug.log');
let debugLogReady = false;
let debugLogSize = 0;
function dlog(...args) {
  const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  if (HALO_DEBUG) console.log('[halo-debug]', line);
  try {
    if (!debugLogReady) {
      fs.writeFileSync(debugLogPath(), ''); // fresh log per launch
      debugLogReady = true;
      debugLogSize = 0;
    }
    if (debugLogSize < 512 * 1024) {
      const entry = `[${new Date().toISOString()}] ${line}\n`;
      fs.appendFileSync(debugLogPath(), entry);
      debugLogSize += entry.length;
    }
  } catch (e) { /* logging must never break the app */ }
}
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { spawn } = require('child_process');

// === App loading (file:// protocol, not localhost) ===
// The app is fully self-contained: every window loads its bundled HTML over
// the file:// protocol, so Electron never depends on an external localhost
// URL. server.js is only an optional static preview for plain browsers.
// If you explicitly want a dev server to serve the renderer, set HALO_DEV_URL
// to its base URL (e.g. HALO_DEV_URL=http://localhost:3737 npm run electron)
// and the windows will load from there instead.
const HALO_DEV_URL = process.env.HALO_DEV_URL ? String(process.env.HALO_DEV_URL).replace(/\/+$/, '') : null;

function loadAppFile(win, file) {
  if (!win || win.isDestroyed()) return;
  if (HALO_DEV_URL) {
    win.loadURL(`${HALO_DEV_URL}/${file}`);
  } else {
    win.loadFile(path.join(__dirname, file)); // file:// protocol
  }
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    // -3 (ERR_ABORTED) fires on benign aborted loads (e.g. a reload racing
    // a close); only log real failures.
    if (code !== -3) dlog(`failed to load ${file}:`, code, desc, url);
  });
}

// === Security: pin windows to the bundled app ===
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    dlog('blocked window.open:', url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const parsed = new URL(url);
      allowed = HALO_DEV_URL
        ? parsed.origin === new URL(HALO_DEV_URL).origin
        : parsed.protocol === 'file:' && fileURLToPath(parsed).startsWith(path.join(__dirname, path.sep));
    } catch (e) { /* unparseable URL: treat as disallowed */ }
    if (!allowed) {
      dlog('blocked navigation to:', url);
      event.preventDefault();
    }
  });
  // Hotkey safety net: if the OS-level global shortcut couldn't be registered
  // (another app may own Ctrl+Shift+S), catch the combo while any app window
  // is focused. The global shortcut consumes the keystroke first when it IS
  // registered, so this only fires in the fallback case.
  win.webContents.on('before-input-event', (_e, input) => {
    if (
      input.type === 'keyDown' &&
      !input.isAutoRepeat && // holding the key must not toggle repeatedly
      input.key &&
      input.key.toLowerCase() === 's' &&
      input.shift &&
      (input.control || input.meta) &&
      !input.alt
    ) {
      toggleSleep();
    }
  });
}

let petWindow = null;
let statusWindow = null;
let screenshotOverlay = null;
let screenshotDisplay = null; // display the screenshot overlay currently targets
let interactiveBounds = [];           // [{x, y, w, h} window-relative coords]
let lastBoundsLog = '';               // last logged bounds JSON (dedupe the 400ms refresh)

let cursorPollInterval = null;
let mouseIgnored = true;

// === Multi-monitor anchoring ===
// The whole app anchors to ONE display: whichever display the cursor is on
// at launch (so with two monitors the app appears where the user clicks),
// falling back to the primary. Every window's position + size derives from
// that display's workArea, and is recomputed whenever the display config
// changes (resolution / scale / plug-unplug / primary switch), so the app
// never ends up off-screen or stranded on the wrong monitor.
let appDisplay = null;

// True when two displays sit at the same screen origin. Position identifies
// a physical monitor far more reliably than Electron's display id, which on
// Windows is NOT guaranteed to stay stable across getAllDisplays() calls — a
// stale id would make anchorDisplay() think the chosen screen vanished and
// silently re-anchor the app to the cursor (undoing a "Summon to Screen").
function sameMonitor(a, b) {
  return a && b && a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y;
}

function anchorDisplay() {
  // Keep the existing anchor while that monitor still exists, but refresh it
  // from the live enumeration so its workArea/bounds are never stale (a
  // resolution/scale change must re-size the windows, not re-lay them out
  // with the old monitor's dimensions). Only re-anchor when the monitor was
  // unplugged (then pick the display under the cursor again).
  if (appDisplay) {
    const fresh = screen.getAllDisplays().find((d) => sameMonitor(d, appDisplay));
    if (fresh) {
      appDisplay = fresh;
      return appDisplay;
    }
  }
  appDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  dlog('anchor display →', appDisplay.id, appDisplay.bounds);
  return appDisplay;
}

// Layout: the pet is a slim always-visible sidebar pinned below the status
// pill in the top-right corner. The planner (deadlines + daily tasks) fills
// the whole window.
const SIDEBAR_W = 430;
// The planner sits right under the status strip (6..52px), so the top edge
// lands just 2px below it — the app reads as one continuous dock instead of
// floating lower with a gap above the strip.
const SIDEBAR_TOP = 54;

// Sidebar height for a given work-area height: full height minus the status
// strip (a touch longer than the old layout), with a 480px floor for tiny
// screens and a hard clamp so the window can never extend past the bottom of
// the work area (a stale size from a bigger monitor must never cut the
// planner off on a smaller one).
function petHeight(waHeight) {
  return Math.min(Math.max(480, waHeight - 50), waHeight - SIDEBAR_TOP);
}

// Clipboard history state: text entries {type:'text', text, time} and image
// entries {type:'image', hash, time} — images are saved as PNG files in
// clipboard-imgs/ (hash-named so re-copies dedupe naturally).
let clipboardHistory = [];
let lastClipboardText = '';
let lastWrittenText = null;
let lastClipboardImageHash = '';
const MAX_HISTORY = 30;

const clipboardHistoryFile = () => path.join(app.getPath('userData'), 'clipboard-history.json');
const clipboardImgDir = () => path.join(app.getPath('userData'), 'clipboard-imgs');

// === Pet Window (always-visible planner sidebar) ===
function createPetWindow() {
  const wa = anchorDisplay().workArea;

  petWindow = new BrowserWindow({
    width: SIDEBAR_W,
    height: petHeight(wa.height),
    x: wa.x + wa.width - SIDEBAR_W - 8,
    y: wa.y + SIDEBAR_TOP,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // Hidden until the user clicks through the startup screen — the planner
    // must never show before/behind the boot card.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Never let occlusion/background throttling pause the pet's painting.
      backgroundThrottling: false,
    },
  });

  hardenWindow(petWindow);
  // app.html = the planner dashboard renderer. It was renamed from index.html
  // so the deployed site's root (index.html) can host the landing page.
  loadAppFile(petWindow, 'app.html');
  watchRenderer(petWindow, 'pet');

  // Click-through by default — the renderer's interactive bounds (planner
  // glass, popups) re-enable interactivity via the cursor poll.
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  mouseIgnored = true;

  startCursorPolling();

  petWindow.on('blur', () => {
    petWindow.webContents.send('window-blurred');
  });
}

// Send a message to the pet renderer, waiting for load if necessary
function sendToPet(channel, payload) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (petWindow.webContents.isLoading()) {
    petWindow.webContents.once('did-finish-load', () => petWindow.webContents.send(channel, payload));
  } else {
    petWindow.webContents.send(channel, payload);
  }
}

// === Smooth card summon (Jarvis-style fade-up) ===
// The floating glass cards (assistant, notes, info, stats, week strip, focus
// bar, hover card) each load summon.js, which replays a clean entrance
// animation whenever main shows the window and a quick fade-out before main
// hides it — instead of the window popping in/out instantly.
function sendToCard(win, channel) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => win.webContents.send(channel));
  } else {
    win.webContents.send(channel);
  }
}

// Show a card window and let its glass fade up. `inactive` (hover card) shows
// without stealing focus.
function showCardWindow(win, opts) {
  if (!win || win.isDestroyed()) return;
  if (opts && opts.inactive) win.showInactive();
  else win.show();
  // Let the compositor paint the window first, then start the entrance.
  setTimeout(() => sendToCard(win, 'summon-animate'), 40);
}

// Windows that are mid-fade-out, keyed by webContents id, so the renderer's
// "fade finished" ack hides exactly the right window.
const pendingCardHide = new Map();

// Hide a card window after its glass fades out (~170ms). Falls back to an
// instant hide if the renderer is busy/hung.
function hideCardWindow(win) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  pendingCardHide.set(win.webContents.id, win);
  win._hideFallback = setTimeout(() => {
    pendingCardHide.delete(win.webContents.id);
    if (win && !win.isDestroyed()) win.hide();
  }, 240);
  sendToCard(win, 'summon-leave');
}

// If a renderer process dies (crash), reload the window and re-apply the
// current sleep/mode state so the app recovers instead of going blank.
function watchRenderer(win, label) {
  win.webContents.on('render-process-gone', (_e, details) => {
    dlog(label, 'renderer gone:', details.reason);
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) {
      win.webContents.reload();
      if (win === petWindow) {
        win.webContents.once('did-finish-load', () => {
          sendToPet('set-sleeping', { value: sleeping });
          sendToPet('set-mode', { view: activeMode === 'week' ? 'tasks' : activeMode });
        });
      }
    }
  });
}

// === Status Window (static overlay title bar, top-right, fully click-through) ===
function createStatusWindow() {
  if (statusWindow) return;
  const wa = anchorDisplay().workArea;

  statusWindow = new BrowserWindow({
    // Same width + right edge as the pet sidebar, so the status bar reads
    // as a slim title strip pinned above the app.
    width: SIDEBAR_W,
    height: 46,
    x: wa.x + wa.width - SIDEBAR_W - 8,
    y: wa.y + 6,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    // Hidden until boot completes — nothing (not even the slim status bar)
    // should appear before/behind the startup screen.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  statusWindow.setAlwaysOnTop(true, 'screen-saver');
  // Purely informational: the bar is never interactive — every click and
  // hover passes straight through it to whatever is underneath.
  statusWindow.setIgnoreMouseEvents(true, { forward: true });
  hardenWindow(statusWindow);
  loadAppFile(statusWindow, 'status.html');
  // Crash recovery: if the status renderer dies, the bar would stay "visible"
  // as a blank transparent strip (looks like the app came back without its
  // status bar). Reload it so the bar always comes back with the app.
  watchRenderer(statusWindow, 'status');
  statusWindow.on('closed', () => { statusWindow = null; });
}

// === Focus bar (slim always-on-top bar shown while a focus session runs) ===
// When a focus timer starts, the whole planner unsummons into this one bar:
// task name + due date + the ticking countdown + pause/stop controls. The
// planner renderer keeps running (backgroundThrottling is off) and streams
// the session state here through main.
let focusBarWindow = null;
let focusSessionActive = false;   // a focus session currently owns the screen
let notesHiddenByFocus = false;   // notes were open when focus unsummoned the app

function createFocusBarWindow() {
  if (focusBarWindow) return;
  const wa = anchorDisplay().workArea;
  focusBarWindow = new BrowserWindow({
    // Same width + right edge as the planner sidebar, parked just below the
    // status bar — reads as the planner's own slim focus strip.
    width: SIDEBAR_W,
    height: 76,
    x: wa.x + wa.width - SIDEBAR_W - 8,
    y: wa.y + 60,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // Never steal focus: the bar pops up over whatever the user is doing and
    // must not yank the keyboard away from the app they're typing in.
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(focusBarWindow);
  loadAppFile(focusBarWindow, 'focusbar.html');
  focusBarWindow.on('closed', () => { focusBarWindow = null; });
}

// Make sure the focus bar exists and is on screen (used when restoring after
// sleep / peek / wake while a session is still running).
function ensureFocusBar() {
  createFocusBarWindow();
  if (focusBarWindow && !focusBarWindow.isDestroyed()) showCardWindow(focusBarWindow);
}

// Top offset (inside the work area) shared by the assistant chat, quick
// notes and stats windows so their top edges align. The old floating
// launcher button + radial ring menu are gone — its actions now live as
// suggestion chips inside the assistant.
const TOP_Y = 24;

// === Middle-column layout (notes / info / stats) ===
// The space between the assistant chat (left) and the planner sidebar (right,
// or the screen edge in Week view) hosts three cards: Notes, Info and the
// Stats dashboard. Notes and Info share the TOP row (Notes left, Info fills
// the space to its right); Stats fills everything below. The layout is the
// same in every view — in Week view it just drops below the week strip.
const NOTES_W = 400;
const NOTES_H = 320;
const STATS_MIN_W = 480;
let notesWindow = null;
let notesHideForCapture = false; // suppress blur-close while the screenshot hides us
let notesHiddenBySleep = false; // notes were open when the app slept — restore on wake
let infoWindow = null;
let infoHiddenBySleep = false;  // info was open when the app slept — restore on wake

// Height of the week strip window for a given work-area height (kept in sync
// with createWeekWindow).
function weekStripHeight(waHeight) {
  return Math.min(430, Math.max(280, Math.round(waHeight * 0.32)));
}

// Shared edges of the middle column.
function midTop(wa) {
  return activeMode === 'week' ? wa.y + weekStripHeight(wa.height) + 14 : wa.y + TOP_Y;
}
function midLeft(wa) {
  return wa.x + ASSISTANT_W + 12;
}
// The middle column ALWAYS stops at the planner sidebar's left edge — even in
// Week view, where the planner is hidden. That right-hand slot is reused for
// Notes + Info instead of letting Stats sprawl into it.
function midRight(wa) {
  return wa.x + wa.width - SIDEBAR_W - 8 - 12;
}

// Normal view: Notes + Info share the TOP row of the middle column (Notes
// left, Info right) and Stats fills the bottom. Week view: Notes + Info stack
// in the planner's old slot on the right; Stats keeps the middle column.
function notesY(wa) { return midTop(wa); }
function notesX(wa) {
  return activeMode === 'week' ? wa.x + wa.width - SIDEBAR_W - 8 : midLeft(wa);
}
function notesW(wa) { return NOTES_W; }
function notesH(wa) { return NOTES_H; }

// Info card geometry.
function infoY(wa) {
  return activeMode === 'week' ? midTop(wa) + NOTES_H + 14 : midTop(wa);
}
function infoX(wa) {
  return activeMode === 'week' ? notesX(wa) : midLeft(wa) + NOTES_W + 12;
}
function infoW(wa) {
  if (activeMode === 'week') return NOTES_W;
  return Math.max(260, midRight(wa) - infoX(wa));
}
function infoH(wa) {
  if (activeMode === 'week') return Math.max(200, wa.y + wa.height - 12 - infoY(wa));
  return NOTES_H;
}

// Stats dashboard geometry (fills the bottom of the middle column).
function statsY(wa) {
  // Normal: below the Notes + Info row. Week: Notes + Info live in the right
  // slot, so Stats fills the whole middle column below the strip.
  return activeMode === 'week' ? midTop(wa) : midTop(wa) + NOTES_H + 14;
}
function statsX(wa) { return midLeft(wa); }
function statsWidth(wa) { return Math.max(STATS_MIN_W, midRight(wa) - midLeft(wa)); }
function statsHeight(wa) { return Math.max(300, wa.y + wa.height - 12 - statsY(wa)); }

function createNotesWindow() {
  if (notesWindow && !notesWindow.isDestroyed()) return;
  const wa = anchorDisplay().workArea;
  const nY = notesY(wa);
  notesWindow = new BrowserWindow({
    width: notesW(wa),
    height: notesH(wa),
    x: notesX(wa),
    y: nY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true, // user can make it longer vertically/horizontally
    minWidth: 260,
    minHeight: 300,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenWindow(notesWindow);
  loadAppFile(notesWindow, 'notes.html');
  // Stay open until the user closes it (✕) — closing on blur made notes
  // vanish whenever focus moved to the chat or stats window, so they could
  // never be open together.
  notesWindow.on('closed', () => { notesWindow = null; notesHiddenBySleep = false; });
}

function toggleNotesWindow() {
  if (booting) return; // the startup card owns the screen until clicked through
  if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
  if (!notesWindow) return;
  if (notesWindow.isVisible()) {
    closeNotesWindow();
  } else {
    // Notes coexist with the assistant chat and the stats page — they are
    // separate windows, so opening one never dismisses the others.
    showCardWindow(notesWindow);
    notesWindow.focus();
  }
}

// === Assistant window (chat that manages your day) ===
// A tall glass chat window parked against the LEFT edge of the screen,
// below the chat trigger's top edge. Opened from the 💬 bubble in the
// top-left corner. Messages flow to the pet renderer — it owns the data —
// and replies flow back here.
const ASSISTANT_W = 400;
let assistantWindow = null;
let assistantHiddenBySleep = false;

// The AI chat stays in the same top-left spot in every view (the week strip
// starts to its right, so it never needs to dodge the chat).
function assistantY(wa) {
  return wa.y + TOP_Y;
}
function assistantHeight(wa) {
  return Math.max(360, wa.height - (assistantY(wa) - wa.y) - 12);
}

function createAssistantWindow() {
  if (assistantWindow && !assistantWindow.isDestroyed()) return;
  const wa = anchorDisplay().workArea;
  assistantWindow = new BrowserWindow({
    width: ASSISTANT_W,
    // Full-height left column ("takes up the left screen").
    height: assistantHeight(wa),
    x: wa.x, // flush against the left edge of the screen
    y: assistantY(wa),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true, // user can drag the right edge to widen it
    minWidth: 280,
    minHeight: 360,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(assistantWindow);
  loadAppFile(assistantWindow, 'assistant.html');
  // Once the window's listeners are wired, ask the planner for the current
  // online/offline mode so the toggle reflects reality on first paint.
  assistantWindow.webContents.on('did-finish-load', () => sendToPet('assistant-get-mode'));
  // Stay open until the user closes it (✕) — closing on blur made the chat
  // vanish whenever focus moved elsewhere, forcing users to re-summon it.
  assistantWindow.on('closed', () => { assistantWindow = null; assistantHiddenBySleep = false; });
}

function toggleAssistantWindow() {
  if (booting) return; // the startup card owns the screen until clicked through
  if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
  if (!assistantWindow) return;
  if (assistantWindow.isVisible()) closeAssistantWindow();
  else {
    // The chat stays open alongside notes and stats.
    showCardWindow(assistantWindow);
    assistantWindow.focus();
  }
}

function closeAssistantWindow() {
  if (assistantWindow && !assistantWindow.isDestroyed()) hideCardWindow(assistantWindow);
}

// === Chat trigger (a 💬 bubble pinned to the very top-left corner) ===
const CHAT_TRIGGER_SIZE = 76;
let chatTriggerWindow = null;
let chatTriggerPoll = null;
// Last known bubble hover state, so the poll only toggles click-through and
// re-paints the bubble when it actually changes. Calling setIgnoreMouseEvents
// + webContents.send on EVERY tick (90ms) is constant Windows compositor +
// renderer churn that drags the whole desktop down.
let chatTriggerHover = false;

// The 💬 bubble stays in the top-left corner in every view, right where the
// AI chat opens.
function chatTriggerY(wa) {
  return wa.y + 4;
}

function createChatTriggerWindow() {
  if (chatTriggerWindow) return;
  const wa = anchorDisplay().workArea;
  chatTriggerWindow = new BrowserWindow({
    width: CHAT_TRIGGER_SIZE,
    height: CHAT_TRIGGER_SIZE,
    x: wa.x + 4,
    y: chatTriggerY(wa),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // Hidden until boot completes (the chat bubble should not show early).
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  hardenWindow(chatTriggerWindow);
  loadAppFile(chatTriggerWindow, 'chat-trigger.html');
  watchRenderer(chatTriggerWindow, 'chat-trigger');
  chatTriggerWindow.setIgnoreMouseEvents(true, { forward: true });
  chatTriggerHover = false; // the new window starts click-through — keep the poll's state in sync
  chatTriggerWindow.on('closed', () => {
    chatTriggerWindow = null;
    chatTriggerHover = false;
    if (chatTriggerPoll) { clearInterval(chatTriggerPoll); chatTriggerPoll = null; }
  });

  // Click-through except over the bubble: poll the cursor under it.
  if (chatTriggerPoll) clearInterval(chatTriggerPoll);
  chatTriggerPoll = setInterval(() => {
    if (!chatTriggerWindow || chatTriggerWindow.isDestroyed() || !chatTriggerWindow.isVisible()) return;
    const pos = screen.getCursorScreenPoint();
    const b = chatTriggerWindow.getBounds();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const over = Math.hypot(pos.x - cx, pos.y - cy) <= 42;
    if (over !== chatTriggerHover) {
      chatTriggerHover = over;
      chatTriggerWindow.setIgnoreMouseEvents(!over, { forward: true });
      chatTriggerWindow.webContents.send('button-hover', { chatHover: over });
    }
  }, 90);
}

// === Daily-stats window (today's progress dashboard) ===
let statsWindow = null;
let statsHiddenBySleep = false; // stats were open when the app slept — restore on wake

function createStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) return;
  const wa = anchorDisplay().workArea;
  statsWindow = new BrowserWindow({
    width: statsWidth(wa),
    height: statsHeight(wa),
    x: statsX(wa),
    y: statsY(wa),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  hardenWindow(statsWindow);
  loadAppFile(statsWindow, 'stats.html');
  // Pull a fresh snapshot the moment the page is fully loaded (fonts included)
  // so the dashboard fills immediately instead of waiting for its 2s poll.
  statsWindow.webContents.on('did-finish-load', () => {
    if (statsWindow && !statsWindow.isDestroyed()) sendToPet('stats-request', {});
  });
  statsWindow.on('closed', () => { statsWindow = null; statsHiddenBySleep = false; });
}

function toggleStatsWindow() {
  if (booting) return; // the startup card owns the screen until clicked through
  if (!statsWindow || statsWindow.isDestroyed()) createStatsWindow();
  if (!statsWindow) return;
  if (statsWindow.isVisible()) closeStatsWindow();
  else {
    // Stats coexist with the chat and notes.
    showCardWindow(statsWindow);
    statsWindow.focus();
  }
}

function closeStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) hideCardWindow(statsWindow);
}

// === Startup screen (full-screen Jarvis scan + centered status card) ===
// The window spans the WHOLE display (transparent) so the scan light can
// sweep the entire screen; the status card then pops up in the center.
// The app chrome stays hidden while it's up; clicking through restores it.
let bootWindow = null;
let booting = false; // true while the startup screen is up — gates chrome visibility

function bootBounds() {
  // Full display bounds (not workArea) so the scan covers taskbar too.
  const b = anchorDisplay().bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function createBootWindow() {
  if (bootWindow && !bootWindow.isDestroyed()) return;
  const b = bootBounds();
  bootWindow = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  hardenWindow(bootWindow);
  loadAppFile(bootWindow, 'boot.html');
  // Pull a fresh status snapshot the moment the page is fully loaded so the
  // readout fills instantly instead of waiting on its 2s poll.
  bootWindow.webContents.on('did-finish-load', () => {
    if (bootWindow && !bootWindow.isDestroyed()) sendToPet('stats-request', {});
  });
  bootWindow.on('closed', () => { bootWindow = null; });
}

function showBootWindow() {
  if (!bootWindow || bootWindow.isDestroyed()) createBootWindow();
  if (!bootWindow || bootWindow.isDestroyed()) return;
  booting = true;
  // Hide the app chrome so only the centered card is visible.
  if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
  if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.hide();
  if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
  if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.hide();
  bootWindow.setBounds(bootBounds());
  if (!bootWindow.isVisible()) bootWindow.show();
  bootWindow.setAlwaysOnTop(true);
  bootWindow.moveTop();
  bootWindow.focus();
}

function closeBootWindow() {
  if (bootWindow && !bootWindow.isDestroyed()) bootWindow.close();
}

// === Info window (clock / weather / quote) ===
// A compact card below notes — its own window so it never overlaps the
// planner the way the old in-planner popup did.
function createInfoWindow() {
  if (infoWindow && !infoWindow.isDestroyed()) return;
  const wa = anchorDisplay().workArea;
  infoWindow = new BrowserWindow({
    width: infoW(wa),
    height: infoH(wa),
    x: infoX(wa),
    y: infoY(wa),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(infoWindow);
  loadAppFile(infoWindow, 'info.html');
  infoWindow.on('closed', () => { infoWindow = null; infoHiddenBySleep = false; });
}

function toggleInfoWindow() {
  if (booting) return; // the startup card owns the screen until clicked through
  if (!infoWindow || infoWindow.isDestroyed()) createInfoWindow();
  if (!infoWindow) return;
  if (infoWindow.isVisible()) closeInfoWindow();
  else {
    showCardWindow(infoWindow);
    infoWindow.focus();
  }
}

function closeInfoWindow() {
  if (infoWindow && !infoWindow.isDestroyed()) hideCardWindow(infoWindow);
}

// "Full view" from the assistant: bring up the whole workspace on one screen
// — the AI chat, notes, info, stats and the planner — with no overlaps.
function openFullView() {
  if (booting) return; // the startup card owns the screen until clicked through
  if (activeMode === 'week') setAppMode('tasks');
  if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
  if (assistantWindow && !assistantWindow.isDestroyed() && !assistantWindow.isVisible()) showCardWindow(assistantWindow);
  if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
  if (notesWindow && !notesWindow.isDestroyed() && !notesWindow.isVisible()) showCardWindow(notesWindow);
  if (!infoWindow || infoWindow.isDestroyed()) createInfoWindow();
  if (infoWindow && !infoWindow.isDestroyed() && !infoWindow.isVisible()) showCardWindow(infoWindow);
  if (!statsWindow || statsWindow.isDestroyed()) createStatsWindow();
  if (statsWindow && !statsWindow.isDestroyed() && !statsWindow.isVisible()) showCardWindow(statsWindow);
  if (petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) petWindow.show();
  if (statusWindow && !statusWindow.isDestroyed() && !statusWindow.isVisible()) showCardWindow(statusWindow);
  relayoutWindows();
}

// === Hover card (detailed task/deadline preview) ===
// A small always-on-top card that pops up to the LEFT of the planner when the
// user rests the cursor on a task/deadline row for ~2s. It lives in its own
// click-through window so it never covers the planner or blocks clicks.
const HOVER_CARD_W = 300;
let hoverCardWindow = null;

function createHoverCardWindow() {
  if (hoverCardWindow) return;
  const wa = anchorDisplay().workArea;
  hoverCardWindow = new BrowserWindow({
    width: HOVER_CARD_W,
    height: 170,
    x: Math.max(wa.x, wa.x + wa.width - SIDEBAR_W - 8 - HOVER_CARD_W - 12),
    y: wa.y + SIDEBAR_TOP,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(hoverCardWindow);
  loadAppFile(hoverCardWindow, 'hover-card.html');
  // Purely informational: the card never takes clicks.
  hoverCardWindow.setIgnoreMouseEvents(true, { forward: true });
  hoverCardWindow.on('closed', () => { hoverCardWindow = null; });
}

// Show the card to the LEFT of the planner, vertically aligned with the row
// being hovered (clamped so it never drifts off the work area).
function showHoverCard(payload) {
  if (!payload || !payload.name) return;
  // The notes card occupies the space left of the sidebar — never stack the
  // hover preview on top of it.
  if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) return;
  createHoverCardWindow();
  if (!hoverCardWindow) return;
  const wa = anchorDisplay().workArea;
  const pet = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
  // Anchor: card's right edge hugs the planner's left edge (12px gap).
  const baseX = pet ? pet.x - HOVER_CARD_W - 12 : wa.x + 8;
  let x = Math.max(wa.x, Math.min(baseX, wa.x + wa.width - HOVER_CARD_W - 4));
  // Cards for top rows can drift up toward the top edge — keep them below
  // the assistant/chat header line.
  const minY = wa.y + TOP_Y;
  let y = pet ? pet.y + Math.round(payload.rowTop || 0) - 8 : wa.y + SIDEBAR_TOP;
  y = Math.max(minY, Math.min(y, wa.y + wa.height - 178));
  hoverCardWindow.setBounds({ x, y, width: HOVER_CARD_W, height: 170 });
  const present = () => {
    if (!hoverCardWindow || hoverCardWindow.isDestroyed()) return;
    hoverCardWindow.webContents.send('hover-card-data', payload);
    hoverCardWindow.setAlwaysOnTop(true, 'screen-saver');
    showCardWindow(hoverCardWindow, { inactive: true });
  };
  if (hoverCardWindow.webContents.isLoading()) {
    hoverCardWindow.webContents.once('did-finish-load', present);
  } else {
    present();
  }
}

function hideHoverCard() {
  if (hoverCardWindow && !hoverCardWindow.isDestroyed()) hoverCardWindow.hide();
}

function closeNotesWindow() {
  if (notesWindow && !notesWindow.isDestroyed()) hideCardWindow(notesWindow);
}

// === App views: tasks (sidebar) / calendar (sidebar) / week (top strip) ===
// Only one view is on screen at a time. Ctrl+Shift+S sleeps the whole app;
// wake restores whichever view was active.
let activeMode = 'tasks';

function setAppMode(mode) {
  if (mode !== 'tasks' && mode !== 'calendar' && mode !== 'week') mode = 'tasks';
  activeMode = mode;
  dlog('app mode:', activeMode);
  if (mode === 'week') {
    createWeekWindow();
    if (weekWindow && !weekWindow.isDestroyed()) showCardWindow(weekWindow);
    if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
    // Full re-layout: an open notes card drops below the week strip instead
    // of overlapping it.
    relayoutWindows();
    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.show();
    // Keep the sidebar renderer in sync even while hidden (e.g. so the week
    // view-switch button reads active if the sidebar is ever shown again).
    sendToPet('set-mode', { view: 'week' });
  } else {
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) hideCardWindow(weekWindow);
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) showCardWindow(statusWindow);
    // Full re-layout: everything re-anchored for the non-week layout.
    relayoutWindows();
    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.show();
    sendToPet('set-mode', { view: mode });
  }
}

// Restore the active mode's windows (used after sleep / peek / capture).
function restoreModeWindows() {
  // While the startup card is up, the planner/status/chat MUST stay hidden —
  // the boot window owns the screen until the user clicks through. The pet
  // renderer can trigger this on load (syncFocusBar), so this guard is what
  // actually keeps the planner from popping up next to the Jarvis card.
  if (booting) return;
  // A running focus session keeps the planner unsummoned — the slim focus
  // bar owns the screen until the session ends.
  if (focusSessionActive) {
    ensureFocusBar();
    return;
  }
  if (activeMode === 'week') {
    createWeekWindow();
    if (weekWindow && !weekWindow.isDestroyed()) showCardWindow(weekWindow);
    relayoutWindows();
    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.show();
  } else {
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) showCardWindow(statusWindow);
    relayoutWindows();
    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.show();
    sendToPet('set-mode', { view: activeMode });
  }
}

// === Week strip window (horizontal Mon–Sun planner at the top of the screen) ===
// A wide always-on-top glass strip showing this week's tasks + deadlines per
// day (days with nothing are omitted). Clicking a day jumps to the calendar
// view on that day. Click-through except over the header buttons + columns.
let weekWindow = null;
let weekBounds = [];           // window-relative interactive regions
let weekPollInterval = null;
// Last applied click-through state for the strip, so the poll only calls
// setIgnoreMouseEvents when it changes (every-tick toggling is costly).
let weekMouseIgnored = true;

function createWeekWindow() {
  if (weekWindow) return;
  const wa = anchorDisplay().workArea;
  weekWindow = new BrowserWindow({
    // The strip starts to the RIGHT of the AI chat and runs to the screen's
    // right edge, leaving the top-left corner to the chat.
    width: wa.width - ASSISTANT_W - 16,
    // Tall enough for each day column to show its whole plan (~a third of
    // the screen's height, like the calendar; past days cross everything out
    // so the columns need room to breathe).
    height: weekStripHeight(wa.height),
    x: wa.x + ASSISTANT_W + 8,
    y: wa.y + 8,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  hardenWindow(weekWindow);
  loadAppFile(weekWindow, 'week.html');
  watchRenderer(weekWindow, 'week');
  weekWindow.setIgnoreMouseEvents(true, { forward: true });
  weekMouseIgnored = true;
  weekWindow.on('closed', () => {
    weekWindow = null;
    weekBounds = [];
    weekMouseIgnored = true;
    if (weekPollInterval) { clearInterval(weekPollInterval); weekPollInterval = null; }
  });

  // Click-through except over the header controls + day columns (cursor poll).
  if (weekPollInterval) clearInterval(weekPollInterval);
  weekPollInterval = setInterval(() => {
    if (!weekWindow || weekWindow.isDestroyed() || !weekWindow.isVisible()) return;
    if (sleeping || peekActive) {
      if (!weekMouseIgnored) { weekMouseIgnored = true; weekWindow.setIgnoreMouseEvents(true, { forward: true }); }
      return;
    }
    const pos = screen.getCursorScreenPoint();
    const b = weekWindow.getBounds();
    let hit = false;
    for (const r of weekBounds) {
      const rx = pos.x - b.x, ry = pos.y - b.y;
      if (rx >= r.x && rx <= r.x + r.w && ry >= r.y && ry <= r.y + r.h) { hit = true; break; }
    }
    const ignore = !hit;
    if (ignore !== weekMouseIgnored) {
      weekMouseIgnored = ignore;
      weekWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
  }, 90);
}

// === Full-screen deadline alert ===
let deadlineAlertWindow = null;

function createDeadlineAlertWindow() {
  if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed()) return;
  const b = anchorDisplay().bounds;
  deadlineAlertWindow = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(deadlineAlertWindow);
  loadAppFile(deadlineAlertWindow, 'deadline-alert.html');
  deadlineAlertWindow.on('closed', () => { deadlineAlertWindow = null; });
}

function showDeadlineAlert(dl) {
  createDeadlineAlertWindow();
  if (!deadlineAlertWindow) return;
  const present = () => {
    if (!deadlineAlertWindow || deadlineAlertWindow.isDestroyed()) return;
    deadlineAlertWindow.webContents.send('deadline-alert-data', dl);
    deadlineAlertWindow.setAlwaysOnTop(true, 'screen-saver');
    deadlineAlertWindow.show();
    deadlineAlertWindow.focus();
  };
  if (deadlineAlertWindow.webContents.isLoading()) {
    deadlineAlertWindow.webContents.once('did-finish-load', present);
  } else {
    present();
  }
}

function closeDeadlineAlert() {
  if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed()) deadlineAlertWindow.close();
}

// Debounce timestamp for openScreenshotOverlay (see below).
let lastScreenshotOpen = 0;

// === Screenshot Overlay ===
function createScreenshotOverlay(display) {
  if (screenshotOverlay) return;
  const b = (display || screen.getPrimaryDisplay()).bounds;

  screenshotOverlay = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenWindow(screenshotOverlay);
  loadAppFile(screenshotOverlay, 'overlay-screenshot.html');
  screenshotOverlay.webContents.on('render-process-gone', (_e, details) => dlog('overlay renderer gone:', details && details.reason));
  screenshotOverlay.on('closed', () => { dlog('overlay window closed'); screenshotOverlay = null; });
}

function closeScreenshotOverlay(reason) {
  dlog('closeScreenshotOverlay', reason || '', 'existing:', !!screenshotOverlay);
  lastScreenshotOpen = 0; // allow an immediate re-open after cancel/capture
  if (screenshotOverlay) {
    screenshotOverlay.close();
    screenshotOverlay = null;
  }
}

// Open the screenshot overlay on the display under the cursor. Debounced so a
// shortcut that fires through BOTH the global hook and a window fallback (or a
// held-down key repeat) opens it exactly once. `closeScreenshotOverlay` resets
// the debounce so capture → retake works instantly.
function openScreenshotOverlay() {
  const now = Date.now();
  if (now - lastScreenshotOpen < 400) return;
  lastScreenshotOpen = now;
  // Capture on the display the cursor is currently on (multi-monitor).
  screenshotDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (!screenshotOverlay) createScreenshotOverlay(screenshotDisplay); // recreate after it was closed
  else screenshotOverlay.setBounds(screenshotDisplay.bounds);
  screenshotOverlay.webContents.reload();
  screenshotOverlay.show();
  screenshotOverlay.focus();
}

// === Sleep / wake (Ctrl+Shift+S) ===
// Hides the whole app chrome (the planner fades in the pet window; the status
// bar and chat trigger hide) so the screen is clean, and the same shortcut
// summons it back. Debounced so duplicate triggers (global shortcut + key
// watcher + window fallback) toggle exactly once.
let sleeping = false;
let lastSleepToggle = 0;
// Absorbs a stray Ctrl+Shift+S that lands right around the wake/continue
// flow. Users habitually press the hotkey again while/just after clicking
// through the Jarvis card (muscle memory from the old inverted-toggle app,
// where a second press was a harmless no-op) — without this, that second
// press would instantly re-hide the app, leaving only the status bar and
// making it look like the planner never came up. Within this window the
// hotkey is intentionally a no-op; the tray's Hide Planner (a deliberate
// action) still works because it calls applySleep directly.
const SLEEP_GRACE_MS = 2000;
let sleepGraceUntil = 0;

// Wake the app AND place it on the display under the cursor — Ctrl+Shift+S
// and the tray's Show Planner both mean "summon it where I'm looking". This
// restores the old cross-monitor jump users loved, while toggleSleep still
// HIDES the app when it's awake (the "hide" that used to be broken). The
// earlier change kept the old anchor because re-anchoring on EVERY press
// (the inverted-toggle bug) made the app jump around uncontrollably — with
// the toggle fixed, waking to the cursor is deliberate and predictable.
//
// Waking summons the planner DIRECTLY — the Jarvis startup card only plays
// on app launch now. It used to replay on every wake, and the extra
// click-through step was where the planner could appear missing: the pet's
// show() raced the always-on-top boot window's close, and a Windows quirk
// can drop a show() that lands mid-close, leaving only the status bar up.
function wakeToCursorDisplay() {
  appDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  dlog('wake — cursor display:', appDisplay.id, appDisplay.bounds);
  // The wake press itself is consumed: swallowing it (and the boot-continue
  // re-arm below) means a second press around the wake can't re-hide.
  sleepGraceUntil = Date.now() + SLEEP_GRACE_MS;
  applySleep(false); // restores the active mode's windows on the cursor display
  relayoutWindows();
  ensureWindowsVisible(); // belt & braces against a dropped show()
  dlog('wake complete — anchor:', appDisplay.bounds, 'pet:', petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null);
}

function toggleSleep() {
  // During the Jarvis scan the hotkey is a no-op — it must not restart the
  // boot sequence mid-scan.
  if (booting) return;
  const now = Date.now();
  // A stray press right after waking/clicking-through must not instantly
  // hide the freshly summoned planner.
  if (now < sleepGraceUntil) {
    dlog('toggleSleep absorbed by wake grace (', (sleepGraceUntil - now) + 'ms left)');
    return;
  }
  if (now - lastSleepToggle < 400) return;
  lastSleepToggle = now;
  // Awake → hide; asleep → wake (and place at the cursor's display). The
  // branch used to be inverted: the awake case ran wakeToCursorDisplay()
  // (which force-sets sleeping=false), so the hotkey could never hide the
  // app — every press just re-anchored it to the cursor's screen.
  if (sleeping) wakeToCursorDisplay();
  else applySleep(true);
}

function applySleep(value) {
  sleeping = !!value;
  dlog('sleep:', sleeping, 'pet bounds:', petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null);
  // Wake: bring the pet window back BEFORE fading it in, so the CSS
  // transition is actually visible (a hidden window can't animate).
  if (!value && !booting && !peekActive && !focusSessionActive && petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) {
    petWindow.show();
  }
  sendToPet('set-sleeping', { value: sleeping });
  if (sleeping) {
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.hide();
    if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.hide();
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
    // Hide (not close) an open notes popup so it comes back in the same spot
    // with its content intact when the app is summoned again.
    if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) {
      notesHiddenBySleep = true;
      hideCardWindow(notesWindow);
    }
    if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
      assistantHiddenBySleep = true;
      hideCardWindow(assistantWindow);
    }
    // Hide (not close) an open stats card so it comes back in the same spot
    // with the same data when the app is summoned again.
    if (statsWindow && !statsWindow.isDestroyed() && statsWindow.isVisible()) {
      statsHiddenBySleep = true;
      hideCardWindow(statsWindow);
    }
    if (infoWindow && !infoWindow.isDestroyed() && infoWindow.isVisible()) {
      infoHiddenBySleep = true;
      hideCardWindow(infoWindow);
    }
    if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed() && deadlineAlertWindow.isVisible()) closeDeadlineAlert();
    closeScreenshotOverlay(); // don't leave the capture overlay up over a hidden app
    hideHoverCard();
    setMouseIgnored(true);
    // The renderer already faded the planner out (sleeping-all class); once
    // the fade finishes, fully hide the pet window too so a sleeping app can
    // never interfere with clicks or fullscreen apps underneath.
    setTimeout(() => {
      if (sleeping && petWindow && !petWindow.isDestroyed()) petWindow.hide();
    }, 600);
  } else if (!peekActive) {
    // Wake: restore the active mode's windows AND force the planner back on
    // screen (it can be left panel-hidden, which previously made the planner
    // stay invisible after summoning while the status bar came back).
    restoreModeWindows();
    if (notesHiddenBySleep) {
      notesHiddenBySleep = false;
      if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
      if (notesWindow && !notesWindow.isDestroyed()) { showCardWindow(notesWindow); notesWindow.focus(); }
    }
    if (assistantHiddenBySleep) {
      assistantHiddenBySleep = false;
      if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
      if (assistantWindow && !assistantWindow.isDestroyed()) { showCardWindow(assistantWindow); assistantWindow.focus(); }
    }
    if (statsHiddenBySleep) {
      statsHiddenBySleep = false;
      if (!statsWindow || statsWindow.isDestroyed()) createStatsWindow();
      if (statsWindow && !statsWindow.isDestroyed()) { showCardWindow(statsWindow); statsWindow.focus(); }
    }
    if (infoHiddenBySleep) {
      infoHiddenBySleep = false;
      if (!infoWindow || infoWindow.isDestroyed()) createInfoWindow();
      if (infoWindow && !infoWindow.isDestroyed()) { showCardWindow(infoWindow); infoWindow.focus(); }
    }
  }
  buildTrayMenu(); // keep the tray's Show/Hide item in sync
}

// === Alt+C peek (Windows) ===
// Hold Alt+C to dim the app and force full click-through so you can see and
// use whatever is underneath; release to restore everything.
let peekActive = false;

function setPeek(active) {
  if (active === peekActive) return;
  peekActive = active;
  dlog('Alt+C peek:', peekActive);
  sendToPet('alt-dim', { active: peekActive });
  if (peekActive) {
    setMouseIgnored(true);
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.hide();
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
    if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.hide();
    if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
      assistantHiddenBySleep = true;
      hideCardWindow(assistantWindow);
    }
    if (statsWindow && !statsWindow.isDestroyed() && statsWindow.isVisible()) {
      statsHiddenBySleep = true;
      hideCardWindow(statsWindow);
    }
    if (infoWindow && !infoWindow.isDestroyed() && infoWindow.isVisible()) {
      infoHiddenBySleep = true;
      hideCardWindow(infoWindow);
    }
    // Same for Notes — every popup card must clear the screen while
    // peeking, not just assistant/stats/info.
    if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) {
      notesHiddenBySleep = true;
      hideCardWindow(notesWindow);
    }
    hideHoverCard();
  } else if (!sleeping) {
    restoreModeWindows();
    // Notes hidden by a sleep cycle come back once the peek ends.
    if (notesHiddenBySleep) {
      notesHiddenBySleep = false;
      if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
      if (notesWindow && !notesWindow.isDestroyed()) { showCardWindow(notesWindow); notesWindow.focus(); }
    }
    if (assistantHiddenBySleep) {
      assistantHiddenBySleep = false;
      if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
      if (assistantWindow && !assistantWindow.isDestroyed()) { showCardWindow(assistantWindow); assistantWindow.focus(); }
    }
    if (statsHiddenBySleep) {
      statsHiddenBySleep = false;
      if (!statsWindow || statsWindow.isDestroyed()) createStatsWindow();
      if (statsWindow && !statsWindow.isDestroyed()) { showCardWindow(statsWindow); statsWindow.focus(); }
    }
    if (infoHiddenBySleep) {
      infoHiddenBySleep = false;
      if (!infoWindow || infoWindow.isDestroyed()) createInfoWindow();
      if (infoWindow && !infoWindow.isDestroyed()) { showCardWindow(infoWindow); infoWindow.focus(); }
    }
  }
}

// === Shared Windows key watcher ===
// A tiny PowerShell process polls GetAsyncKeyState for a two-key combo and
// streams '1' on a fresh press / '0' on release. Presses are edge-detected
// and flushed immediately (redirected stdout would otherwise buffer the
// sparse output and deliver it late or never). It works regardless of which
// app owns the hotkey and of which window has focus — the same trick the old
// app used for Alt+C. Self-heals on unexpected exit (max 5 restarts).
let shiftSKeyWatcher = null;
let altCKeyWatcher = null;

function startKeyWatcher(label, keys, onPress, onRelease, onExit, exclude) {
  if (process.platform !== 'win32') return null;
  // All listed keys must be down (e.g. Ctrl+Shift+S = [17, 16, 83]); any
  // excluded key must be UP so a longer combo (Ctrl+Shift+Alt+S) never trips
  // a shorter one (Ctrl+Shift+S) at the same time.
  const comboCheck = keys.map(k => `([K]::GetAsyncKeyState(${k}) -lt 0)`).join(' -and ');
  const excl = (exclude || []).map(k => `([K]::GetAsyncKeyState(${k}) -ge 0)`).join(' -and ');
  const check = excl ? `(${comboCheck}) -and (${excl})` : comboCheck;
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::ASCII;',
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class K{[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int v);}\';',
    '$prev=$false;',
    'while($true){',
    `  $d = ${check};`,
    `  if($d -and -not $prev){[Console]::WriteLine('1'); [Console]::Out.Flush()};`,
    `  if($prev -and -not $d){[Console]::WriteLine('0'); [Console]::Out.Flush()};`,
    '  $prev=$d;',
    '  Start-Sleep -Milliseconds 30',
    '}'
  ].join(' ');
  let child = null;
  let restarts = 0;
  let stopped = false;
  const spawnWatcher = () => {
    if (stopped || child) return;
    dlog('starting ' + label + ' key watcher');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('ascii');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const clean = line.replace(/[^\d]/g, '');
        if (clean === '1') onPress();
        else if (clean === '0') onRelease();
      }
    });
    child.on('error', (err) => {
      dlog(label + ' watcher error', err.message);
      stopped = true; // a broken spawn won't be retried
      if (child) { try { child.kill(); } catch (e) {} child = null; }
    });
    child.on('exit', (code) => {
      dlog(label + ' watcher exited', code);
      child = null;
      if (!stopped && onExit) onExit(); // only unexpected exits run cleanup
      if (!stopped && restarts < 5) {
        restarts++;
        setTimeout(() => { if (!child && !stopped) spawnWatcher(); }, 1500);
      }
    });
  };
  const stopWatcher = () => {
    stopped = true;
    if (child) { try { child.kill(); } catch (e) {} child = null; }
  };
  spawnWatcher();
  return { stop: stopWatcher };
}

// Ctrl+Shift+S → sleep/wake; Alt+C → peek; Ctrl+Shift+Alt+S → next screen.
// Created in whenReady; the debounces in toggleSleep / setPeek absorb any
// duplicate with the global shortcut.
let cycleKeyWatcher = null;
function startShiftSKeyWatcher() {
  if (!shiftSKeyWatcher) shiftSKeyWatcher = startKeyWatcher('Ctrl+Shift+S', [17, 16, 83], () => toggleSleep(), () => {}, null, [18]);
}
function startAltCWatcher() {
  if (!altCKeyWatcher) altCKeyWatcher = startKeyWatcher('Alt+C', [18, 67], () => setPeek(true), () => setPeek(false), () => setPeek(false));
}
function startCycleKeyWatcher() {
  if (!cycleKeyWatcher) cycleKeyWatcher = startKeyWatcher('Ctrl+Shift+Alt+S', [17, 16, 18, 83], () => cycleToNextDisplay(), () => {});
}
function stopShiftSKeyWatcher() {
  if (shiftSKeyWatcher) { shiftSKeyWatcher.stop(); shiftSKeyWatcher = null; }
}
function stopAltCKeyWatcher() {
  if (altCKeyWatcher) { altCKeyWatcher.stop(); altCKeyWatcher = null; }
  if (peekActive) setPeek(false);
}
function stopCycleKeyWatcher() {
  if (cycleKeyWatcher) { cycleKeyWatcher.stop(); cycleKeyWatcher = null; }
}

// === Pro license (Lemon Squeezy) ===
// Activation state lives in userData/license.json. The license key itself is
// encrypted with Electron's safeStorage (DPAPI on Windows, Keychain on macOS)
// so a plain-text key never sits on disk. The renderer only ever receives the
// activation STATUS (isPro + plan), never the raw key.

const licenseFile = () => path.join(app.getPath('userData'), 'license.json');
let licenseCache = null; // { plan, email, activatedAt, encryptedKey }

function loadLicense() {
  if (licenseCache) return licenseCache;
  try {
    const data = JSON.parse(fs.readFileSync(licenseFile(), 'utf8'));
    if (data && data.encryptedKey && data.plan) {
      licenseCache = data;
      return licenseCache;
    }
  } catch (e) { /* no license yet */ }
  licenseCache = null;
  return licenseCache;
}

function licenseStatus() {
  const l = loadLicense();
  if (!l) return { isPro: false, plan: null, email: null, activatedAt: null };
  return { isPro: l.plan === 'pro' || l.plan === 'plus', plan: l.plan, email: l.email || null, activatedAt: l.activatedAt || null };
}

function saveLicense(data) {
  try {
    fs.mkdirSync(path.dirname(licenseFile()), { recursive: true });
    fs.writeFileSync(licenseFile(), JSON.stringify(data, null, 2));
    licenseCache = data;
  } catch (e) {
    dlog('license save failed:', e.message);
  }
}

function clearLicense() {
  licenseCache = null;
  try { fs.unlinkSync(licenseFile()); } catch (e) { /* nothing to remove */ }
}

// Validate a license key against Lemon Squeezy. MOCK for now so the activation
// flow can be built and tested before billing is live: any key matching
// HALO-PRO-* (case-insensitive) is accepted, plus the fixed demo key
// HALO-PRO-DEMO-KEY. Swap the body for the real
// POST https://api.lemonsqueezy.com/v1/licenses/activate call when ready
// (needs LEMON_SQUEEZY_API_KEY + LEMON_SQUEEZY_STORE_ID env vars).
async function validateLicenseKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'Enter a license key.' };
  if (/^HALO-PRO-/i.test(k)) return { ok: true, plan: 'pro', email: 'demo@halo.app' };
  // --- Real Lemon Squeezy activation (enable when billing is live) ---
  // const apiKey = process.env.LEMON_SQUEEZY_API_KEY;
  // const storeId = process.env.LEMON_SQUEEZY_STORE_ID;
  // if (!apiKey || !storeId) return { ok: false, error: 'Billing is not configured yet.' };
  // const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/activate', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  //   body: JSON.stringify({ license_key: k, instance_name: 'halo-app' }),
  // });
  // const json = await res.json();
  // if (!res.ok || json.errors) return { ok: false, error: 'Invalid or expired license key.' };
  // const attrs = json.data && json.data.attributes;
  // const variant = json.included && json.included.find((i) => i.type === 'variants');
  // return { ok: true, plan: (variant && variant.attributes && variant.attributes.name) || 'pro', email: (attrs && attrs.customer_email) || null };
  return { ok: false, error: 'Invalid license key. Keys look like HALO-PRO-XXXX-XXXX.' };
}

// === IPC Handlers ===

ipcMain.handle('license-get-status', () => licenseStatus());

ipcMain.handle('license-activate', async (_e, key) => {
  const result = await validateLicenseKey(key);
  if (!result.ok) return { ok: false, error: result.error };
  const secret = String(key).trim();
  const encryptedKey = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(secret).toString('base64')
    : Buffer.from(secret, 'utf8').toString('base64'); // fallback if safeStorage is unavailable
  saveLicense({
    plan: result.plan,
    email: result.email || null,
    activatedAt: new Date().toISOString(),
    encryptedKey,
  });
  return { ok: true, ...licenseStatus() };
});

ipcMain.handle('license-deactivate', () => {
  clearLicense();
  return { ok: true, ...licenseStatus() };
});

ipcMain.handle('get-cursor-position', () => {
  return screen.getCursorScreenPoint();
});

// Click-through toggle (used by the renderer when popups open)
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (petWindow) {
    petWindow.setIgnoreMouseEvents(ignore, { forward: true });
    mouseIgnored = ignore;
  }
});

// Receive interactive element bounds from renderer for cursor polling.
// The renderer refreshes these on a 400ms timer (plus after any state
// change) so they always track the planner's live layout.
ipcMain.on('update-interactive-bounds', (event, bounds) => {
  interactiveBounds = bounds;
  // The renderer refreshes these every ~400ms; log only when they actually
  // change so the debug log isn't drowned in identical lines (it capped at
  // 512KB in ~25 min of runtime and erased the startup diagnostics).
  const json = JSON.stringify(bounds);
  if (json !== lastBoundsLog) {
    lastBoundsLog = json;
    dlog('bounds update:', json);
  }
});

// Assistant chat: the window sends raw text here; the pet renderer (which
// owns the task/deadline/clipboard data) answers and the reply is routed
// back to the window.
ipcMain.on('assistant-message', (_e, text) => {
  if (text && typeof text === 'string') sendToPet('assistant-message', { text });
});
ipcMain.on('assistant-reply', (_e, reply) => {
  if (!assistantWindow || assistantWindow.isDestroyed() || !assistantWindow.isVisible()) return;
  assistantWindow.webContents.send('assistant-reply', reply);
});
ipcMain.on('open-assistant', () => toggleAssistantWindow());
ipcMain.on('assistant-close', () => closeAssistantWindow());
ipcMain.on('open-stats', () => toggleStatsWindow());
ipcMain.on('stats-close', () => closeStatsWindow());
ipcMain.on('open-info', () => toggleInfoWindow());
ipcMain.on('info-close', () => closeInfoWindow());
ipcMain.on('full-view', () => openFullView());
// Live stats sync: the planner renderer (data owner) pushes a snapshot here
// whenever tasks/deadlines/streak/focus change; forward it to the stats window.
ipcMain.on('stats-update', (_e, payload) => {
  if (statsWindow && !statsWindow.isDestroyed() && !statsWindow.webContents.isLoading()) {
    statsWindow.webContents.send('stats-data', payload);
  }
  if (bootWindow && !bootWindow.isDestroyed() && !bootWindow.webContents.isLoading()) {
    bootWindow.webContents.send('stats-data', payload);
  }
});
// The stats window just opened and wants the current snapshot now.
ipcMain.on('stats-request', () => sendToPet('stats-request', {}));
// Online/offline mode: the window toggles it, the pet renderer owns/stores it
// and broadcasts the canonical value back to the window.
ipcMain.on('assistant-set-mode', (_e, mode) => { sendToPet('assistant-set-mode', { mode }); });
ipcMain.on('assistant-mode-state', (_e, mode) => {
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.webContents.send('assistant-mode-state', mode);
});
// Daily-protocol accent: the planner renderer owns the choice and broadcasts
// it so assistant/notes/info/stats/week all match its color scheme.
function broadcastToPanels(channel, payload) {
  [assistantWindow, notesWindow, infoWindow, statsWindow, weekWindow].forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  });
}
ipcMain.on('protocol-state', (_e, protocol) => broadcastToPanels('protocol-state', protocol));
ipcMain.on('protocol-get', () => sendToPet('protocol-get', {}));
// The user clicked through the startup screen: close it and tell the planner
// to continue (show the daily protocol picker if it hasn't been chosen).
// The windows are restored only AFTER the boot window has fully closed — a
// pet.show() that lands while the always-on-top boot window is mid-close can
// be dropped on Windows (the status bar, at screen-saver always-on-top,
// comes back but the planner stays invisible). A fallback timer covers a
// boot window that never finishes closing.
ipcMain.on('boot-continue', () => {
  booting = false;
  // Re-arm the grace so a second Ctrl+Shift+S right after clicking through
  // the Jarvis card can't hide the planner that just came up.
  sleepGraceUntil = Date.now() + SLEEP_GRACE_MS;
  let finished = false;
  const finishBoot = () => {
    if (finished) return;
    finished = true;
    clearTimeout(bootCloseFallback);
    restoreModeWindows(); // bring the planner / status / chat back
    sendToPet('boot-done', {});
    ensureWindowsVisible(); // verify the chrome actually landed on screen
  };
  const bootCloseFallback = setTimeout(finishBoot, 600);
  if (bootWindow && !bootWindow.isDestroyed()) {
    bootWindow.once('closed', finishBoot);
    bootWindow.close();
  } else {
    finishBoot();
  }
});

// A Windows quirk can drop a show() that lands while another always-on-top
// window is mid-close (the boot card), leaving the status bar up but the
// planner missing. After a boot handoff or wake, verify the chrome is
// actually visible and re-show anything that didn't make it.
function ensureWindowsVisible() {
  [150, 450, 1200].forEach((ms) => setTimeout(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (booting || sleeping || peekActive || focusSessionActive || activeMode === 'week') return;
    if (!petWindow.isVisible()) {
      dlog('pet window missing after wake/boot — re-showing');
      petWindow.show();
      relayoutWindows();
    }
    if (statusWindow && !statusWindow.isDestroyed() && !statusWindow.isVisible()) {
      dlog('status window missing after wake/boot — re-showing');
      showCardWindow(statusWindow);
    }
    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed() && !chatTriggerWindow.isVisible()) {
      dlog('chat trigger missing after wake/boot — re-showing');
      chatTriggerWindow.show();
    }
  }, ms));
}

// Export tasks/deadlines/notes/settings to a JSON file (save dialog).
ipcMain.handle('export-data', async (_e, json) => {
  try {
    const res = await dialog.showSaveDialog({
      title: 'Export Halo data',
      defaultPath: 'wolf-data-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return false;
    await fs.promises.writeFile(res.filePath, String(json), 'utf8');
    return true;
  } catch (e) {
    dlog('export failed:', e && e.message);
    return false;
  }
});

// App view mode (sent by the sidebar's view switcher and the week strip's
// header buttons).
ipcMain.on('set-mode', (_e, mode) => setAppMode(mode));

// Week strip: the renderer reports its interactive regions for click-through.
ipcMain.on('week-update-bounds', (_e, bounds) => {
  weekBounds = Array.isArray(bounds) ? bounds : [];
});

// A week day was clicked: switch to the calendar view focused on that day.
// The window toggles are inlined (not setAppMode) so the renderer receives
// ONE message (select-day) and paints the calendar exactly once — otherwise
// set-mode then select-day would render it twice (visible month jump when
// the clicked day is in a different month).
ipcMain.on('week-select-day', (_e, key) => {
  activeMode = 'calendar';
  if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) hideCardWindow(weekWindow);
  if (petWindow && !petWindow.isDestroyed()) petWindow.show();
  if (statusWindow && !statusWindow.isDestroyed()) showCardWindow(statusWindow);
  // Back to the sidebar layout — bring an open notes card back beside the
  // sidebar.
  relayoutWindows();
  if (key && typeof key === 'string') sendToPet('select-day', { key });
});

// Always on top toggle
ipcMain.on('set-always-on-top', (event, value) => {
  if (petWindow) petWindow.setAlwaysOnTop(!!value);
});

// Quick Notes popup
ipcMain.on('open-notes', () => toggleNotesWindow());
ipcMain.on('notes-close', () => closeNotesWindow());

// Focus session: the planner renderer streams its timer state here. While a
// session is ACTIVE the whole app unsummons into the slim focus bar; when it
// ends (finished / stopped), the active mode's windows come back.
ipcMain.on('focus-session', (_e, state) => {
  const active = !!(state && state.active);
  focusSessionActive = active;
  if (active) {
    // Unsummon the planner (unless the app is already asleep, which hides
    // everything anyway).
    if (!sleeping) {
      if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
      if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
      if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
      if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.hide();
      if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) {
        notesHiddenByFocus = true;
        hideCardWindow(notesWindow);
      }
      if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
        assistantHiddenBySleep = true;
        hideCardWindow(assistantWindow);
      }
      if (statsWindow && !statsWindow.isDestroyed() && statsWindow.isVisible()) {
        statsHiddenBySleep = true;
        hideCardWindow(statsWindow);
      }
      if (infoWindow && !infoWindow.isDestroyed() && infoWindow.isVisible()) {
        infoHiddenBySleep = true;
        hideCardWindow(infoWindow);
      }
    }
    createFocusBarWindow();
    if (focusBarWindow && !focusBarWindow.isDestroyed()) {
      focusBarWindow.webContents.send('focus-bar-state', state);
      // Only animate the window in ONCE — the countdown updates every second
      // and re-running the summon animation on each tick made the bar flash
      // in/out repeatedly. Once it's up, just keep pushing the new time.
      if (!focusBarWindow.isVisible()) showCardWindow(focusBarWindow);
    }
  } else {
    if (focusBarWindow && !focusBarWindow.isDestroyed()) hideCardWindow(focusBarWindow);
    if (!sleeping && !peekActive) {
      restoreModeWindows();
      if (notesHiddenByFocus) {
        notesHiddenByFocus = false;
        if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
        if (notesWindow && !notesWindow.isDestroyed()) { showCardWindow(notesWindow); notesWindow.focus(); }
      }
      if (assistantHiddenBySleep) {
        assistantHiddenBySleep = false;
        if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
        if (assistantWindow && !assistantWindow.isDestroyed()) { showCardWindow(assistantWindow); assistantWindow.focus(); }
      }
      if (statsHiddenBySleep) {
        statsHiddenBySleep = false;
        if (!statsWindow || statsWindow.isDestroyed()) createStatsWindow();
        if (statsWindow && !statsWindow.isDestroyed()) { showCardWindow(statsWindow); statsWindow.focus(); }
      }
      if (infoHiddenBySleep) {
        infoHiddenBySleep = false;
        if (!infoWindow || infoWindow.isDestroyed()) createInfoWindow();
        if (infoWindow && !infoWindow.isDestroyed()) { showCardWindow(infoWindow); infoWindow.focus(); }
      }
    }
  }
});

// Buttons on the focus bar: pause/resume/stop — relayed to the planner
// renderer, which owns the timer state.
ipcMain.on('focus-bar-cmd', (_e, action) => {
  sendToPet('focus-bar-cmd', { action });
});

// Hover card (task/deadline detail preview to the LEFT of the planner)
ipcMain.on('hover-card-show', (_e, payload) => showHoverCard(payload));
ipcMain.on('hover-card-hide', () => hideHoverCard());

// Sleep / wake (Ctrl+Shift+S — sent by the renderer's keydown fallback)
ipcMain.on('toggle-sleep', () => toggleSleep());

// A card window finished its fade-out and is ready to be hidden.
ipcMain.on('summon-leave-done', (e) => {
  const win = pendingCardHide.get(e.sender.id);
  if (!win) return;
  pendingCardHide.delete(e.sender.id);
  if (win._hideFallback) { clearTimeout(win._hideFallback); win._hideFallback = null; }
  if (win && !win.isDestroyed()) win.hide();
});

// Full-screen deadline alert
ipcMain.on('deadline-alert-show', (_e, dl) => {
  if (dl && dl.id && dl.name) showDeadlineAlert(dl);
});
ipcMain.on('deadline-alert-ack', (_e, id) => {
  // Acknowledged: dismiss the overlay and tell the pet renderer so it can
  // forget the reminder record (a reopened deadline re-arms cleanly).
  closeDeadlineAlert();
  sendToPet('deadline-alert-acked', { id });
});
// Conflict alert: "remove the new one" → delete that deadline.
ipcMain.on('conflict-resolve', (_e, id) => { sendToPet('conflict-resolve', { id }); });

// Screenshot overlay (triggered from the ring menu's Screenshot action)
ipcMain.on('open-screenshot-overlay', () => { dlog('open-screenshot-overlay IPC received'); openScreenshotOverlay(); });

ipcMain.on('capture-screenshot-close', async (event, region) => {
  // Hide the overlay + app chrome BEFORE grabbing the screen — otherwise the
  // shot would include the overlay's dim/grid, the pet sidebar itself, and
  // the chat trigger.
  if (screenshotOverlay && !screenshotOverlay.isDestroyed()) screenshotOverlay.hide();
  const petWasVisible = petWindow && !petWindow.isDestroyed() && petWindow.isVisible();
  if (petWasVisible) petWindow.hide();
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
  if (notesWindow && !notesWindow.isDestroyed()) { notesHideForCapture = true; notesWindow.hide(); }
  if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed()) deadlineAlertWindow.hide();
  if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.hide();
  const assistantWasVisible = assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible();
  if (assistantWasVisible) assistantWindow.hide();
  hideHoverCard(); // the preview card must not float into the shot either
  const statsWasVisible = statsWindow && !statsWindow.isDestroyed() && statsWindow.isVisible();
  if (statsWasVisible) statsWindow.hide();
  const infoWasVisible = infoWindow && !infoWindow.isDestroyed() && infoWindow.isVisible();
  if (infoWasVisible) infoWindow.hide();
  if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
  if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.hide();
  let captured = false;
  try {
    // Give the compositor a beat to drop the windows off the screen first.
    await new Promise(r => setTimeout(r, 200));
    await doCaptureScreenshot(region);
    captured = true;
  } finally {
    // Restore only the active mode's windows (week strip OR sidebar trio).
    if (activeMode === 'week') {
      if (weekWindow && !weekWindow.isDestroyed()) weekWindow.show();
    } else {
      if (petWasVisible && petWindow && !petWindow.isDestroyed()) petWindow.show();
      if (statusWindow && !statusWindow.isDestroyed()) showCardWindow(statusWindow);
    }

    if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) chatTriggerWindow.show();
    if (notesWindow && !notesWindow.isDestroyed()) notesWindow.show();
    if (assistantWasVisible && assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.show();
    if (statsWasVisible && statsWindow && !statsWindow.isDestroyed()) statsWindow.show();
    if (infoWasVisible && infoWindow && !infoWindow.isDestroyed()) infoWindow.show();
    notesHideForCapture = false;
    if (focusSessionActive && focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.show();
    if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed()) deadlineAlertWindow.show();
    closeScreenshotOverlay();
    // Only claim success when the grab actually worked (the toast is driven
    // by this event).
    if (captured && petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('screenshot-done');
  }
});

ipcMain.on('cancel-screenshot', () => {
  dlog('cancel-screenshot IPC received');
  closeScreenshotOverlay('cancel-ipc');
});

// Union of all display bounds — the area a 'screen' capture thumbnail spans.
function virtualScreenBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of screen.getAllDisplays()) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

async function doCaptureScreenshot({ x, y, width, height }) {
  const display = screenshotDisplay || screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const vs = virtualScreenBounds();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(vs.width * scale)),
      height: Math.max(1, Math.round(vs.height * scale)),
    },
  });
  if (sources.length === 0) return;
  const fullImage = sources[0].thumbnail;
  const cropped = fullImage.crop({
    x: Math.max(0, Math.round((display.bounds.x + x - vs.x) * scale)),
    y: Math.max(0, Math.round((display.bounds.y + y - vs.y) * scale)),
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  });
  const buf = cropped.toPNG();
  clipboard.writeImage(nativeImage.createFromBuffer(buf));
}

ipcMain.handle('capture-screenshot', async (event, region) => {
  await doCaptureScreenshot(region);
  return true;
});

// === Clipboard IPC ===
ipcMain.handle('write-clipboard', (event, text) => {
  const clean = String(text || '');
  clipboard.writeText(clean);
  lastWrittenText = clean;
  lastClipboardText = clean;
  pushClipboardItem({ type: 'text', text: clean });
  return true;
});

ipcMain.handle('get-clipboard-history', () => clipboardHistory);

// Serve a stored clipboard image as a data URL (resized so the vault
// thumbnail stays light over IPC).
ipcMain.handle('get-clipboard-image', (event, hash) => {
  if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{40}$/.test(hash)) return '';
  const file = path.join(clipboardImgDir(), hash + '.png');
  if (!fs.existsSync(file)) return '';
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return '';
    const size = img.getSize();
    const resized = size.width > 440 ? img.resize({ width: 440 }) : img;
    return resized.toDataURL();
  } catch (e) { return ''; }
});

// Copy a stored clipboard image back to the OS clipboard.
ipcMain.handle('write-clipboard-image', (event, hash) => {
  if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{40}$/.test(hash)) return false;
  const file = path.join(clipboardImgDir(), hash + '.png');
  if (!fs.existsSync(file)) return false;
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    lastClipboardImageHash = hash; // the watcher must not re-push the same image
    return true;
  } catch (e) { return false; }
});

// Delete by content key: text entries match on text, images on hash.
ipcMain.on('delete-clipboard-item', (event, key) => {
  const before = clipboardHistory.length;
  clipboardHistory = clipboardHistory.filter(i => i.text !== key && i.hash !== key);
  if (clipboardHistory.length !== before) {
    deleteClipboardImageFile(key);
    saveClipboardHistory();
    broadcastClipboardHistory();
  }
});

ipcMain.on('clear-clipboard-history', () => {
  clipboardHistory = [];
  clearClipboardImageFiles();
  saveClipboardHistory();
  broadcastClipboardHistory();
});

// === Clipboard history manager (polls the OS clipboard) ===
function loadClipboardHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(clipboardHistoryFile(), 'utf8'));
    if (!Array.isArray(arr)) return [];
    // Old entries ({text, time}) predate image support — normalize them.
    return arr.map(i => (i && i.type) ? i : { type: 'text', text: i.text, time: i.time });
  } catch (e) {
    return [];
  }
}

function saveClipboardHistory() {
  try {
    fs.writeFileSync(clipboardHistoryFile(), JSON.stringify(clipboardHistory));
  } catch (e) {
    // Ignore write errors (e.g. userData not writable)
  }
}

function clipboardItemKey(i) {
  return i.type === 'image' ? 'img:' + i.hash : 'text:' + i.text;
}

function pushClipboardItem(item) {
  if (!item || typeof item !== 'object') return;
  if (item.type !== 'image' && (!item.text || typeof item.text !== 'string')) return;
  const key = clipboardItemKey(item);
  if (clipboardHistory[0] && clipboardItemKey(clipboardHistory[0]) === key) return; // already newest
  clipboardHistory = clipboardHistory.filter(i => clipboardItemKey(i) !== key);
  clipboardHistory.unshift({ ...item, time: Date.now() });
  if (clipboardHistory.length > MAX_HISTORY) {
    const evicted = clipboardHistory.splice(MAX_HISTORY);
    evicted.forEach(i => { if (i.type === 'image') deleteClipboardImageFile(i.hash); });
  }
  saveClipboardHistory();
  broadcastClipboardHistory();
}

function deleteClipboardImageFile(hash) {
  if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{40}$/.test(hash)) return;
  try { fs.unlinkSync(path.join(clipboardImgDir(), hash + '.png')); } catch (e) { /* already gone */ }
}

function clearClipboardImageFiles() {
  try {
    const dir = clipboardImgDir();
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    }
  } catch (e) {}
}

function broadcastClipboardHistory() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('clipboard-history', clipboardHistory);
  }
}

function startClipboardWatcher() {
  try { lastClipboardText = clipboard.readText() || ''; } catch (e) {}
  // Text is cheap to poll every 800ms, but images are NOT: readImage() +
  // toPNG() + SHA-1 on a large screenshot every tick is heavy (a copied 4K
  // screenshot can cost tens of ms of main-process CPU per pass). The image
  // branch only runs every 4th tick (~3.2s) — screenshots still land in the
  // vault within a few seconds, without the constant hash hammering.
  let imgTick = 0;
  setInterval(() => {
    let t = '';
    try { t = clipboard.readText() || ''; } catch (e) {}
    if (t && t !== lastClipboardText && t !== lastWrittenText) {
      lastClipboardText = t;
      pushClipboardItem({ type: 'text', text: t });
    }
    imgTick++;
    if (imgTick % 4 !== 0) return;
    // Images (screenshots, copied pictures): content-hash dedupe so the
    // same picture never appears twice.
    let img = null;
    try { img = clipboard.readImage(); } catch (e) {}
    if (img && !img.isEmpty()) {
      let hash = '';
      try { hash = crypto.createHash('sha1').update(img.toPNG()).digest('hex'); } catch (e) {}
      if (hash && hash !== lastClipboardImageHash) {
        lastClipboardImageHash = hash;
        try {
          fs.mkdirSync(clipboardImgDir(), { recursive: true });
          const file = path.join(clipboardImgDir(), hash + '.png');
          if (!fs.existsSync(file)) fs.writeFileSync(file, img.toPNG());
          pushClipboardItem({ type: 'image', hash });
        } catch (e) { /* storage failure — skip, never crash the watcher */ }
      }
    }
  }, 800);
}

// === Cursor polling (dynamic click-through for the pet window) ===
function setMouseIgnored(ignore) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (ignore !== mouseIgnored) {
    petWindow.setIgnoreMouseEvents(ignore, { forward: true });
    mouseIgnored = ignore;
  }
}

function startCursorPolling() {
  if (cursorPollInterval) return;
  cursorPollInterval = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    // While asleep or Alt+C-peeking the app is fully click-through — the
    // chrome is faded/hidden, so clicks must pass to whatever is underneath.
    if (sleeping || peekActive) { setMouseIgnored(true); return; }
    const pos = screen.getCursorScreenPoint();
    const b = petWindow.getBounds();
    const rx = pos.x - b.x;
    const ry = pos.y - b.y;

    // Any interactive region under the cursor unlocks the window.
    let hit = false;
    for (const r of interactiveBounds) {
      if (rx >= r.x && rx <= r.x + r.w && ry >= r.y && ry <= r.y + r.h) {
        hit = true;
        break;
      }
    }
    setMouseIgnored(!hit);
  }, 100);
}

function stopPolling() {
  if (cursorPollInterval) {
    clearInterval(cursorPollInterval);
    cursorPollInterval = null;
  }
  if (chatTriggerPoll) {
    clearInterval(chatTriggerPoll);
    chatTriggerPoll = null;
  }
  if (weekPollInterval) {
    clearInterval(weekPollInterval);
    weekPollInterval = null;
  }
  if (layoutWatchdog) {
    clearInterval(layoutWatchdog);
    layoutWatchdog = null;
  }
}

// === System tray ===
// The pet windows are frameless and hidden from the taskbar, so there's no
// close button. A tray icon gives a clean way to quit (and re-show) the app.
// Uses build/icon.ico (generated by npm run icon); falls back to a
// letterboxed 16px crop of wolf.png if the .ico is missing.
let tray = null;

function createTray() {
  if (tray) return;
  let icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  if (icon.isEmpty()) {
    const src = nativeImage.createFromPath(path.join(__dirname, 'wolf.png'));
    if (src.isEmpty()) return; // neither icon available — skip the tray
    const s = 16;
    const g = src.getSize();
    const scale = Math.min(s / g.width, s / g.height);
    const w = Math.max(1, Math.round(g.width * scale));
    const h = Math.max(1, Math.round(g.height * scale));
    const scaled = src.resize({ width: w, height: h }).toBitmap();
    const canvas = Buffer.alloc(s * s * 4);
    const x0 = Math.floor((s - w) / 2);
    const y0 = Math.floor((s - h) / 2);
    for (let row = 0; row < h; row++) {
      scaled.copy(canvas, ((y0 + row) * s + x0) * 4, row * w * 4, (row + 1) * w * 4);
    }
    icon = nativeImage.createFromBitmap(canvas, { width: s, height: s });
  }
  tray = new Tray(icon);
  tray.setToolTip('Halo v' + app.getVersion());
  buildTrayMenu();
}

// Summon the app to a specific display: wake it first if it's asleep, then
// re-anchor the whole app to the chosen screen and recompute every window's
// position + size for that screen (so it renders correctly there, whatever
// the resolution/scale). Works whether the app is hidden or already on
// another monitor.
function summonToDisplay(index, display) {
  dlog('summon click: index', index, 'display', display ? display.bounds : null);
  const displays = screen.getAllDisplays();
  // Resolve the target by GEOMETRY first: the menu captured the live display
  // object at build time, so a position/id match always lands on the exact
  // monitor the user clicked — even if the enumeration reordered or the ids
  // changed between building the menu and clicking it. The index is only a
  // fallback when geometry doesn't match (e.g. the display was unplugged).
  let target = null;
  if (display) {
    target = displays.find((d) => sameMonitor(d, display)) || null;
    if (!target && display.id != null) target = displays.find((d) => d.id === display.id) || null;
  }
  if (!target && typeof index === 'number') target = displays[index] || null;
  if (!target) {
    dlog('summon: no matching display for index', index);
    return;
  }
  dlog('summon to display →', target.id, target.bounds);
  // Anchor BEFORE waking so the windows are laid out on the target screen
  // immediately — no flash of the old monitor first.
  appDisplay = target;
  if (sleeping) applySleep(false);
  relayoutWindows();
  // A running focus session owns the screen: summoning must NOT flash the
  // planner back up — just move the slim focus bar to the new display.
  if (focusSessionActive) {
    ensureFocusBar();
    dlog('summon complete (focus session) — anchor:', appDisplay.bounds);
    buildTrayMenu();
    return;
  }
  // Re-apply the CURRENT mode so the week strip (or sidebar) re-lays out on
  // the new screen without switching views out from under the user.
  setAppMode(activeMode);
  if (petWindow && !petWindow.isDestroyed()) petWindow.focus();
  dlog('summon complete — anchor:', appDisplay.bounds, 'pet:', petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null);
  buildTrayMenu(); // move the checkmark to the new anchor
}

// Cycle the whole app to the NEXT display in the enumeration (wrapping
// around). A guaranteed keyboard path for switching screens that doesn't
// depend on the tray menu at all — Ctrl+Shift+Alt+S. Same summon semantics
// as the tray's "Summon to Screen…": wake first, then re-anchor + relayout.
// Debounced like toggleSleep: the global shortcut AND the PowerShell key
// watcher both fire on the same press, so without the guard one press would
// skip two monitors.
let lastCycleToggle = 0;
function cycleToNextDisplay() {
  const now = Date.now();
  if (now - lastCycleToggle < 400) return;
  lastCycleToggle = now;
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return;
  const cur = anchorDisplay();
  const idx = displays.findIndex((d) => sameMonitor(d, cur));
  const next = displays[(idx + 1) % displays.length] || displays[0];
  dlog('cycle to next display →', next.id, next.bounds);
  summonToDisplay(displays.findIndex((d) => sameMonitor(d, next)), next);
}

// Build the tray menu. The screen submenu is rebuilt whenever displays
// change or the app re-anchors, so it always lists the live monitors and
// marks the one the app is currently summoned to. Clicking a screen summons
// the app there (waking it if needed); the top item hides (unsummons) or
// shows the planner.
function buildTrayMenu() {
  if (!tray) return;
  const displays = screen.getAllDisplays();
  const primaryIdx = displays.findIndex((d) => sameMonitor(d, screen.getPrimaryDisplay()));
  const anchorIdx = displays.findIndex((d) => sameMonitor(d, anchorDisplay()));
  dlog('tray menu displays:', displays.map((d) => `${d.id}:${d.size.width}x${d.size.height}@${d.bounds.x},${d.bounds.y}`).join(' | '));

  // Plain items (not type:'checkbox') with the anchor shown as a ✓ in the
  // label: Windows tray checkboxes can swallow the click when the handler
  // rebuilds the menu mid-click, and a label mark survives menu rebuilds.
  // The click is deferred a tick so the tray menu fully closes before any
  // window moves / menu rebuild happens.
  const screenItems = displays.map((d, i) => ({
    label: `${i === anchorIdx ? '✓ ' : ''}${d.label || `Screen ${i + 1}`}${i === primaryIdx ? ' (Primary)' : ''} — ${d.size.width}×${d.size.height}`,
    click: () => setTimeout(() => summonToDisplay(i, d), 0),
  }));

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Halo v${app.getVersion()} · ${BUILD_TAG}`, enabled: false },
    { type: 'separator' },
    {
      label: sleeping ? 'Show Planner' : 'Hide Planner',
      click: () => {
        if (sleeping) {
          // Summoned from the tray — wake the app on the display the cursor
          // is on now, exactly like the Ctrl+Shift+S wake. For a specific
          // monitor use "Summon to Screen…" below.
          wakeToCursorDisplay();
          if (petWindow && !petWindow.isDestroyed()) petWindow.focus();
        } else {
          applySleep(true); // unsummon: hide the whole app
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Summon to Screen…',
      enabled: screenItems.length > 1,
      submenu: screenItems,
    },
    {
      label: 'Next Screen (Ctrl+Shift+Alt+S)',
      enabled: screenItems.length > 1,
      click: () => setTimeout(cycleToNextDisplay, 0),
    },
    { type: 'separator' },
    {
      label: 'Open Debug Log',
      click: () => {
        // Reveal the per-launch debug log so multi-monitor/summon issues can
        // be reported without hunting for the userData folder.
        try { shell.showItemInFolder(debugLogPath()); } catch (e) {}
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// === Display-change re-layout ===
// Recompute every window's position + size from the anchor display's current
// metrics. Called at startup (safety net after creation) and on every
// display-config change, so a resolution / scale / plug change can never
// leave a window off-screen or on the wrong monitor.
function relayoutWindows() {
  const disp = anchorDisplay();
  const wa = disp.workArea;
  dlog('relayout windows → display', disp.id, disp.bounds);

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setBounds({
      x: wa.x + wa.width - SIDEBAR_W - 8,
      y: wa.y + SIDEBAR_TOP,
      width: SIDEBAR_W,
      height: petHeight(wa.height),
    });
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.setBounds({
      x: wa.x + wa.width - SIDEBAR_W - 8,
      y: wa.y + 6,
      width: SIDEBAR_W,
      height: 46,
    });
  }
  if (chatTriggerWindow && !chatTriggerWindow.isDestroyed()) {
    chatTriggerWindow.setBounds({ x: wa.x + 4, y: chatTriggerY(wa), width: CHAT_TRIGGER_SIZE, height: CHAT_TRIGGER_SIZE });
  }
  if (assistantWindow && !assistantWindow.isDestroyed()) {
    assistantWindow.setBounds({ x: wa.x, y: assistantY(wa), width: ASSISTANT_W, height: assistantHeight(wa) });
  }
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.setBounds({
      x: statsX(wa),
      y: statsY(wa),
      width: statsWidth(wa),
      height: statsHeight(wa),
    });
  }
  if (notesWindow && !notesWindow.isDestroyed()) {
    // Re-anchor the card to its slot in the middle column. In normal view the
    // user's resized width/height is kept (clamped); in Week view Notes and
    // Info share a row, so the card snaps to the computed compact size.
    const b = notesWindow.getBounds();
    const w = activeMode === 'week' ? notesW(wa) : Math.min(Math.max(260, b.width), notesW(wa));
    const h = activeMode === 'week' ? notesH(wa) : Math.min(Math.max(280, b.height), notesH(wa));
    const y = Math.min(notesY(wa), wa.y + wa.height - h - 8);
    notesWindow.setBounds({ x: notesX(wa), y: y, width: w, height: h });
  }
  if (infoWindow && !infoWindow.isDestroyed()) {
    infoWindow.setBounds({ x: infoX(wa), y: infoY(wa), width: infoW(wa), height: infoH(wa) });
  }
  if (weekWindow && !weekWindow.isDestroyed()) {
    weekWindow.setBounds({
      x: wa.x + ASSISTANT_W + 8,
      y: wa.y + 8,
      width: wa.width - ASSISTANT_W - 16,
      height: weekStripHeight(wa.height),
    });
  }
  if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed()) {
    const b = disp.bounds;
    deadlineAlertWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }
  if (screenshotOverlay && !screenshotOverlay.isDestroyed() && screenshotDisplay) {
    screenshotOverlay.setBounds(screenshotDisplay.bounds);
  }
  if (focusBarWindow && !focusBarWindow.isDestroyed()) {
    focusBarWindow.setBounds({
      x: wa.x + wa.width - SIDEBAR_W - 8,
      y: wa.y + 60,
      width: SIDEBAR_W,
      height: 76,
    });
  }
  if (hoverCardWindow && !hoverCardWindow.isDestroyed() && hoverCardWindow.isVisible()) {
    // Re-anchor the card to the (possibly new) planner position.
    const pet = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
    if (pet) {
      const x = Math.max(wa.x, Math.min(pet.x - HOVER_CARD_W - 12, wa.x + wa.width - HOVER_CARD_W - 4));
      const y = Math.max(wa.y, Math.min(hoverCardWindow.getBounds().y, wa.y + wa.height - 178));
      hoverCardWindow.setBounds({ x, y, width: HOVER_CARD_W, height: 170 });
    }
  }
}

// Every display-config event re-runs the layout: resolution/scale changes
// (display-metrics-changed), monitors plugged in or unplugged, and the
// primary display switching. The app KEEPS its current anchor while that
// display still exists — an explicit "Summon to Screen" choice must never
// be overridden just because the cursor happens to be on another monitor
// (moving windows across mixed-DPI screens fires display-metrics-changed,
// which previously dragged the app back to wherever the cursor was, e.g.
// the tray's own screen). Every window re-sizes to the anchor's current
// metrics so a resolution/scale change can't leave the app cut off. Only
// when the anchor display was removed (unplugged) does the app re-anchor
// to the display under the cursor.
function watchDisplayChanges() {
  ['display-metrics-changed', 'display-added', 'display-removed'].forEach((ev) => {
    screen.on(ev, () => {
      dlog('display change:', ev);
      anchorDisplay(); // re-anchors ONLY if the current anchor no longer exists
      relayoutWindows();
      buildTrayMenu(); // refresh the screen list / checkmarks
    });
  });
}

// True when a rectangle intersects any display's work area (used to detect
// windows stranded off-screen, e.g. after a monitor was unplugged).
function isOnScreen(bounds) {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return (
      bounds.x < wa.x + wa.width && bounds.x + bounds.width > wa.x &&
      bounds.y < wa.y + wa.height && bounds.y + bounds.height > wa.y
    );
  });
}

// === Layout watchdog (self-healing) ===
// Windows doesn't always deliver display events — a monitor unplugged while
// the app is asleep, a resolution/scale changed via the control panel, or
// the OS relocating windows between displays can all happen without one.
// Every few seconds, verify the app is still where the anchor layout expects
// it and re-apply if anything drifted, so the layout ALWAYS recalculates.
let layoutWatchdog = null;

// If the OS relocated the pet window to another display (unplug, primary
// switch, user dragging it in an OS-specific way), re-anchor to that display
// so the whole app follows the window instead of hovering on the old one.
function followPetWindowDisplay() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const b = petWindow.getBounds();
  const nearest = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  if (!appDisplay || !sameMonitor(nearest, appDisplay)) {
    appDisplay = nearest;
    dlog('re-anchored to pet window display →', nearest.id);
    relayoutWindows();
  }
}

function startLayoutWatchdog() {
  if (layoutWatchdog) return;
  layoutWatchdog = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    // During the startup card the planner/status/chat are hidden ON PURPOSE —
    // the self-heal below must NOT pop them back up over the boot screen.
    if (booting) return;
    // Follow the window if Windows moved it to another display…
    followPetWindowDisplay();
    // …otherwise confirm the layout still matches the anchor and re-apply if
    // anything drifted (resolution/scale changed without a delivered event).
    const disp = anchorDisplay();
    const wa = disp.workArea;
    const b = petWindow.getBounds();
    const ex = wa.x + wa.width - SIDEBAR_W - 8;
    const ey = wa.y + SIDEBAR_TOP;
    const ew = SIDEBAR_W;
    const eh = petHeight(wa.height);
    if (
      Math.abs(b.x - ex) > 4 || Math.abs(b.y - ey) > 4 ||
      Math.abs(b.width - ew) > 4 || Math.abs(b.height - eh) > 4
    ) {
      dlog('layout drift detected — relayout');
      relayoutWindows();
    }
    // Window-visibility self-heal: a show/hide that never landed (or a
    // window that was closed by a crash and is now null) must not leave the
    // app half-visible. When asleep/peeking, chrome must stay hidden; when
    // awake and not in a focus session, every chrome window must be on
    // screen — otherwise the app looks broken after sleep/wake cycles.
    if (sleeping || peekActive) {
      if (chatTriggerWindow && !chatTriggerWindow.isDestroyed() && chatTriggerWindow.isVisible()) chatTriggerWindow.hide();
      if (statusWindow && !statusWindow.isDestroyed() && statusWindow.isVisible()) statusWindow.hide();
      if (sleeping && petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) petWindow.hide();
    } else if (!focusSessionActive) {
      // Week mode hides the planner + status bar BY DESIGN (the week strip
      // owns the screen) — the self-heal must not pop them back up over it.
      // Conversely, if a stray pet/status is still up in week mode (a wake
      // landing mid-transition), hide it — the strip owns the screen.
      if (activeMode === 'week') {
        if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) petWindow.hide();
        if (statusWindow && !statusWindow.isDestroyed() && statusWindow.isVisible()) statusWindow.hide();
      } else {
        if (petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) {
          dlog('pet window missing — restoring');
          petWindow.show();
          relayoutWindows();
        }
        if (!statusWindow || statusWindow.isDestroyed()) {
          dlog('status window missing — recreating');
          createStatusWindow();
          relayoutWindows();
        } else if (!statusWindow.isVisible()) {
          dlog('status window missing — restoring');
          showCardWindow(statusWindow);
          relayoutWindows();
        }
      }
      // The chat trigger stays pinned to the top-left corner in every mode;
      // self-heal it if it ever goes missing.
      if (!chatTriggerWindow || chatTriggerWindow.isDestroyed()) {
        dlog('chat trigger missing — recreating');
        createChatTriggerWindow();
        relayoutWindows();
      } else if (!chatTriggerWindow.isVisible()) {
        chatTriggerWindow.show();
      }
    }
  }, 3000);
}

// === App Lifecycle ===
// Only one instance may run. A second launch (double-click, another npm
// start, a stray copy) quits immediately and focuses the existing window
// instead — two stacked windows double the dark overlay and look broken.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Wake first if asleep, so the renderer isn't left faded while the
    // windows come back.
    if (sleeping) applySleep(false);
    // The user just launched the app again — bring it to the display their
    // cursor is on NOW (e.g. it was on the big monitor, they moved to the
    // laptop, and double-clicked the shortcut).
    appDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    relayoutWindows();
    // A running focus session owns the screen — a second launch must not pop
    // the planner back up over the bar; just move the bar to the cursor's
    // display.
    if (focusSessionActive) { ensureFocusBar(); return; }
    // Re-show the ACTIVE mode only (never the week strip AND the sidebar at
    // once — one mode at a time).
    setAppMode(activeMode);
    if (petWindow && !petWindow.isDestroyed() && petWindow.isMinimized()) petWindow.restore();
    if (activeMode !== 'week' && petWindow && !petWindow.isDestroyed()) petWindow.focus();
  });

  app.whenReady().then(() => {
    // Windows identity: groups the app under its own taskbar/toast identity
    // instead of a generic "Electron" entry.
    app.setAppUserModelId('com.halo.Halo');
    // Record the startup environment in the debug log: where the log lives
    // and every display the OS reports (id / label / size / position), so
    // summon behavior can be diagnosed straight from the file.
    dlog('app ready — userData:', app.getPath('userData'));
    dlog('displays:', screen.getAllDisplays().map((d) => `${d.id}:${d.label || '?'}:${d.size.width}x${d.size.height}@${d.bounds.x},${d.bounds.y}`).join(' | '));
    clipboardHistory = loadClipboardHistory();
    createPetWindow();
    createStatusWindow();
    createChatTriggerWindow();
    // The screenshot overlay is created lazily on first use (openScreenshotOverlay
    // already handles a null overlay) instead of holding a full-screen transparent
    // renderer process alive for the whole session.
    startClipboardWatcher();
    createTray();
    // Re-apply the layout after creation (safe even if a display changed
    // between the windows being built) and keep it in sync with any display
    // configuration change while the app runs.
    relayoutWindows();
    showBootWindow();
    watchDisplayChanges();
    startLayoutWatchdog();
    // System-wide Ctrl+Shift+S = sleep/wake (hide the app from the screen,
    // then summon it back). Registered AFTER the windows exist so the
    // fallback (before-input-event on each window) is already in place.
    // The combo is consumed at the OS level whenever this succeeds.
    const shortcutOk = globalShortcut.register('CommandOrControl+Shift+S', toggleSleep);
    dlog('global shortcut Ctrl+Shift+S:', shortcutOk ? 'registered' : 'FAILED — falling back to key watcher');
    // Ctrl+Shift+Alt+S = cycle the app to the next monitor (guaranteed
    // screen-switch path, independent of the tray menu).
    const cycleOk = globalShortcut.register('CommandOrControl+Shift+Alt+S', cycleToNextDisplay);
    dlog('global shortcut Ctrl+Shift+Alt+S:', cycleOk ? 'registered' : 'FAILED — falling back to key watcher');
    // Ctrl+Shift+A = summon the assistant chat from anywhere.
    const asstOk = globalShortcut.register('CommandOrControl+Shift+A', () => toggleAssistantWindow());
    dlog('global shortcut Ctrl+Shift+A:', asstOk ? 'registered' : 'FAILED');
    // Belt & braces on Windows: PowerShell key watchers poll the raw key state
    // (Ctrl+Shift+S sleep/wake + Alt+C peek + Ctrl+Shift+Alt+S next screen),
    // so they still fire if another app owns the hotkey or the OS-level
    // registration failed. Each watcher is a persistent PowerShell process
    // polling every 30ms, so they only spawn for the shortcuts that actually
    // NEED the fallback — when the OS-level RegisterHotKey succeeded the
    // watcher would be pure overhead (extra process + constant CPU). Alt+C
    // has no global shortcut at all, so its watcher always runs. The debounces
    // in toggleSleep / setPeek absorb any duplicate between the paths.
    if (process.platform === 'win32') {
      if (!shortcutOk) startShiftSKeyWatcher();
      startAltCWatcher();
      if (!cycleOk) startCycleKeyWatcher();
    }
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopShiftSKeyWatcher();
  stopAltCKeyWatcher();
  stopCycleKeyWatcher();
  stopPolling();
  if (tray) { tray.destroy(); tray = null; }
  saveClipboardHistory();
  if (screenshotOverlay) { screenshotOverlay.close(); screenshotOverlay = null; }
  if (notesWindow) { notesWindow.close(); notesWindow = null; }
  if (infoWindow) { infoWindow.close(); infoWindow = null; }
  if (deadlineAlertWindow) { deadlineAlertWindow.close(); deadlineAlertWindow = null; }
  if (weekWindow) { weekWindow.close(); weekWindow = null; }
  if (focusBarWindow) { focusBarWindow.close(); focusBarWindow = null; }
  if (hoverCardWindow) { hoverCardWindow.close(); hoverCardWindow = null; }
});

app.on('window-all-closed', () => {
  app.quit();
});

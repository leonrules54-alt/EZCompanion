const { app, BrowserWindow, screen, ipcMain, globalShortcut, desktopCapturer, clipboard, nativeImage, Tray, Menu, shell } = require('electron');
const crypto = require('crypto');

// Bumped whenever the summon/wake/screen logic changes — shown in the tray
// menu so a running app can be identified as new or stale at a glance.
const BUILD_TAG = 'summon-v13';
const WOLF_DEBUG = !!process.env.WOLF_DEBUG;
// dlog() keeps the old console behavior when WOLF_DEBUG is set, and ALWAYS
// appends to a per-launch debug log (userData/wolf-debug.log) so window/
// summon/multi-monitor decisions can be diagnosed straight from the file —
// no terminal or env var needed. The log is truncated on each launch and
// capped at 512KB.
const debugLogPath = () => path.join(app.getPath('userData'), 'wolf-debug.log');
let debugLogReady = false;
let debugLogSize = 0;
function dlog(...args) {
  const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  if (WOLF_DEBUG) console.log('[wolf-debug]', line);
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
// If you explicitly want a dev server to serve the renderer, set WOLF_DEV_URL
// to its base URL (e.g. WOLF_DEV_URL=http://localhost:3737 npm run electron)
// and the windows will load from there instead.
const WOLF_DEV_URL = process.env.WOLF_DEV_URL ? String(process.env.WOLF_DEV_URL).replace(/\/+$/, '') : null;

function loadAppFile(win, file) {
  if (!win || win.isDestroyed()) return;
  if (WOLF_DEV_URL) {
    win.loadURL(`${WOLF_DEV_URL}/${file}`);
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
      allowed = WOLF_DEV_URL
        ? parsed.origin === new URL(WOLF_DEV_URL).origin
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
let buttonWindow = null;      // floating launcher button (top-left, ring menu on hover)
let buttonRingOpen = false;   // whether the launcher's ring menu is currently open
let buttonLatched = false;    // cursor rested on the button — stay interactive until it leaves the window
let screenshotOverlay = null;
let screenshotDisplay = null; // display the screenshot overlay currently targets
let interactiveBounds = [];           // [{x, y, w, h} window-relative coords]
let lastBoundsLog = '';               // last logged bounds JSON (dedupe the 400ms refresh)

let cursorPollInterval = null;
let buttonPollInterval = null;
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
// the whole window. The floating launcher button lives in its own tiny
// window in the top-LEFT corner of the screen.
const SIDEBAR_W = 430;
// The planner starts a little lower than the old 58px so the status strip
// has breathing room and the whole app feels less "hugged" against the top.
const SIDEBAR_TOP = 78;

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
    show: true,
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
    height: 64,
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
  if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.show();
}

// === Floating launcher button window (top-left corner of the screen) ===
// A tiny transparent window holding the app's "menu" button. Clicking the
// button opens the radial ring menu (the app's feature menu);
// the ring closes when the cursor leaves the window. Click-through except
// over the button (or the open ring), so it never blocks clicks aimed at
// whatever sits behind it in the corner.
const BTN_SIZE = 280;
const BTN_CENTER = BTN_SIZE / 2;   // the button sits dead-centre of the window
// The launcher's top edge offset inside the work area (matches
// buttonPlacement). The notes card and hover card park BELOW the launcher's
// bottom edge so they can never cover the button.
const BTN_Y_TOP = 24;

// The launcher parks top-left, flush against the left edge of the planner
// sidebar (the position users expect). The notes card and hover card used
// to pop up over this same spot and hide the button — they now park BELOW
// the button (see notesY / showHoverCard), so nothing can cover it. During
// Week view the launcher moves to the bottom-right corner, below the week
// strip, so it never covers it.
function buttonPlacement(wa) {
  if (activeMode === 'week') {
    return { x: Math.max(wa.x, wa.x + wa.width - BTN_SIZE - 16), y: Math.max(wa.y, wa.y + wa.height - BTN_SIZE - 16) };
  }
  // Clamped so a very narrow display can't push the window off-screen.
  return {
    x: Math.max(wa.x, wa.x + wa.width - SIDEBAR_W - 8 - 8 - BTN_SIZE),
    y: wa.y + BTN_Y_TOP,
  };
}

// Move the launcher window to wherever the current view mode wants it.
function positionButtonWindow() {
  if (!buttonWindow || buttonWindow.isDestroyed()) return;
  const p = buttonPlacement(anchorDisplay().workArea);
  buttonWindow.setBounds({ x: p.x, y: p.y, width: BTN_SIZE, height: BTN_SIZE });
}

function createButtonWindow() {
  if (buttonWindow) return;
  const wa = anchorDisplay().workArea;
  const p = buttonPlacement(wa);

  buttonWindow = new BrowserWindow({
    width: BTN_SIZE,
    height: BTN_SIZE,
    x: p.x,
    y: p.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  hardenWindow(buttonWindow);
  loadAppFile(buttonWindow, 'button.html');
  buttonWindow.setIgnoreMouseEvents(true, { forward: true });
  buttonWindow.on('closed', () => {
    buttonWindow = null;
    buttonRingOpen = false;
    buttonLatched = false;
    if (buttonPollInterval) { clearInterval(buttonPollInterval); buttonPollInterval = null; }
  });

  // Poll: the button area is always hoverable; once the cursor rests on the
  // button (or the ring menu is open) the whole window stays interactive so
  // every segment receives clicks, until the cursor leaves the window. The
  // ring itself is opened/closed by CLICKING the button (no hover-hold).
  if (buttonPollInterval) clearInterval(buttonPollInterval);
  buttonPollInterval = setInterval(() => {
    if (!buttonWindow || buttonWindow.isDestroyed()) return;
    const pos = screen.getCursorScreenPoint();
    const b = buttonWindow.getBounds();
    const inWindow = pos.x >= b.x - 4 && pos.x <= b.x + b.width + 4 && pos.y >= b.y - 4 && pos.y <= b.y + b.height + 4;
    // Hover-able button pad: a generous circle around the window centre
    // (scaled to the bigger gem).
    const inButton = Math.hypot(pos.x - (b.x + BTN_CENTER), pos.y - (b.y + BTN_CENTER)) <= 74;
    // Assistant bubble: a 💬 chip at the window's top-left corner
    // ("top middle-left" of the launcher). It must stay clickable whenever
    // the cursor is over it, even when the ring is closed.
    const inAssist = Math.hypot(pos.x - (b.x + 40), pos.y - (b.y + 40)) <= 34;
    // Latch: once the cursor has rested on the button, keep the window
    // interactive until the cursor leaves — no click-through hiccup while
    // sliding from the button onto a ring segment.
    if (inButton || inAssist) buttonLatched = true;
    else if (!inWindow) buttonLatched = false;

    const over = buttonLatched || (buttonRingOpen && inWindow);
    buttonWindow.setIgnoreMouseEvents(!over, { forward: true });
    // The renderer paints the hover state and closes the ring when the
    // cursor leaves the whole window.
    buttonWindow.webContents.send('button-hover', { active: inButton, inWindow, assist: inAssist });
  }, 90);
}

ipcMain.on('button-ring-open', (_e, open) => {
  buttonRingOpen = !!open;
});

// === Quick Notes window (floats to the LEFT of the sidebar, full height) ===
const NOTES_W = 340;
let notesWindow = null;
let notesHideForCapture = false; // suppress blur-close while the screenshot hides us
let notesHiddenBySleep = false; // notes were open when the app slept — restore on wake

// Height of the week strip window for a given work-area height (kept in sync
// with createWeekWindow).
function weekStripHeight(waHeight) {
  return Math.min(430, Math.max(280, Math.round(waHeight * 0.32)));
}

// Where the notes card's top edge sits. Normally it parks BELOW the floating
// launcher button (top-left, flush against the sidebar) so the card can
// never cover it — that overlap used to make the launcher "disappear".
// During Week view the strip owns the top of the screen, so the card parks
// just below the strip instead (and the launcher is bottom-right there).
function notesY(wa) {
  return activeMode === 'week' ? wa.y + weekStripHeight(wa.height) + 14 : wa.y + BTN_Y_TOP + BTN_SIZE + 14;
}

function createNotesWindow() {
  if (notesWindow) return;
  const wa = anchorDisplay().workArea;
  const sideH = petHeight(wa.height); // same basis as the pet window
  const nY = notesY(wa);
  notesWindow = new BrowserWindow({
    width: NOTES_W,
    // Full sidebar height by default so the whole history is visible at a
    // glance (clamped so it never runs past the bottom of the work area and
    // never below the 300px minHeight); the user can drag the edges to
    // resize afterwards (resizable).
    height: Math.max(300, Math.min(Math.max(300, sideH), wa.height - (nY - wa.y))),
  // Right edge sits just left of the sidebar; clamped to the screen on
  // narrow displays. Height shrinks to fit below the launcher button.
  x: Math.max(wa.x, wa.x + wa.width - SIDEBAR_W - 8 - NOTES_W - 12),
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
  // Popup behaviour: clicking anywhere else dismisses it. Programmatic hides
  // (e.g. the screenshot capture hiding every window) are excluded so the
  // popup survives and comes back with everything else.
  notesWindow.on('blur', () => { if (!notesHideForCapture && !notesHiddenBySleep) closeNotesWindow(); });
  notesWindow.on('closed', () => { notesWindow = null; notesHiddenBySleep = false; });
}

function toggleNotesWindow() {
  if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
  if (!notesWindow) return;
  if (notesWindow.isVisible()) {
    closeNotesWindow();
  } else {
    notesWindow.show();
    notesWindow.focus();
  }
}

// === Assistant window (chat that manages your day) ===
// A tall glass chat window parked against the LEFT edge of the screen,
// below the launcher button's top edge. Opened from the 💬 bubble on the
// launcher (or the ring's Assistant action). Messages flow to the pet
// renderer — it owns the data — and replies flow back here.
const ASSISTANT_W = 400;
let assistantWindow = null;
let assistantHiddenBySleep = false;

function createAssistantWindow() {
  if (assistantWindow) return;
  const wa = anchorDisplay().workArea;
  assistantWindow = new BrowserWindow({
    width: ASSISTANT_W,
    // Full-height left column ("takes up the left screen").
    height: Math.max(360, wa.height - BTN_Y_TOP - 12),
    x: Math.max(wa.x, wa.x + 8),
    y: wa.y + BTN_Y_TOP,
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
  hardenWindow(assistantWindow);
  loadAppFile(assistantWindow, 'assistant.html');
  assistantWindow.on('blur', () => { if (!assistantHiddenBySleep) closeAssistantWindow(); });
  assistantWindow.on('closed', () => { assistantWindow = null; assistantHiddenBySleep = false; });
}

function toggleAssistantWindow() {
  if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
  if (!assistantWindow) return;
  if (assistantWindow.isVisible()) closeAssistantWindow();
  else {
    assistantWindow.show();
    assistantWindow.focus();
  }
}

function closeAssistantWindow() {
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.close();
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
  // Cards for top rows used to overlap the launcher button (top-left corner)
  // and hide it — park below the button's bottom edge instead.
  const minY = wa.y + BTN_Y_TOP + BTN_SIZE + 14;
  let y = pet ? pet.y + Math.round(payload.rowTop || 0) - 8 : wa.y + SIDEBAR_TOP;
  y = Math.max(minY, Math.min(y, wa.y + wa.height - 178));
  hoverCardWindow.setBounds({ x, y, width: HOVER_CARD_W, height: 170 });
  const present = () => {
    if (!hoverCardWindow || hoverCardWindow.isDestroyed()) return;
    hoverCardWindow.webContents.send('hover-card-data', payload);
    hoverCardWindow.setAlwaysOnTop(true, 'screen-saver');
    hoverCardWindow.showInactive();
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
  if (notesWindow && !notesWindow.isDestroyed()) notesWindow.close();
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
    if (weekWindow && !weekWindow.isDestroyed()) weekWindow.show();
    if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
    // Full re-layout: the launcher moves to the bottom-right of the screen
    // (below the week strip) and an open notes card drops below the strip
    // instead of overlapping it.
    relayoutWindows();
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.show();
    // Keep the sidebar renderer in sync even while hidden (e.g. so the week
    // view-switch button reads active if the sidebar is ever shown again).
    sendToPet('set-mode', { view: 'week' });
  } else {
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
    // Full re-layout: launcher back to its corner, notes back beside the
    // sidebar, everything re-anchored for the non-week layout.
    relayoutWindows();
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.show();
    sendToPet('set-mode', { view: mode });
  }
}

// Restore the active mode's windows (used after sleep / peek / capture).
function restoreModeWindows() {
  // A running focus session keeps the planner unsummoned — the slim focus
  // bar owns the screen until the session ends.
  if (focusSessionActive) {
    ensureFocusBar();
    return;
  }
  if (activeMode === 'week') {
    createWeekWindow();
    if (weekWindow && !weekWindow.isDestroyed()) weekWindow.show();
    relayoutWindows();
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.show();
  } else {
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
    relayoutWindows();
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.show();
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

function createWeekWindow() {
  if (weekWindow) return;
  const wa = anchorDisplay().workArea;
  weekWindow = new BrowserWindow({
    width: wa.width - 16,
    // Tall enough for each day column to show its whole plan (~a third of
    // the screen's height, like the calendar; past days cross everything out
    // so the columns need room to breathe).
    height: weekStripHeight(wa.height),
    x: wa.x + 8,
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
  weekWindow.on('closed', () => {
    weekWindow = null;
    weekBounds = [];
    if (weekPollInterval) { clearInterval(weekPollInterval); weekPollInterval = null; }
  });

  // Click-through except over the header controls + day columns (cursor poll).
  if (weekPollInterval) clearInterval(weekPollInterval);
  weekPollInterval = setInterval(() => {
    if (!weekWindow || weekWindow.isDestroyed() || !weekWindow.isVisible()) return;
    if (sleeping || peekActive) { weekWindow.setIgnoreMouseEvents(true, { forward: true }); return; }
    const pos = screen.getCursorScreenPoint();
    const b = weekWindow.getBounds();
    let hit = false;
    for (const r of weekBounds) {
      const rx = pos.x - b.x, ry = pos.y - b.y;
      if (rx >= r.x && rx <= r.x + r.w && ry >= r.y && ry <= r.y + r.h) { hit = true; break; }
    }
    weekWindow.setIgnoreMouseEvents(!hit, { forward: true });
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
  screenshotOverlay.on('closed', () => { screenshotOverlay = null; });
}

function closeScreenshotOverlay() {
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
// bar and launcher window hide) so the screen is clean, and the same shortcut
// summons it back. Debounced so duplicate triggers (global shortcut + key
// watcher + window fallback) toggle exactly once.
let sleeping = false;
let lastSleepToggle = 0;

// Wake the app AND place it on the display under the cursor — Ctrl+Shift+S
// and the tray's Show Planner both mean "summon it where I'm looking". This
// restores the old cross-monitor jump users loved, while toggleSleep still
// HIDES the app when it's awake (the "hide" that used to be broken). The
// earlier change kept the old anchor because re-anchoring on EVERY press
// (the inverted-toggle bug) made the app jump around uncontrollably — with
// the toggle fixed, waking to the cursor is deliberate and predictable.
function wakeToCursorDisplay() {
  appDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  dlog('wake — cursor display:', appDisplay.id, appDisplay.bounds);
  applySleep(false);
  relayoutWindows();
  dlog('wake complete — anchor:', appDisplay.bounds, 'pet:', petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null);
}

function toggleSleep() {
  const now = Date.now();
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
  if (!value && !peekActive && !focusSessionActive && petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) {
    petWindow.show();
  }
  sendToPet('set-sleeping', { value: sleeping });
  if (sleeping) {
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.hide();
    if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.hide();
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
    // Hide (not close) an open notes popup so it comes back in the same spot
    // with its content intact when the app is summoned again.
    if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) {
      notesHiddenBySleep = true;
      notesWindow.hide();
    }
    if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
      assistantHiddenBySleep = true;
      assistantWindow.hide();
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
      if (notesWindow && !notesWindow.isDestroyed()) { notesWindow.show(); notesWindow.focus(); }
    }
    if (assistantHiddenBySleep) {
      assistantHiddenBySleep = false;
      if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
      if (assistantWindow && !assistantWindow.isDestroyed()) { assistantWindow.show(); assistantWindow.focus(); }
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
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.hide();
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
    if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.hide();
    if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
      assistantHiddenBySleep = true;
      assistantWindow.hide();
    }
    hideHoverCard();
  } else if (!sleeping) {
    restoreModeWindows();
    // Notes hidden by a sleep cycle come back once the peek ends.
    if (notesHiddenBySleep) {
      notesHiddenBySleep = false;
      if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
      if (notesWindow && !notesWindow.isDestroyed()) { notesWindow.show(); notesWindow.focus(); }
    }
    if (assistantHiddenBySleep) {
      assistantHiddenBySleep = false;
      if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
      if (assistantWindow && !assistantWindow.isDestroyed()) { assistantWindow.show(); assistantWindow.focus(); }
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

function startKeyWatcher(label, keys, onPress, onRelease, onExit) {
  if (process.platform !== 'win32') return null;
  // All listed keys must be down (e.g. Ctrl+Shift+S = [17, 16, 83]).
  const comboCheck = keys.map(k => `([K]::GetAsyncKeyState(${k}) -lt 0)`).join(' -and ');
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::ASCII;',
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class K{[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int v);}\';',
    '$prev=$false;',
    'while($true){',
    `  $d = ${comboCheck};`,
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
  if (!shiftSKeyWatcher) shiftSKeyWatcher = startKeyWatcher('Ctrl+Shift+S', [17, 16, 83], () => toggleSleep(), () => {});
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

// === IPC Handlers ===

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

// Open an app panel from the floating launcher button window. The three view
// modes are handled here (only one is on screen at a time); everything else
// (info/clipboard/notes/settings) is forwarded to the sidebar renderer.
ipcMain.on('open-panel', (_e, action) => {
  if (action === 'tasks' || action === 'calendar' || action === 'week') {
    setAppMode(action);
    return;
  }
  if (action === 'assistant') {
    toggleAssistantWindow(); // the assistant is its own window now
    return;
  }
  if (action && typeof action === 'string') sendToPet('open-panel', { action });
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
  if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
  if (petWindow && !petWindow.isDestroyed()) petWindow.show();
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
  // Back to the sidebar layout — return the launcher to its usual corner
  // and bring an open notes card back beside the sidebar.
  relayoutWindows();
  if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.show();
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
      if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.hide();
      if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) {
        notesHiddenByFocus = true;
        notesWindow.hide();
      }
    }
    createFocusBarWindow();
    if (focusBarWindow && !focusBarWindow.isDestroyed()) {
      focusBarWindow.webContents.send('focus-bar-state', state);
      focusBarWindow.show();
    }
  } else {
    if (focusBarWindow && !focusBarWindow.isDestroyed()) focusBarWindow.hide();
    if (!sleeping && !peekActive) {
      restoreModeWindows();
      if (notesHiddenByFocus) {
        notesHiddenByFocus = false;
        if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
        if (notesWindow && !notesWindow.isDestroyed()) { notesWindow.show(); notesWindow.focus(); }
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

// Screenshot overlay (triggered from the ring menu's Screenshot action)
ipcMain.on('open-screenshot-overlay', () => openScreenshotOverlay());

ipcMain.on('capture-screenshot-close', async (event, region) => {
  // Hide the overlay + app chrome BEFORE grabbing the screen — otherwise the
  // shot would include the overlay's dim/grid, the pet sidebar itself, and
  // the floating launcher button.
  if (screenshotOverlay && !screenshotOverlay.isDestroyed()) screenshotOverlay.hide();
  const petWasVisible = petWindow && !petWindow.isDestroyed() && petWindow.isVisible();
  if (petWasVisible) petWindow.hide();
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
  if (notesWindow && !notesWindow.isDestroyed()) { notesHideForCapture = true; notesWindow.hide(); }
  if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed()) deadlineAlertWindow.hide();
  if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.hide();
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
      if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
      if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.show();
    }
    if (notesWindow && !notesWindow.isDestroyed()) notesWindow.show();
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
  closeScreenshotOverlay();
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
  setInterval(() => {
    let t = '';
    try { t = clipboard.readText() || ''; } catch (e) {}
    if (t && t !== lastClipboardText && t !== lastWrittenText) {
      lastClipboardText = t;
      pushClipboardItem({ type: 'text', text: t });
    }
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
  }, 60);
}

function stopPolling() {
  if (cursorPollInterval) {
    clearInterval(cursorPollInterval);
    cursorPollInterval = null;
  }
  if (buttonPollInterval) {
    clearInterval(buttonPollInterval);
    buttonPollInterval = null;
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
  tray.setToolTip('EZCompanion v' + app.getVersion());
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
  // Route through the mode system so the week strip can't linger alongside
  // the sidebar (one mode at a time).
  setAppMode(activeMode === 'week' ? 'tasks' : activeMode);
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
    { label: `EZCompanion v${app.getVersion()} · ${BUILD_TAG}`, enabled: false },
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
  if (buttonWindow && !buttonWindow.isDestroyed()) {
    const p = buttonPlacement(wa);
    buttonWindow.setBounds({ x: p.x, y: p.y, width: BTN_SIZE, height: BTN_SIZE });
  }
  if (notesWindow && !notesWindow.isDestroyed()) {
    // Keep the user's resized width/height (clamped to the work area) and
    // re-anchor the card to its spot beside the sidebar (or below the week
    // strip in Week view), never pushed past the bottom of the screen.
    const b = notesWindow.getBounds();
    const w = Math.min(Math.max(260, b.width), wa.width - 8);
    const h = Math.min(Math.max(300, b.height), wa.height - SIDEBAR_TOP - 4);
    const y = Math.min(notesY(wa), wa.y + wa.height - h - 8);
    notesWindow.setBounds({
      x: Math.max(wa.x, wa.x + wa.width - SIDEBAR_W - 8 - w - 12),
      y: y,
      width: w,
      height: h,
    });
  }
  if (weekWindow && !weekWindow.isDestroyed()) {
    weekWindow.setBounds({
      x: wa.x + 8,
      y: wa.y + 8,
      width: wa.width - 16,
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
      height: 64,
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
      if (buttonWindow && !buttonWindow.isDestroyed() && buttonWindow.isVisible()) buttonWindow.hide();
      if (statusWindow && !statusWindow.isDestroyed() && statusWindow.isVisible()) statusWindow.hide();
      if (sleeping && petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) petWindow.hide();
    } else if (!focusSessionActive) {
      // Week mode hides the planner + status bar BY DESIGN (the week strip
      // owns the screen) — the self-heal must not pop them back up over it.
      // Conversely, if a stray pet/status is still up in week mode (a wake
      // landing mid-transition), hide it — the strip owns the screen.
      // The launcher button IS shown in week mode (bottom-right), so its
      // restore below runs unconditionally.
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
          statusWindow.show();
          relayoutWindows();
        }
      }
      // The launcher button must always be on screen unless the app is asleep,
      // peeking, or unsummoned by a focus session (week mode shows it too,
      // parked bottom-right). Self-heal if it went missing (a hide that never
      // got restored, or a stale placement that left it off-screen).
      if (buttonWindow && !buttonWindow.isDestroyed() &&
          (!buttonWindow.isVisible() || !isOnScreen(buttonWindow.getBounds()))) {
        dlog('launcher button missing — restoring');
        positionButtonWindow();
        buttonWindow.show();
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
    app.setAppUserModelId('com.ezcompanion.EZCompanion');
    // Record the startup environment in the debug log: where the log lives
    // and every display the OS reports (id / label / size / position), so
    // summon behavior can be diagnosed straight from the file.
    dlog('app ready — userData:', app.getPath('userData'));
    dlog('displays:', screen.getAllDisplays().map((d) => `${d.id}:${d.label || '?'}:${d.size.width}x${d.size.height}@${d.bounds.x},${d.bounds.y}`).join(' | '));
    clipboardHistory = loadClipboardHistory();
    createPetWindow();
    createStatusWindow();
    createButtonWindow();
    createScreenshotOverlay(anchorDisplay());
    startClipboardWatcher();
    createTray();
    // Re-apply the layout after creation (safe even if a display changed
    // between the windows being built) and keep it in sync with any display
    // configuration change while the app runs.
    relayoutWindows();
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
    // Belt & braces on Windows: PowerShell key watchers poll the raw key state
    // (Ctrl+Shift+S sleep/wake + Alt+C peek + Ctrl+Shift+Alt+S next screen),
    // so they still fire if another app owns the hotkey or the OS-level
    // registration failed. The debounces in toggleSleep / setPeek absorb any
    // duplicate between the paths.
    if (process.platform === 'win32') {
      startShiftSKeyWatcher();
      startAltCWatcher();
      startCycleKeyWatcher();
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
  if (deadlineAlertWindow) { deadlineAlertWindow.close(); deadlineAlertWindow = null; }
  if (buttonWindow) { buttonWindow.close(); buttonWindow = null; }
  if (weekWindow) { weekWindow.close(); weekWindow = null; }
  if (focusBarWindow) { focusBarWindow.close(); focusBarWindow = null; }
  if (hoverCardWindow) { hoverCardWindow.close(); hoverCardWindow = null; }
});

app.on('window-all-closed', () => {
  app.quit();
});

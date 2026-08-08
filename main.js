const { app, BrowserWindow, screen, ipcMain, globalShortcut, desktopCapturer, clipboard, nativeImage, Tray, Menu } = require('electron');

const WOLF_DEBUG = !!process.env.WOLF_DEBUG;
function dlog(...args) { if (WOLF_DEBUG) console.log('[wolf-debug]', ...args); }
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
let cursorPollInterval = null;
let buttonPollInterval = null;
let mouseIgnored = true;

// Layout: the pet is a slim always-visible sidebar pinned below the status
// pill in the top-right corner. The planner (deadlines + daily tasks) fills
// the whole window. The floating launcher button lives in its own tiny
// window in the top-LEFT corner of the screen.
const SIDEBAR_W = 430;
const SIDEBAR_TOP = 58;

// Clipboard history state
let clipboardHistory = [];             // [{text, time}]
let lastClipboardText = '';
let lastWrittenText = null;
const MAX_HISTORY = 30;

const clipboardHistoryFile = () => path.join(app.getPath('userData'), 'clipboard-history.json');

// === Pet Window (always-visible planner sidebar) ===
function createPetWindow() {
  const wa = screen.getPrimaryDisplay().workArea;

  petWindow = new BrowserWindow({
    width: SIDEBAR_W,
    // Full-height planner: the glass stretches from just under the status
    // bar down to near the bottom of the work area (a touch longer than the
    // old layout). Small screens fall back to a 480px minimum.
    height: Math.max(480, wa.height - 50),
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
  const wa = screen.getPrimaryDisplay().workArea;

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
  statusWindow.on('closed', () => { statusWindow = null; });
}

// === Floating launcher button window (top-left corner of the screen) ===
// A tiny transparent window holding the app's "menu" button. Hovering the
// button opens the radial ring menu (the app's feature menu);
// the ring closes when the cursor leaves the window. Click-through except
// over the button (or the open ring), so it never blocks clicks aimed at
// whatever sits behind it in the corner.
const BTN_SIZE = 230;
const BTN_CENTER = BTN_SIZE / 2;   // the button sits dead-centre of the window
// Hover-arm: the cursor must rest on the button for this long before the
// ring menu opens (the renderer draws a filling progress arc + countdown).
const BTN_ARM_MS = 2500;
let buttonArm = { start: 0, progress: 0, armed: false };

function createButtonWindow() {
  if (buttonWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  // Parked flush against the left edge of the planner sidebar (8px gap). The
  // ring menu (174px, centred in this window) then opens without ever
  // overlapping the planner. Clamped so a very narrow display can't push the
  // window off-screen.
  const btnX = Math.max(wa.x, wa.x + wa.width - SIDEBAR_W - 8 - 8 - BTN_SIZE);

  buttonWindow = new BrowserWindow({
    width: BTN_SIZE,
    height: BTN_SIZE,
    x: btnX,
    y: wa.y + 16,
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
  // every segment receives clicks, until the cursor leaves the window.
  if (buttonPollInterval) clearInterval(buttonPollInterval);
  buttonPollInterval = setInterval(() => {
    if (!buttonWindow || buttonWindow.isDestroyed()) return;
    const now = Date.now();
    const pos = screen.getCursorScreenPoint();
    const b = buttonWindow.getBounds();
    const inWindow = pos.x >= b.x - 4 && pos.x <= b.x + b.width + 4 && pos.y >= b.y - 4 && pos.y <= b.y + b.height + 4;
    // Hover-able button pad: a generous circle around the window centre.
    const inButton = Math.hypot(pos.x - (b.x + BTN_CENTER), pos.y - (b.y + BTN_CENTER)) <= 56;
    // Latch: once the cursor has rested on the button, keep the window
    // interactive until the cursor leaves — no click-through hiccup while
    // sliding from the button onto a ring segment.
    if (inButton) buttonLatched = true;
    else if (!inWindow) buttonLatched = false;

    // Hover-arm: resting on the button fills a progress bar over BTN_ARM_MS;
    // when full the renderer opens the ring. The armed flag survives the
    // cursor sliding from the button onto a ring segment (it only resets when
    // the cursor leaves the window or the ring is closed by an action).
    if (inButton) {
      if (!buttonArm.start) buttonArm.start = now;
      buttonArm.progress = Math.min(1, (now - buttonArm.start) / BTN_ARM_MS);
      if (buttonArm.progress >= 1) buttonArm.armed = true;
    } else if (!buttonArm.armed) {
      buttonArm.start = 0;
      buttonArm.progress = 0;
    }
    if (!inWindow) {
      buttonArm.start = 0;
      buttonArm.progress = 0;
      buttonArm.armed = false;
      buttonLatched = false;
    }

    const over = buttonLatched || (buttonRingOpen && inWindow);
    buttonWindow.setIgnoreMouseEvents(!over, { forward: true });
    // The renderer draws the progress arc, opens the ring when armed, and
    // closes it only once the cursor leaves the whole window.
    buttonWindow.webContents.send('button-hover', {
      active: inButton,
      inWindow,
      progress: buttonArm.progress,
      armed: buttonArm.armed,
    });
  }, 90);
}

ipcMain.on('button-ring-open', (_e, open) => {
  buttonRingOpen = !!open;
  // Ring closed by an action while the cursor is still in the window: reset
  // the arm so hovering the button again needs the full hold (no instant
  // re-open).
  if (!open) {
    buttonArm.start = 0;
    buttonArm.progress = 0;
    buttonArm.armed = false;
  }
});

// === Quick Notes window (floats to the LEFT of the sidebar, ~half height) ===
const NOTES_W = 340;
let notesWindow = null;
let notesHideForCapture = false; // suppress blur-close while the screenshot hides us
let notesHiddenBySleep = false; // notes were open when the app slept — restore on wake

function createNotesWindow() {
  if (notesWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const sideH = Math.max(480, wa.height - SIDEBAR_TOP - 10); // same as the pet window
  notesWindow = new BrowserWindow({
    width: NOTES_W,
    // Roughly half the sidebar's height — a big card, not a full-length bar.
    height: Math.max(280, Math.round(sideH / 2)),
    // Right edge sits just left of the sidebar; clamped to the screen on
    // narrow displays.
    x: Math.max(wa.x, wa.x + wa.width - SIDEBAR_W - 8 - NOTES_W - 12),
    y: wa.y + SIDEBAR_TOP, // top-aligned with the sidebar
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
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.hide();
    // Keep the sidebar renderer in sync even while hidden (e.g. so the week
    // view-switch button reads active if the sidebar is ever shown again).
    sendToPet('set-mode', { view: 'week' });
  } else {
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.show();
    sendToPet('set-mode', { view: mode });
  }
}

// Restore the active mode's windows (used after sleep / peek / capture).
function restoreModeWindows() {
  if (activeMode === 'week') {
    createWeekWindow();
    if (weekWindow && !weekWindow.isDestroyed()) weekWindow.show();
  } else {
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
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
  const wa = screen.getPrimaryDisplay().workArea;
  weekWindow = new BrowserWindow({
    width: wa.width - 16,
    // Tall enough for each day column to show its whole plan (~a third of
    // the screen's height, like the calendar; past days cross everything out
    // so the columns need room to breathe).
    height: Math.min(430, Math.max(280, Math.round(wa.height * 0.32))),
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
  const b = screen.getPrimaryDisplay().bounds;
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

function toggleSleep() {
  const now = Date.now();
  if (now - lastSleepToggle < 400) return;
  lastSleepToggle = now;
  applySleep(!sleeping);
}

function applySleep(value) {
  sleeping = !!value;
  dlog('sleep:', sleeping);
  sendToPet('set-sleeping', { value: sleeping });
  if (sleeping) {
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
    if (buttonWindow && !buttonWindow.isDestroyed()) buttonWindow.hide();
    if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
    // Hide (not close) an open notes popup so it comes back in the same spot
    // with its content intact when the app is summoned again.
    if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) {
      notesHiddenBySleep = true;
      notesWindow.hide();
    }
    if (deadlineAlertWindow && !deadlineAlertWindow.isDestroyed() && deadlineAlertWindow.isVisible()) closeDeadlineAlert();
    closeScreenshotOverlay(); // don't leave the capture overlay up over a hidden app
    setMouseIgnored(true);
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
  }
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
  } else if (!sleeping) {
    restoreModeWindows();
    // Notes hidden by a sleep cycle come back once the peek ends.
    if (notesHiddenBySleep) {
      notesHiddenBySleep = false;
      if (!notesWindow || notesWindow.isDestroyed()) createNotesWindow();
      if (notesWindow && !notesWindow.isDestroyed()) { notesWindow.show(); notesWindow.focus(); }
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

// Ctrl+Shift+S → sleep/wake; Alt+C → peek. Created in whenReady; the debounce
// in toggleSleep / setPeek absorbs any duplicate with the global shortcut.
function startShiftSKeyWatcher() {
  if (!shiftSKeyWatcher) shiftSKeyWatcher = startKeyWatcher('Ctrl+Shift+S', [17, 16, 83], () => toggleSleep(), () => {});
}
function startAltCWatcher() {
  if (!altCKeyWatcher) altCKeyWatcher = startKeyWatcher('Alt+C', [18, 67], () => setPeek(true), () => setPeek(false), () => setPeek(false));
}
function stopShiftSKeyWatcher() {
  if (shiftSKeyWatcher) { shiftSKeyWatcher.stop(); shiftSKeyWatcher = null; }
}
function stopAltCWatcher() {
  if (altCKeyWatcher) { altCKeyWatcher.stop(); altCKeyWatcher = null; }
  if (peekActive) setPeek(false);
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
  dlog('bounds update:', JSON.stringify(bounds));
});

// Open an app panel from the floating launcher button window. The three view
// modes are handled here (only one is on screen at a time); everything else
// (info/clipboard/notes/settings) is forwarded to the sidebar renderer.
ipcMain.on('open-panel', (_e, action) => {
  if (action === 'tasks' || action === 'calendar' || action === 'week') {
    setAppMode(action);
    return;
  }
  if (action && typeof action === 'string') sendToPet('open-panel', { action });
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
  if (weekWindow && !weekWindow.isDestroyed() && weekWindow.isVisible()) weekWindow.hide();
  if (petWindow && !petWindow.isDestroyed()) petWindow.show();
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
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
  pushClipboardItem(clean);
  return true;
});

ipcMain.handle('get-clipboard-history', () => clipboardHistory);

ipcMain.on('delete-clipboard-item', (event, text) => {
  clipboardHistory = clipboardHistory.filter(i => i.text !== text);
  saveClipboardHistory();
  broadcastClipboardHistory();
});

ipcMain.on('clear-clipboard-history', () => {
  clipboardHistory = [];
  saveClipboardHistory();
  broadcastClipboardHistory();
});

// === Clipboard history manager (polls the OS clipboard) ===
function loadClipboardHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(clipboardHistoryFile(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
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

function pushClipboardItem(text) {
  if (!text || typeof text !== 'string') return;
  if (clipboardHistory[0] && clipboardHistory[0].text === text) return; // already newest
  clipboardHistory = clipboardHistory.filter(i => i.text !== text);
  clipboardHistory.unshift({ text, time: Date.now() });
  if (clipboardHistory.length > MAX_HISTORY) clipboardHistory = clipboardHistory.slice(0, MAX_HISTORY);
  saveClipboardHistory();
  broadcastClipboardHistory();
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
      pushClipboardItem(t);
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Planner', click: () => {
      // Wake first if asleep (the renderer stays faded otherwise).
      if (sleeping) applySleep(false);
      // Route through the mode system so the week strip can't linger
      // alongside the sidebar (one mode at a time).
      setAppMode(activeMode === 'week' ? 'tasks' : activeMode);
      if (petWindow && !petWindow.isDestroyed()) petWindow.focus();
    } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
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
    clipboardHistory = loadClipboardHistory();
    createPetWindow();
    createStatusWindow();
    createButtonWindow();
    createScreenshotOverlay(screen.getPrimaryDisplay());
    startClipboardWatcher();
    createTray();
    // System-wide Ctrl+Shift+S = sleep/wake (hide the app from the screen,
    // then summon it back). Registered AFTER the windows exist so the
    // fallback (before-input-event on each window) is already in place.
    // The combo is consumed at the OS level whenever this succeeds.
    const shortcutOk = globalShortcut.register('CommandOrControl+Shift+S', toggleSleep);
    dlog('global shortcut Ctrl+Shift+S:', shortcutOk ? 'registered' : 'FAILED — falling back to key watcher');
    // Belt & braces on Windows: PowerShell key watchers poll the raw key state
    // (Ctrl+Shift+S sleep/wake + Alt+C peek), so they still fire if another
    // app owns the hotkey or the OS-level registration failed. The debounces
    // in toggleSleep / setPeek absorb any duplicate between the paths.
    if (process.platform === 'win32') {
      startShiftSKeyWatcher();
      startAltCWatcher();
    }
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopShiftSKeyWatcher();
  stopAltCWatcher();
  stopPolling();
  if (tray) { tray.destroy(); tray = null; }
  saveClipboardHistory();
  if (screenshotOverlay) { screenshotOverlay.close(); screenshotOverlay = null; }
  if (notesWindow) { notesWindow.close(); notesWindow = null; }
  if (deadlineAlertWindow) { deadlineAlertWindow.close(); deadlineAlertWindow = null; }
  if (buttonWindow) { buttonWindow.close(); buttonWindow = null; }
  if (weekWindow) { weekWindow.close(); weekWindow = null; }
});

app.on('window-all-closed', () => {
  app.quit();
});

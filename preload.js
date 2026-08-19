const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Screen info
  getCursorPosition: () => ipcRenderer.invoke('get-cursor-position'),

  // Screenshot overlay
  openScreenshotOverlay: () => ipcRenderer.send('open-screenshot-overlay'),
  captureScreenshotAndClose: (region) => ipcRenderer.send('capture-screenshot-close', region),
  cancelScreenshot: () => ipcRenderer.send('cancel-screenshot'),
  captureScreenshot: (region) => ipcRenderer.invoke('capture-screenshot', region),

  // Click-through toggle
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),

  // Send interactive element bounds to main for cursor polling
  updateInteractiveBounds: (bounds) => ipcRenderer.send('update-interactive-bounds', bounds),

  // Always on top
  setAlwaysOnTop: (value) => ipcRenderer.send('set-always-on-top', value),

  // Quick Notes popup window (floats left of the sidebar)
  openNotesPanel: () => ipcRenderer.send('open-notes'),
  closeNotes: () => ipcRenderer.send('notes-close'),

  // Hover card (detailed task/deadline preview to the LEFT of the planner)
  showHoverCard: (payload) => ipcRenderer.send('hover-card-show', payload),
  hideHoverCard: () => ipcRenderer.send('hover-card-hide'),
  onHoverCardData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('hover-card-data', handler);
    return () => ipcRenderer.removeListener('hover-card-data', handler);
  },

  // Full-screen deadline alert (shown when a deadline comes due; the alert
  // window itself receives the deadline via onDeadlineAlertData)
  showDeadlineAlert: (dl) => ipcRenderer.send('deadline-alert-show', dl),
  ackDeadlineAlert: (id) => ipcRenderer.send('deadline-alert-ack', id),
  onDeadlineAlertData: (callback) => {
    const handler = (event, dl) => callback(dl);
    ipcRenderer.on('deadline-alert-data', handler);
    return () => ipcRenderer.removeListener('deadline-alert-data', handler);
  },
  onDeadlineAlertAcked: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('deadline-alert-acked', handler);
    return () => ipcRenderer.removeListener('deadline-alert-acked', handler);
  },

  // Open an app panel from the floating launcher button window
  openPanel: (action) => ipcRenderer.send('open-panel', action),
  onOpenPanel: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('open-panel', handler);
    return () => ipcRenderer.removeListener('open-panel', handler);
  },

  // App views: 'tasks' (default) | 'calendar' | 'week' (only one at a time)
  setMode: (mode) => ipcRenderer.send('set-mode', mode),
  onSetMode: (callback) => {
    const handler = (event, view) => callback(view);
    ipcRenderer.on('set-mode', handler);
    return () => ipcRenderer.removeListener('set-mode', handler);
  },
  // Jump the calendar view to a specific day (sent when a week day is clicked)
  onSelectDay: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('select-day', handler);
    return () => ipcRenderer.removeListener('select-day', handler);
  },

  // Week strip window (week.html)
  updateWeekBounds: (bounds) => ipcRenderer.send('week-update-bounds', bounds),
  weekDayClick: (key) => ipcRenderer.send('week-select-day', key),

  // Sleep / wake (Ctrl+Shift+S: hide the app from the screen, summon it back)
  toggleSleep: () => ipcRenderer.send('toggle-sleep'),
  onSetSleeping: (callback) => {
    const handler = (event, state) => callback(state);
    ipcRenderer.on('set-sleeping', handler);
    return () => ipcRenderer.removeListener('set-sleeping', handler);
  },

  // Alt+C peek: dim the app so you can see & click right through it
  onAltDim: (callback) => {
    const handler = (event, state) => callback(state);
    ipcRenderer.on('alt-dim', handler);
    return () => ipcRenderer.removeListener('alt-dim', handler);
  },

  // Focus session: while a timer runs, the planner unsummons into a slim
  // focus bar (focusbar.html). The planner renderer streams the session
  // state here; main shows/hides the bar and relays bar button commands.
  setFocusSession: (state) => ipcRenderer.send('focus-session', state),
  onFocusBarState: (callback) => {
    const handler = (event, state) => callback(state);
    ipcRenderer.on('focus-bar-state', handler);
    return () => ipcRenderer.removeListener('focus-bar-state', handler);
  },
  focusBarCmd: (action) => ipcRenderer.send('focus-bar-cmd', action),
  onFocusBarCmd: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('focus-bar-cmd', handler);
    return () => ipcRenderer.removeListener('focus-bar-cmd', handler);
  },

  // Floating launcher button window
  onButtonHover: (callback) => {
    const handler = (event, state) => callback(state);
    ipcRenderer.on('button-hover', handler);
    return () => ipcRenderer.removeListener('button-hover', handler);
  },

  // Assistant window + chat
  openAssistant: () => ipcRenderer.send('open-assistant'),
  closeAssistant: () => ipcRenderer.send('assistant-close'),

  // Info window (clock / weather / quote)
  openInfo: () => ipcRenderer.send('open-info'),
  closeInfo: () => ipcRenderer.send('info-close'),
  // "Full view" from the assistant: open the whole workspace on one screen.
  fullView: () => ipcRenderer.send('full-view'),

  // Daily-stats page (today's progress dashboard)
  openStats: () => ipcRenderer.send('open-stats'),
  closeStats: () => ipcRenderer.send('stats-close'),
  // The planner renderer pushes fresh data to the stats window whenever it
  // changes, so the dashboard updates live instead of polling stale storage.
  sendStats: (payload) => ipcRenderer.send('stats-update', payload),
  onStatsData: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('stats-data', handler);
    return () => ipcRenderer.removeListener('stats-data', handler);
  },
  // The stats window asks the planner renderer (data owner) for the current
  // snapshot on load so it doesn't have to wait for the next change.
  requestStats: () => ipcRenderer.send('stats-request'),
  onStatsRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('stats-request', handler);
    return () => ipcRenderer.removeListener('stats-request', handler);
  },
  sendAssistantMessage: (text) => ipcRenderer.send('assistant-message', text),
  onAssistantReply: (callback) => {
    const handler = (event, reply) => callback(reply);
    ipcRenderer.on('assistant-reply', handler);
    return () => ipcRenderer.removeListener('assistant-reply', handler);
  },
  // The planner renderer answers assistant messages (it owns the data).
  onAssistantMessage: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('assistant-message', handler);
    return () => ipcRenderer.removeListener('assistant-message', handler);
  },
  sendAssistantReply: (reply) => ipcRenderer.send('assistant-reply', reply),
  // Online/offline mode sync (toggle lives in the floating assistant window).
  setAssistantMode: (mode) => ipcRenderer.send('assistant-set-mode', mode),
  onAssistantSetMode: (callback) => {
    const handler = (event, data) => callback(data && data.mode);
    ipcRenderer.on('assistant-set-mode', handler);
    return () => ipcRenderer.removeListener('assistant-set-mode', handler);
  },
  onAssistantGetMode: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('assistant-get-mode', handler);
    return () => ipcRenderer.removeListener('assistant-get-mode', handler);
  },
  exportData: (json) => ipcRenderer.invoke('export-data', json),
  resolveConflict: (id) => ipcRenderer.send('conflict-resolve', id),
  onConflictResolve: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('conflict-resolve', handler);
    return () => ipcRenderer.removeListener('conflict-resolve', handler);
  },
  sendAssistantMode: (mode) => ipcRenderer.send('assistant-mode-state', mode),
  onAssistantMode: (callback) => {
    const handler = (event, mode) => callback(mode);
    ipcRenderer.on('assistant-mode-state', handler);
    return () => ipcRenderer.removeListener('assistant-mode-state', handler);
  },
  // Daily-protocol accent sync (the planner renderer owns the choice and
  // broadcasts it so assistant/notes/info/stats/week match its color).
  sendProtocol: (protocol) => ipcRenderer.send('protocol-state', protocol),
  onProtocol: (callback) => {
    const handler = (event, protocol) => callback(protocol);
    ipcRenderer.on('protocol-state', handler);
    return () => ipcRenderer.removeListener('protocol-state', handler);
  },
  getProtocol: () => ipcRenderer.send('protocol-get'),
  onProtocolGet: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('protocol-get', handler);
    return () => ipcRenderer.removeListener('protocol-get', handler);
  },
  // Centered startup window (boot.html): click through → main closes it and
  // tells the planner to continue (show the daily protocol picker).
  bootContinue: () => ipcRenderer.send('boot-continue'),
  onBootDone: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('boot-done', handler);
    return () => ipcRenderer.removeListener('boot-done', handler);
  },

  // Smooth card summon: main tells a card window it's being shown/hidden so
  // the renderer can replay its entrance/exit animation (see summon.js).
  onSummonAnimate: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('summon-animate', handler);
    return () => ipcRenderer.removeListener('summon-animate', handler);
  },
  onSummonLeave: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('summon-leave', handler);
    return () => ipcRenderer.removeListener('summon-leave', handler);
  },
  summonLeaveDone: () => ipcRenderer.send('summon-leave-done'),

  // Clipboard history
  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),
  onClipboardHistory: (callback) => {
    const handler = (event, items) => callback(items);
    ipcRenderer.on('clipboard-history', handler);
    return () => ipcRenderer.removeListener('clipboard-history', handler);
  },
  deleteClipboardItem: (key) => ipcRenderer.send('delete-clipboard-item', key),
  clearClipboardHistory: () => ipcRenderer.send('clear-clipboard-history'),
  getClipboardImage: (hash) => ipcRenderer.invoke('get-clipboard-image', hash),
  writeClipboardImage: (hash) => ipcRenderer.invoke('write-clipboard-image', hash),

  // Listeners
  onWindowBlurred: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window-blurred', handler);
    return () => ipcRenderer.removeListener('window-blurred', handler);
  },
  onScreenshotDone: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('screenshot-done', handler);
    return () => ipcRenderer.removeListener('screenshot-done', handler);
  },

  // Clipboard CRUD
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),

  // Remove all listeners for a channel
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});

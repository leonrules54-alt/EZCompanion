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
  setRingOpen: (open) => ipcRenderer.send('button-ring-open', !!open),

  // Assistant window + chat
  openAssistant: () => ipcRenderer.send('open-assistant'),
  closeAssistant: () => ipcRenderer.send('assistant-close'),
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

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

  // Floating launcher button window
  onButtonHover: (callback) => {
    const handler = (event, state) => callback(state);
    ipcRenderer.on('button-hover', handler);
    return () => ipcRenderer.removeListener('button-hover', handler);
  },
  setRingOpen: (open) => ipcRenderer.send('button-ring-open', !!open),

  // Clipboard history
  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),
  onClipboardHistory: (callback) => {
    const handler = (event, items) => callback(items);
    ipcRenderer.on('clipboard-history', handler);
    return () => ipcRenderer.removeListener('clipboard-history', handler);
  },
  deleteClipboardItem: (text) => ipcRenderer.send('delete-clipboard-item', text),
  clearClipboardHistory: () => ipcRenderer.send('clear-clipboard-history'),

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

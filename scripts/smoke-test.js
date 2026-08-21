// Boot smoke test: launches the real app in an isolated profile and watches
// EVERY window's renderer for uncaught exceptions / console errors via CDP.
// Usage: node scripts/smoke-test.js
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = 9361;
const root = path.join(__dirname, '..');
const electronPath = require(path.join(root, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let proc = null;
let failures = 0;
const check = (label, cond, extra) => {
  if (cond) console.log('  ✔', label);
  else { failures += 1; console.log('  ✘', label, extra !== undefined ? JSON.stringify(extra) : ''); }
};

(async () => {
  const tmpProfile = path.join(require('os').tmpdir(), 'wolf-smoke-' + Date.now());
  proc = spawn(electronPath, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpProfile, '.', '--disable-gpu'], {
    cwd: root, env: { ...process.env, HALO_DEBUG: '1' }, stdio: 'ignore',
  });

  // Wait for the app (pet window = app.html) to be up.
  let targets = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { targets = await getJson(`http://127.0.0.1:${PORT}/json/list`); } catch (e) { /* not up */ }
    if (targets.some((t) => t.url.includes('app.html'))) break;
    await sleep(300);
  }
  check('app booted (app.html present)', targets.some((t) => t.url.includes('app.html')), targets.map((t) => t.url));
  if (!targets.some((t) => t.url.includes('app.html'))) throw new Error('app never came up');

  // Connect to every page target, enable Runtime + Log, and collect errors
  // for a few seconds while the app settles (boot card, status, etc).
  const errors = new Map(); // url -> [messages]
  const conns = [];
  for (const t of targets.filter((x) => x.type === 'page')) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    let id = 0;
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const msg = (d.exception && d.exception.description) || d.text || 'unknown';
        const url = t.url.split('/').pop() || t.url;
        if (!errors.has(url)) errors.set(url, []);
        errors.get(url).push('EXCEPTION: ' + msg.split('\n')[0]);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        const url = t.url.split('/').pop() || t.url;
        if (!errors.has(url)) errors.set(url, []);
        errors.get(url).push('LOG: ' + String(m.params.entry.text).split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        const url = t.url.split('/').pop() || t.url;
        const txt = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
        if (!errors.has(url)) errors.set(url, []);
        errors.get(url).push('CONSOLE: ' + txt.split('\n')[0]);
      }
    };
    send('Runtime.enable');
    send('Log.enable');
    conns.push(ws);
  }

  // Give every window time to boot + run its init code.
  await sleep(4000);

  // === Open every lazy window so all renderers get error-checked ===
  const petTarget = targets.find((t) => t.url.includes('app.html'));
  const petWs = new WebSocket(petTarget.webSocketDebuggerUrl);
  await new Promise((res) => { petWs.onopen = res; });
  let pid = 0;
  const sendPet = (method, params = {}) => new Promise((resolve) => {
    const myId = ++pid;
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { petWs.removeEventListener('message', h); resolve(m.result); } };
    petWs.addEventListener('message', h);
    petWs.send(JSON.stringify({ id: myId, method, params }));
  });
  await sendPet('Runtime.enable');
  // Wait until the pet renderer is actually loaded (its globals exist).
  for (let i = 0; i < 30; i++) {
    const ready = await sendPet('Runtime.evaluate', { expression: 'typeof assistantAnswer === "function"', returnByValue: true });
    if (ready && ready.result && ready.result.value) break;
    await sleep(300);
  }
  // Click through the boot card (main.js gates assistant/info/stats/notes on
  // `booting`, which only clears after the user clicks the Jarvis card).
  for (let i = 0; i < 15; i++) {
    let list = [];
    try { list = await getJson(`http://127.0.0.1:${PORT}/json/list`); } catch (e) {}
    const boot = list.find((t) => t.url.includes('boot.html'));
    if (boot) {
      const bws = new WebSocket(boot.webSocketDebuggerUrl);
      await new Promise((res) => { bws.onopen = res; });
      let bid = 0;
      const bsend = (method, params = {}) => new Promise((resolve) => {
        const myId = ++bid;
        const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { bws.removeEventListener('message', h); resolve(m.result); } };
        bws.addEventListener('message', h);
        bws.send(JSON.stringify({ id: myId, method, params }));
      });
      await bsend('Runtime.enable');
      await bsend('Runtime.evaluate', { expression: 'document.body.click()', returnByValue: true });
      bws.close();
      break;
    }
    await sleep(500);
  }
  await sleep(1500); // let boot close + chrome restore
  // Open every standalone window through the real IPC surface. Notes is
  // closed again before the hover card is shown (main refuses to stack the
  // hover card on top of notes), and the screenshot overlay is cancelled
  // right after it opens.
  const r1 = await sendPet('Runtime.evaluate', { expression: `(function () {
    const e = window.electronAPI;
    const out = {};
    out.assistant = !!(e && e.openAssistant); try { e.openAssistant(); } catch (err) { out.assistantErr = String(err); }
    out.notes = !!(e && e.openNotesPanel); try { e.openNotesPanel(); } catch (err) { out.notesErr = String(err); }
    out.info = !!(e && e.openInfo); try { e.openInfo(); } catch (err) { out.infoErr = String(err); }
    out.stats = !!(e && e.openStats); try { e.openStats(); } catch (err) { out.statsErr = String(err); }
    out.setMode = !!(e && e.setMode); try { e.setMode('week'); } catch (err) { out.setModeErr = String(err); }
    out.focus = typeof startFocus === 'function'; try { startFocus(); } catch (err) { out.focusErr = String(err); }
    return out;
  })()`, returnByValue: true });
  console.log('open-windows eval:', JSON.stringify(r1));
  await sleep(1500);
  const r2 = await sendPet('Runtime.evaluate', { expression: `(function () {
    const e = window.electronAPI;
    const out = {};
    out.closeNotes = !!(e && e.closeNotes); try { if (e.closeNotes) e.closeNotes(); } catch (err) { out.closeNotesErr = String(err); }
    out.hover = !!(e && e.showHoverCard); try { if (e.showHoverCard) e.showHoverCard({ name: 'smoke test task', due: '2026-08-24', time: '', category: '', progressMin: 0, durationMin: 30 }); } catch (err) { out.hoverErr = String(err); }
    out.overlay = !!(e && e.openScreenshotOverlay); try { if (e.openScreenshotOverlay) e.openScreenshotOverlay(); } catch (err) { out.overlayErr = String(err); }
    return out;
  })()`, returnByValue: true });
  console.log('close-hover-overlay eval:', JSON.stringify(r2));

  // New page targets (notes/info/stats/assistant/week/focusbar) appear now —
  // hook error listeners onto every target, including ones that show up
  // while we wait.
  for (let i = 0; i < 10; i++) {
    let list = [];
    try { list = await getJson(`http://127.0.0.1:${PORT}/json/list`); } catch (e) {}
    for (const t of list.filter((x) => x.type === 'page')) {
      if ([...conns].some((ws) => ws.url === t.webSocketDebuggerUrl)) continue;
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
      ws.url = t.webSocketDebuggerUrl;
      let nid = 0;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        const url = t.url.split('/').pop() || t.url;
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          const msg = (d.exception && d.exception.description) || d.text || 'unknown';
          if (!errors.has(url)) errors.set(url, []);
          errors.get(url).push('EXCEPTION: ' + msg.split('\n')[0]);
        }
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
          if (!errors.has(url)) errors.set(url, []);
          errors.get(url).push('LOG: ' + String(m.params.entry.text).split('\n')[0]);
        }
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          const txt = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
          if (!errors.has(url)) errors.set(url, []);
          errors.get(url).push('CONSOLE: ' + txt.split('\n')[0]);
        }
      };
      ws.send(JSON.stringify({ id: ++nid, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({ id: ++nid, method: 'Log.enable' }));
      conns.push(ws);
    }
    await sleep(800);
  }

  // Give every window time to run its init code after opening.
  await sleep(3000);

  let total = 0;
  for (const [url, list] of errors) { total += list.length; }
  check('no renderer errors across windows', total === 0, Object.fromEntries(errors));

  // Confirm the lazy windows actually opened (so the error check above is
  // not vacuous).
  let finalTargets = [];
  try { finalTargets = await getJson(`http://127.0.0.1:${PORT}/json/list`); } catch (e) {}
  const urls = finalTargets.filter((t) => t.type === 'page').map((t) => t.url.split('/').pop());
  for (const want of ['app.html', 'status.html', 'assistant.html', 'notes.html', 'info.html', 'stats.html', 'week.html', 'focusbar.html', 'hover-card.html', 'overlay-screenshot.html']) {
    check('window opened: ' + want, urls.includes(want), urls);
  }

  // Also verify the pet renderer's core globals are alive (assistant + memory).
  const r = await sendPet('Runtime.evaluate', {
    expression: `(function () {
      return {
        assistant: typeof assistantAnswer === 'function',
        parser: typeof assistantExtractClassDefs === 'function',
        tasks: typeof renderTasks === 'function',
        memory: typeof rememberClass === 'function',
        classes: JSON.parse(localStorage.getItem('wolf-memory') || '{}').classes || [],
      };
    })()`,
    returnByValue: true,
  });
  const v = r && r.result ? r.result.value : null;
  check('core globals alive', !!(v && v.assistant && v.parser && v.tasks && v.memory), v);
  check('memory classes array present', !!(v && Array.isArray(v.classes)), v);

  for (const ws of conns) { try { ws.close(); } catch (e) {} }
  try { petWs.close(); } catch (e) {}

  console.log(failures ? '\n✗ ' + failures + ' FAILURES' : '\n✓ all smoke checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error('FAILED:', e.message || e); process.exitCode = 1; })
  .finally(() => { if (proc) { proc.kill(); setTimeout(() => proc.kill('SIGKILL'), 1000); } });

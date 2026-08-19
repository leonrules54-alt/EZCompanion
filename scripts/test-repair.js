// Verifies the on-load id repair: seed the exact broken state the AI produced
// (duplicate class/category ids, tasks pointed at a shared id), reload the
// page so init() runs the repair on the real load path, and confirm classes
// survive, ids become unique, and tasks re-tag to the right class. Uses an
// isolated profile — never touches real data.
// Usage: node scripts/test-repair.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const electronPath = require(path.join(root, 'node_modules', 'electron'));
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function waitForTarget(port, urlPart, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const hit = list.find((t) => t.type === 'page' && t.url.includes(urlPart));
      if (hit) return hit;
    } catch (e) { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('target not found: ' + urlPart);
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, (m) => resolve(m.result || m.error));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 5000) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => null),
    ]);
    return r && r.result ? r.result.value : null;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

let proc = null;
(async () => {
  const profile = path.join(os.tmpdir(), 'wolf-repair-' + Date.now());
  proc = spawn(electronPath, ['--remote-debugging-port=9350', '--user-data-dir=' + profile, '.', '--disable-gpu'], {
    cwd: root, env: { ...process.env, WOLF_DEBUG: '1' }, stdio: 'ignore',
  });
  const target = await waitForTarget(9350, 'app.html');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  for (let i = 0; i < 30; i++) {
    if ((await c.eval('typeof rememberClass === "function"')) === true) break;
    await sleep(300);
  }

  const broken = { classes: [
    { id: 1787028195369, name: 'HAMLIT', days: [], time: '' },
    { id: 1787028195369, name: 'RUSH', days: [], time: '' },
    { id: 1787028195370, name: 'Calc BC', days: [], time: '' },
    { id: 1787028195370, name: 'AP Bio', days: [], time: '' },
    { id: 1787028195370, name: 'Intro to Engineering', days: [], time: '' },
  ], facts: [] };
  const cats = [
    { id: 'school', name: 'School', color: '#60a5fa' },
    { id: 'cat-1787028195369', name: 'HAMLIT', color: '#22d3ee' },
    { id: 'cat-1787028195369', name: 'RUSH', color: '#f97316' },
    { id: 'cat-1787028195370', name: 'Calc BC', color: '#60a5fa' },
    { id: 'cat-1787028195370', name: 'AP Bio', color: '#34d399' },
    { id: 'cat-1787028195370', name: 'Intro to Engineering', color: '#f472b6' },
  ];
  const tasks = [
    { id: 1, name: 'RUSH: Migration Map', category: 'cat-1787028195370', durationMin: 0, due: '2026-08-20', done: false, progressMin: 0, recur: '' },
    { id: 2, name: 'HAMLIT: Reading', category: 'cat-1787028195369', durationMin: 0, due: '2026-08-18', done: false, progressMin: 0, recur: '' },
  ];

  // Seed the broken state, then reload so init() runs the repair on load.
  await c.eval(`(function () {
    localStorage.setItem('wolf-memory', ${JSON.stringify(JSON.stringify(broken))});
    localStorage.setItem('wolf-categories', ${JSON.stringify(JSON.stringify(cats))});
    localStorage.setItem('wolf-tasks', ${JSON.stringify(JSON.stringify(tasks))});
    return true;
  })()`);
  await c.send('Page.reload');
  await sleep(2500);
  for (let i = 0; i < 20; i++) {
    if ((await c.eval('typeof rememberClass === "function"')) === true) break;
    await sleep(300);
  }

  const state = await c.eval(`(function () {
    try {
      const m = JSON.parse(localStorage.getItem('wolf-memory') || 'null');
      const c = JSON.parse(localStorage.getItem('wolf-categories') || '[]');
      const t = JSON.parse(localStorage.getItem('wolf-tasks') || '[]');
      return JSON.stringify({
        classNames: (m && m.classes || []).map((x) => x.name),
        classIdsUnique: new Set((m && m.classes || []).map((x) => x.id)).size === (m && m.classes || []).length,
        catIdsUnique: new Set(c.map((x) => x.id)).size === c.length,
        cats: c.map((x) => x.id + '=' + x.name),
        tasks: t.map((x) => x.name + '->' + (c.find((cc) => cc.id === x.category) || { name: '?' }).name),
      });
    } catch (e) { return 'ERR: ' + String((e && e.stack) || e); }
  })()`);
  console.log(state);
  const parsed = JSON.parse(state);
  const ok =
    parsed.classNames.includes('RUSH') && parsed.classNames.includes('Calc BC') &&
    parsed.classNames.includes('AP Bio') && parsed.classNames.includes('Intro to Engineering') &&
    parsed.classIdsUnique && parsed.catIdsUnique &&
    parsed.tasks.some((x) => x.startsWith('RUSH: Migration Map->RUSH')) &&
    parsed.tasks.some((x) => x.startsWith('HAMLIT: Reading->HAMLIT'));
  console.log(ok ? '\n✅ REPAIR OK — classes kept, ids unique, tasks re-tagged correctly' : '\n❌ REPAIR FAILED');
  c.close();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exitCode = 1; })
  .finally(() => { if (proc) { proc.kill(); setTimeout(() => proc.kill('SIGKILL'), 1000); } });

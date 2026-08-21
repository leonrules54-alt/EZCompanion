// One-time restore: the buggy id-repair write (fixed now) had saved an empty
// classes list, dropping the user's remembered classes. The class names were
// recovered from a read taken before that write. Re-adds them through the
// app's own rememberClass (which also skips categories that already exist).
// Idempotent: existing classes are never touched.
// Usage: node scripts/restore-classes.js
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9352;
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
async function waitForTarget(urlPart, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
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
  async eval(expression, timeoutMs = 4000) {
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
  proc = spawn(electronPath, ['--remote-debugging-port=' + PORT, '.', '--disable-gpu'], {
    cwd: root, env: { ...process.env, HALO_DEBUG: '1' }, stdio: 'ignore',
  });
  const target = await waitForTarget('app.html');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  for (let i = 0; i < 30; i++) {
    if ((await c.eval('typeof rememberClass === "function"')) === true) break;
    await sleep(300);
  }
  const out = await c.eval(`(function () {
    const names = ['HAMLIT', 'RUSH', 'Calc BC', 'AP Bio', 'Intro to Engineering'];
    const added = [];
    names.forEach((n) => {
      if (!assistantMemory.classes.some((x) => x.name.toLowerCase() === n.toLowerCase())) {
        rememberClass(n, [], '');
        added.push(n);
      }
    });
    return JSON.stringify({
      added,
      classes: assistantMemory.classes.map((x) => x.name),
      categories: categories.map((x) => x.name),
    });
  })()`);
  console.log(out);
  await sleep(1000); // let the write flush before the app is killed
  c.close();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exitCode = 1; })
  .finally(() => { if (proc) { proc.kill(); setTimeout(() => proc.kill('SIGKILL'), 1000); } });

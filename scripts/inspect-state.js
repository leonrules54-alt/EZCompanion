// Read-only inspection of the real app's memory/categories/tasks (no writes).
// Usage: node scripts/inspect-state.js
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9344;
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
    cwd: root, env: { ...process.env, WOLF_DEBUG: '1' }, stdio: 'ignore',
  });
  const petTarget = await waitForTarget('app.html');
  const pet = await CDP.connect(petTarget.webSocketDebuggerUrl);
  await pet.send('Runtime.enable');
  for (let i = 0; i < 30; i++) {
    const ready = await pet.eval('typeof window.assistantMemory !== "undefined" || document.readyState === "complete"');
    if (ready === true) break;
    await sleep(300);
  }
  const state = await pet.eval(`(function () {
    const g = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return 'ERR'; } };
    return {
      memory: g('wolf-memory'),
      categories: g('wolf-categories'),
      tasks: g('wolf-tasks'),
      deadlines: g('wolf-deadlines'),
      settings: g('wolf-settings'),
    };
  })()`);
  console.log(JSON.stringify(state, null, 2));
  pet.close();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exitCode = 1; })
  .finally(() => { if (proc) { proc.kill(); setTimeout(() => proc.kill('SIGKILL'), 1000); } });

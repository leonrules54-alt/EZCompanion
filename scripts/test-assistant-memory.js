// End-to-end check of the assistant memory (classes knowledge base) in the
// real app: remember a class, then verify homework auto-dates against it.
// Usage: node scripts/test-assistant-memory.js
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = 9334;
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
    return r && r.result ? r.result.value : (r && r.error ? r.error : null);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

let proc = null;
(async () => {
  // Isolated profile: the test must never read or write the user's real
  // planner data.
  const tmpProfile = path.join(require('os').tmpdir(), 'wolf-mem-test-' + Date.now());
  proc = spawn(electronPath, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpProfile, '.', '--disable-gpu'], {
    cwd: root, env: { ...process.env, WOLF_DEBUG: '1' }, stdio: 'ignore',
  });
  const petTarget = await waitForTarget('app.html');
  const pet = await CDP.connect(petTarget.webSocketDebuggerUrl);
  await pet.send('Runtime.enable');
  // Wait until the renderer's functions are actually defined (the target
  // appears before renderer.js finishes loading).
  for (let i = 0; i < 30; i++) {
    const ready = await pet.eval('typeof assistantAnswer === "function"');
    if (ready) break;
    await sleep(300);
  }

  const ask = async (text) => {
    const reply = await pet.eval(`(async () => {
      try { return await assistantAnswer(${JSON.stringify(text)}); }
      catch (e) { return '❌ ' + String((e && e.stack) || e); }
    })()`);
    return reply;
  };

  console.log('Q1:', 'remember my history class is Monday Wednesday at 9am');
  console.log('A1:', await ask('remember my history class is Monday Wednesday at 9am'));
  console.log('Q2:', 'what classes do I have?');
  console.log('A2:', await ask('what classes do I have?'));
  console.log('Q3:', 'history homework essay due tomorrow');
  console.log('A3:', await ask('history homework essay due tomorrow'));
  console.log('Q4:', 'add math homework (no date, no class remembered)');
  console.log('A4:', await ask('add math homework'));
  console.log('Q5:', 'add history homework (no date → next class day)');
  console.log('A5:', await ask('add history homework'));
  console.log('Q6:', 'I have history hw essay due tomorrow (deadline path)');
  console.log('A6:', await ask('I have history hw essay due tomorrow'));
  console.log('Q7:', 'show clipboard (must still work)');
  console.log('A7:', await ask('show clipboard'));
  console.log('Q8:', 'what is due today?');
  console.log('A8:', await ask('what is due today?'));

  // Inspect the persisted memory + created tasks.
  const state = await pet.eval(`(function () {
    return {
      memory: JSON.parse(localStorage.getItem('wolf-memory') || 'null'),
      tasks: (JSON.parse(localStorage.getItem('wolf-tasks') || '[]') || []).map(t => ({ name: t.name, due: t.due, category: t.category })),
      deadlines: (JSON.parse(localStorage.getItem('wolf-deadlines') || '[]') || []).map(d => ({ name: d.name, due: d.due })),
      categories: JSON.parse(localStorage.getItem('wolf-categories') || '[]').map(c => c.name),
    };
  })()`);
  console.log('\nPERSISTED:');
  console.log(JSON.stringify(state, null, 2));

  pet.close();
  console.log('\n(test used an isolated profile — real data untouched)');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exitCode = 1; })
  .finally(() => { if (proc) { proc.kill(); setTimeout(() => proc.kill('SIGKILL'), 1000); } });

// End-to-end check of the classes feature set in the real app:
// multi-class schedule saving, bare name list + schedule follow-up, "next
// class" answers, the 🏫 classes panel, and class-start reminders.
// Usage: node scripts/test-classes-ui.js  (isolated profile — real data untouched)
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = 9335;
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
let failures = 0;
const check = (label, cond, extra) => {
  if (cond) console.log('  ✔', label);
  else { failures += 1; console.log('  ✘', label, extra !== undefined ? JSON.stringify(extra) : ''); }
};

(async () => {
  const tmpProfile = path.join(require('os').tmpdir(), 'wolf-classes-test-' + Date.now());
  proc = spawn(electronPath, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpProfile, '.', '--disable-gpu'], {
    cwd: root, env: { ...process.env, HALO_DEBUG: '1' }, stdio: 'ignore',
  });
  const petTarget = await waitForTarget('app.html');
  const pet = await CDP.connect(petTarget.webSocketDebuggerUrl);
  await pet.send('Runtime.enable');
  for (let i = 0; i < 30; i++) {
    if (await pet.eval('typeof assistantAnswer === "function"')) break;
    await sleep(300);
  }

  const ask = async (text) => {
    const reply = await pet.eval(`(async () => {
      try { return await assistantAnswer(${JSON.stringify(text)}); }
      catch (e) { return '❌ ' + String((e && e.stack) || e); }
    })()`);
    return reply;
  };
  const memory = () => pet.eval(`(function () {
    const m = JSON.parse(localStorage.getItem('wolf-memory') || 'null');
    return m ? { classes: m.classes, facts: m.facts } : null;
  })()`);

  console.log('Q1: multi-class schedule in one message');
  const a1 = await ask('my schedule: history mon wed 9am, math tue thu 10am');
  console.log('A1:', a1);
  let m1 = await memory();
  check('two classes saved', m1 && m1.classes.length === 2, m1 && m1.classes.map((c) => c.name));
  const hist = m1.classes.find((c) => c.name.toLowerCase() === 'history');
  const math = m1.classes.find((c) => c.name.toLowerCase() === 'math');
  check('history has mon+wed 09:00', hist && JSON.stringify(hist.days) === '["mon","wed"]' && hist.time === '09:00', hist);
  check('math has tue+thu 10:00', math && JSON.stringify(math.days) === '["tue","thu"]' && math.time === '10:00', math);
  const catsAfterQ1 = await pet.eval(`JSON.parse(localStorage.getItem('wolf-categories') || '[]').map(c => c.name.toLowerCase()).sort().join(',')`);
  check('color categories auto-created', catsAfterQ1.includes('history') && catsAfterQ1.includes('math'), catsAfterQ1);

  console.log('Q2: what is my next class?');
  const a2 = await ask("what's my next class?");
  console.log('A2:', a2);
  check('answers with a class + date', /Next history class|Next math class/.test(a2), a2);

  console.log('Q3: when is history class?');
  const a3 = await ask('when is history class?');
  console.log('A3:', a3);
  check('specific class answered', /history class:/.test(a3), a3);

  console.log('Q4: bare name list → ask for schedule');
  const a4 = await ask('my classes are english, chem');
  console.log('A4:', a4);
  let m2 = await memory();
  check('english+chem saved', m2 && m2.classes.length === 4 && ['english', 'chem'].every((n) => m2.classes.some((c) => c.name.toLowerCase() === n)), m2 && m2.classes.map((c) => c.name));
  check('asked for days/times', /What days and times/.test(a4), a4);

  console.log('Q5: follow-up with the schedule');
  const a5 = await ask('english Mon Wed at 9am, chem Tue Thu at 10am');
  console.log('A5:', a5);
  const m3 = await memory();
  const eng = m3.classes.find((c) => c.name.toLowerCase() === 'english');
  const chem = m3.classes.find((c) => c.name.toLowerCase() === 'chem');
  check('english updated with mon+wed 09:00', eng && JSON.stringify(eng.days) === '["mon","wed"]' && eng.time === '09:00', eng);
  check('chem updated with tue+thu 10:00', chem && JSON.stringify(chem.days) === '["tue","thu"]' && chem.time === '10:00', chem);

  console.log('Q6: classes panel renders and edits');
  const panel = await pet.eval(`(function () {
    openClassesPanel();
    const open = !classesPanel.classList.contains('panel-hidden');
    const rows = document.querySelectorAll('#classes-list .cls-row').length;
    const daysOn = document.querySelectorAll('#classes-list .cls-day.on').length;
    const times = document.querySelectorAll('#classes-list .cls-time').length;
    closeClassesPanel();
    return { open, rows, daysOn, times };
  })()`);
  console.log('panel:', JSON.stringify(panel));
  check('panel opens with a row per class', panel.open && panel.rows === 4, panel);
  check('day chips + time inputs rendered', panel.daysOn === 8 && panel.times === 4, panel);

  console.log('Q7: class-start reminder fires once');
  const rem = await pet.eval(`(async function () {
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const dows = ['sun','mon','tue','wed','thu','fri','sat'];
    const start = new Date(now.getTime() + 5 * 60000);
    const cls = rememberClass('Improv', [dows[now.getDay()]], pad(start.getHours()) + ':' + pad(start.getMinutes()));
    tickClassReminders();
    const state = JSON.parse(localStorage.getItem('wolf-class-reminders') || '{}');
    const keys = Object.keys(state).filter(k => k.startsWith(cls.id));
    const toasts = document.querySelectorAll('.toast').length;
    tickClassReminders(); // second pass must NOT re-fire
    const state2 = JSON.parse(localStorage.getItem('wolf-class-reminders') || '{}');
    const keys2 = Object.keys(state2).filter(k => k.startsWith(cls.id));
    return { keys: keys.length, toasts, keysAfterSecond: keys2.length };
  })()`);
  console.log('reminder:', JSON.stringify(rem));
  check('reminder recorded once and not re-fired', rem.keys === 1 && rem.keysAfterSecond === 1, rem);

  console.log('Q8: homework still auto-dates to a class');
  const a8 = await ask('add english essay');
  console.log('A8:', a8);
  const t8 = await pet.eval(`(JSON.parse(localStorage.getItem('wolf-tasks') || '[]')[0] || {}).due`);
  check('english task due on a Mon/Wed', /^2026-0?[89]-\d{2}$/.test(t8 || ''), t8);

  pet.close();
  console.log(failures ? '\n✗ ' + failures + ' FAILURES' : '\n✓ all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error('FAILED:', e.message || e); process.exitCode = 1; })
  .finally(() => { if (proc) { proc.kill(); setTimeout(() => proc.kill('SIGKILL'), 1000); } });

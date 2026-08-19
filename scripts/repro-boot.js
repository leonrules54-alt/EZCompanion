// Boot/wake regression check. Drives the real app over the Chrome DevTools
// Protocol and verifies:
//  1. Launch: Jarvis appears once, and clicking through brings the planner up.
//  2. Wake: NO Jarvis — the planner comes straight back (it used to replay
//     the boot card on every wake, and the extra click-through was where the
//     planner could go missing while the status bar came back).
// Usage: node scripts/repro-boot.js
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 9333;
const root = path.join(__dirname, '..');
const electronPath = require(path.join(root, 'node_modules', 'electron'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
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
    } catch (e) { /* app not up yet */ }
    await sleep(300);
  }
  throw new Error('target not found: ' + urlPart + ' — targets: ' + JSON.stringify(await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
      else if (m.method) c.events.push(m);
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
  // Resolves null on timeout instead of hanging forever — the boot window
  // CLOSES mid-eval when the click lands, killing the WebSocket before the
  // response arrives.
  async eval(expression, timeoutMs = 2500) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => null),
    ]);
    return r && r.result ? r.result.value : (r && r.error ? r.error : null);
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) { fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return true; }
    return false;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

let proc = null;
async function main() {
  proc = spawn(electronPath, ['--remote-debugging-port=' + PORT, '.', '--disable-gpu'], {
    cwd: root, env: { ...process.env, WOLF_DEBUG: '1' }, stdio: 'ignore',
  });
  console.log('app pid:', proc.pid, '...');

  const petTarget = await waitForTarget('app.html');
  console.log('pet target:', petTarget.title, petTarget.url);
  await sleep(600);

  const out = (label, o) => console.log(label, JSON.stringify(o));

  // -- state snapshot helper (evaluated inside the pet renderer) --
  const SNAP = `(function(){
    var glass = document.querySelector('.tasks-panel-glass');
    var modal = document.getElementById('protocol-modal');
    var tp = document.getElementById('tasks-panel');
    return {
      cls: document.body.className,
      vis: document.visibilityState,
      glassOp: glass ? getComputedStyle(glass).opacity : null,
      glassDisplay: glass ? getComputedStyle(glass).display : null,
      panelHidden: tp ? tp.classList.contains('panel-hidden') : null,
      protocolOpen: modal ? modal.classList.contains('open') : null,
      hasElectron: !!window.electronAPI,
      w: window.innerWidth, h: window.innerHeight,
    };
  })()`;

  const pet = await CDP.connect(petTarget.webSocketDebuggerUrl);
  await pet.send('Runtime.enable');
  await pet.send('Page.enable');

  // Re-discover the boot window every cycle: it is CLOSED on continue and
  // re-created on the next wake, so the old WebSocket is dead after cycle 1.
  async function connectBoot() {
    const t = await waitForTarget('boot.html');
    const c = await CDP.connect(t.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    return c;
  }

  out('state@start', await pet.eval(SNAP));
  await pet.screenshot('build/repro-start.png');

  // === CYCLE 1: launch boot → click continue → planner should appear ===
  console.log('\n--- cycle 1: launch boot -> continue ---');
  let boot = await connectBoot();
  await sleep(3900); // boot scan animation (~3.3s until clicks are allowed)
  await boot.eval('document.body.click(); true'); // fire & forget — closes the window
  await sleep(1600);
  out('after-continue-1', await pet.eval(SNAP));
  await pet.screenshot('build/repro-after-continue-1.png');
  await sleep(3000); // watchdog window (3s)
  out('after-continue-1+3s', await pet.eval(SNAP));
  await pet.screenshot('build/repro-after-continue-1-3s.png');

  // === CYCLE 2: sleep → wake → planner must come back DIRECTLY ===
  // (Jarvis only plays on app launch now — waking must not show the boot
  // window at all, which is what used to race the planner's show().)
  console.log('--- cycle 2: sleep -> wake (no jarvis) ---');
  await pet.eval('window.electronAPI.toggleSleep(); true');
  await sleep(1400);
  out('after-sleep', await pet.eval(SNAP)); // hiddden window → vis:hidden, sleeping-all
  await pet.eval('window.electronAPI.toggleSleep(); true');
  await sleep(1600);
  const bootAfterWake = await waitForTarget('boot.html', 2500).catch(() => null);
  out('boot-window-after-wake', bootAfterWake ? 'PRESENT (bug!)' : 'absent (correct)');
  out('after-wake', await pet.eval(SNAP));
  await pet.screenshot('build/repro-after-wake.png');
  await sleep(3000); // watchdog
  out('after-wake+3s', await pet.eval(SNAP));

  // === CYCLES 3..6: repeat sleep/wake a few times to shake out races ===
  for (let i = 3; i <= 6; i++) {
    console.log('--- cycle', i, '---');
    await pet.eval('window.electronAPI.toggleSleep(); true');
    await sleep(900);
    await pet.eval('window.electronAPI.toggleSleep(); true');
    await sleep(1600);
    out('after-wake-' + i, await pet.eval(SNAP));
    await pet.screenshot('build/repro-after-wake-' + i + '.png');
    await sleep(2500);
    out('after-wake-' + i + '+2.5s', await pet.eval(SNAP));
  }

  // console errors captured on the pet page
  await sleep(200);
  const errs = pet.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes((e.params || {}).type)));
  console.log('pet errors/warnings:', errs.map((e) => e.method + (e.params && e.params.type ? ':' + e.params.type : '')).join(',') || 'none');
  pet.close(); if (boot) boot.close();
}

main().catch((e) => { console.error('REPRO FAILED:', e.message || e); process.exitCode = 1; })
  .finally(() => {
    if (proc) { proc.kill(); setTimeout(() => proc.kill('SIGKILL'), 1000); }
  });

/**
 * Runs the page's own jitter test in headless Chrome and prints the result.
 *
 * Point it at a page that is cross-origin isolated (the atomics ticker) and at
 * one that is not (the setTimeout fallback) to compare the two, which is the
 * measurement CLAUDE.md listed as missing: every jitter figure in
 * docs/DEVELOPMENT.md was the atomics backend.
 *
 *   node tools/jitter-headless.mjs <url-of-/web> [seconds=60] [out.json]
 *
 * Headless has no display, so this is a floor for the machine, not what a
 * pilot's focused window gets (the real run beat the headless one on every
 * statistic in M0). Compare backends on the same machine, same run length.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TO_RUN = process.argv[2] ?? 'http://localhost:5180/web';
const SECONDS = Number(process.argv[3] ?? 60);
const OUT = process.argv[4];
const PORT = 9222 + Math.floor(Math.random() * 500);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'fpvsim-jit-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' });
const done = (code) => {
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
};

let ws;
let nextId = 1;
const pending = new Map();
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

try {
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(100); }
  }
  ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: URL_TO_RUN }, sessionId);
  await sleep(3000);
  const env = await evaluate(`({ isolated: crossOriginIsolated, backend: document.documentElement.dataset.ticker ?? '?' })`);
  console.log(`${URL_TO_RUN}: isolated ${env.isolated}, ticker ${env.backend}; running ${SECONDS} s`);
  await evaluate(`(() => {
    const d = document.getElementById('jitter-duration'); d.value = '${SECONDS}';
    document.getElementById('jitter-start').click();
  })()`);
  await sleep(SECONDS * 1000 + 3000);
  for (let i = 0; i < 40; i++) {
    const t = await evaluate(`document.getElementById('jitter-progress').textContent`);
    if (t === 'done') break;
    await sleep(500);
  }
  // The results table: one row per series, columns as statRow writes them.
  const rows = await evaluate(`[...document.querySelectorAll('#jitter-results tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()))`);
  const head = ['series', 'count', 'mean', 'sd', 'min', 'p50', 'p90', 'p99', 'p99.9', 'max'];
  const series = rows.filter((r) => r.length === head.length && r[0] !== 'series' && !/^count$/i.test(r[1]));
  const text = await evaluate(`document.getElementById('jitter-results').innerText`);
  const stalls = text.match(/stall[^\n]*/gi) ?? [];
  console.log(head.join('\t'));
  for (const r of series) console.log(r.join('\t'));
  for (const s of stalls) console.log(s);
  if (OUT) writeFileSync(OUT, JSON.stringify({ url: URL_TO_RUN, seconds: SECONDS, ...env, head, series, summary: text }, null, 2));
  done(series.length ? 0 : 1);
} catch (e) {
  console.error(e);
  done(1);
}

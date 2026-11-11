/**
 * Checks the NacoSim-for-your-radio page (at /rc) of a running server: the page loads
 * with no unfilled placeholders, its download link serves a zip, the sha256
 * printed on the page is the sha256 of that file, and the zip holds the
 * scripts and nothing from the dev folders.
 *
 *   node tools/rc-check.mjs [base-url]      (default http://localhost:5180)
 * Also checks the front page and the sim's address: / is the front page, /web the
 * sim, /rc this page.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:5180').replace(/\/$/, '');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const page = await fetch(`${base}/rc`);
const html = await page.text();
check('page loads at /rc', page.ok && html.includes('NacoSim'), `HTTP ${page.status}`);
const ctype = page.headers.get('content-type') ?? '';
check('/rc is served as html, not the sim page', ctype.includes('html') && html.includes('NacoSim for your radio') && !html.includes('id="tab-fly"'), ctype);
for (const alt of ['/rc/', '/rc.html']) {
  const r = await fetch(base + alt);
  const t = await r.text();
  check(`${alt} also serves it`, r.ok && t === html);
}
const shots = [...html.matchAll(/src="(\/nacosim\/[^"]+\.svg)"/g)].map((m) => m[1]);
check('page shows screenshots', shots.length >= 9, `${shots.length} images`);
for (const src of shots) {
  const r = await fetch(base + src);
  const body = await r.text();
  check(`image ${src}`, r.ok && (r.headers.get('content-type') ?? '').includes('svg') && body.includes('<svg'));
}
check('no unfilled placeholders', !html.includes('{{'));

const href = /href="(\/downloads\/NacoSim-[^"]+\.zip)"/.exec(html)?.[1];
check('page links a zip', Boolean(href), href ?? 'none');
const shaOnPage = /\b([0-9a-f]{64})\b/.exec(html)?.[1];
check('page shows a sha256', Boolean(shaOnPage));

if (href) {
  const res = await fetch(base + href);
  const buf = Buffer.from(await res.arrayBuffer());
  check('zip downloads', res.ok && buf.length > 1000, `${buf.length} bytes`);
  check('served as a zip', (res.headers.get('content-type') ?? '').includes('zip'), res.headers.get('content-type') ?? '');
  check('sha256 on the page is the file served', createHash('sha256').update(buf).digest('hex') === shaOnPage);

  const dir = mkdtempSync(join(tmpdir(), 'rc-check-'));
  const file = join(dir, 'x.zip');
  writeFileSync(file, buf);
  const names = execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter(Boolean);
  check('zip has the tool script', names.includes('SCRIPTS/TOOLS/NacoSim.lua'));
  check('zip has the memory check', names.includes('SCRIPTS/TOOLS/NacoMem.lua'));
  check('zip has every module', ['model', 'course', 'view', 'display', 'settings'].every((m) => names.includes(`SCRIPTS/NacoSim/${m}.lua`)));
  check('zip carries the map files', names.some((n) => /^SCRIPTS\/NacoSim\/maps\/.+\.map$/.test(n)), names.filter((n) => n.endsWith('.map')).join(', ') || 'none');
  for (const entry of names.filter((n) => /^SCRIPTS\/NacoSim\/maps\/.+\.map$/.test(n))) {
    const title = /^name (.+)$/m.exec(execFileSync('unzip', ['-p', file, entry]).toString())?.[1]?.trim();
    check(`the page lists the track in ${entry.split('/').pop()}`, Boolean(title) && html.includes(title), title ?? 'no name line');
  }
  check('zip carries no dev probes or compiled copies', !names.some((n) => /Probe|Bisect|\.luac$/.test(n)), names.join(', '));

  const latest = await fetch(`${base}/downloads/NacoSim-latest.zip`);
  const lbuf = Buffer.from(await latest.arrayBuffer());
  check('NacoSim-latest.zip is the same file', latest.ok && createHash('sha256').update(lbuf).digest('hex') === shaOnPage);
}

// The three pages and how they link: front page (/), web sim (/web), radio (/rc).
const homeRes = await fetch(`${base}/`);
const home = await homeRes.text();
check('front page loads at /', homeRes.ok && home.includes('An FPV trainer you can fly anywhere'), `HTTP ${homeRes.status}`);
check('front page links to the web sim and the radio page', home.includes('href="/web"') && home.includes('href="/rc"'));
check('front page has the support card', home.includes('paypal.com/paypalme/nacofpv') && home.includes('Support the project'));
check('front page is not the sim', !home.includes('id="tab-fly"'));
const homeImgs = [...home.matchAll(/src="(\/nacosim\/[^"]+)"/g)].map((m) => m[1]);
check('front page shows the sim, the radio and its screens', ['web-sim.jpg', 'web-circle.jpg', 'web-180s.jpg', 'radio.svg', 'fly-gate.svg', 'colour-fly.svg'].every((n) => homeImgs.some((u) => u.endsWith(n))), `${homeImgs.length} images`);
for (const src of homeImgs) {
  const r = await fetch(base + src);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') ?? '';
  check(`front page image ${src}`, r.ok && buf.length > 500 && (ct.includes('svg') || ct.includes('jpeg')), `${ct}, ${buf.length} bytes`);
}
const webRes = await fetch(`${base}/web`);
const web = await webRes.text();
check('the web sim is at /web', webRes.ok && web.includes('id="tab-fly"'), `HTTP ${webRes.status}`);
for (const alt of ['/web/', '/web.html']) {
  const r = await fetch(base + alt);
  const t = await r.text();
  check(`${alt} also serves the sim`, r.ok && t === web);
}
check('the sim links back to the front page and to /rc', web.includes('href="/"') && web.includes('href="/rc"'));
check('the radio page links back to the front page and the sim', html.includes('href="/"') && html.includes('href="/web"'));
const cc = (await fetch(`${base}/web`)).headers.get('cache-control');
if (cc !== null) check('pages are not cached', /no-store|no-cache/.test(cc), cc);
const missing = await fetch(`${base}/no-such-page`);
// the production server answers 404; the Vite dev server falls back to the front page
if ((missing.headers.get('server') ?? '').includes('SimpleHTTP')) check('unknown paths are a 404', missing.status === 404, `HTTP ${missing.status}`);

console.log(failed === 0 ? '\nrc check passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

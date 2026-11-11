/**
 * Checks the NacoSim-for-your-radio page of a running server: the page loads
 * with no unfilled placeholders, its download link serves a zip, the sha256
 * printed on the page is the sha256 of that file, and the zip holds the
 * scripts and nothing from the dev folders.
 *
 *   node tools/rc-check.mjs [base-url]      (default http://localhost:5180)
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

const page = await fetch(`${base}/rc.html`);
const html = await page.text();
check('page loads', page.ok && html.includes('NacoSim'), `HTTP ${page.status}`);
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
  check('zip carries no dev probes or compiled copies', !names.some((n) => /Probe|Bisect|\.luac$/.test(n)), names.join(', '));

  const latest = await fetch(`${base}/downloads/NacoSim-latest.zip`);
  const lbuf = Buffer.from(await latest.arrayBuffer());
  check('NacoSim-latest.zip is the same file', latest.ok && createHash('sha256').update(lbuf).digest('hex') === shaOnPage);
}

const home = await (await fetch(`${base}/`)).text();
check('the sim page links to it', home.includes('href="/rc.html"'));

console.log(failed === 0 ? '\nrc check passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

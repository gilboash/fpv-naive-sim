import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { packKey, packRc, type MapInfo, type RcPack } from './tools/nacosim-pack.ts';

/**
 * A build stamp, so a session report can be tied to what was actually running.
 * Without it "a pilot reported X" is unanswerable a week later, because the
 * deployed bundle has moved on and nothing records which one they flew.
 *
 * Falls back to the date when git is unavailable — a tarball build should not
 * fail over a missing stamp.
 */
function buildId(): string {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim().length > 0;
    return `${day}-${sha}${dirty ? '+' : ''}`;
  } catch {
    return day;
  }
}

// What to say about each track, by file name; a track not listed here is
// described by its own file (name and counts). Counts always come from the file.
const TRACK_NOTES: Record<string, string> = {
  'race-vibes': "the sim's own track",
  macabim: 'the Velocidrone track <em>Macabim 2027 FRIL Race 2</em>, in a tight field',
  'mgp-q2024-1': 'a MultiGP 2024 qualifier track',
  'mgp-q2024-2': 'a MultiGP 2024 qualifier track',
  'mgp-q2024-3': 'a MultiGP 2024 qualifier track',
  'mgp-micro-2024': 'the 2024 MultiGP spring micro qualifier, a small field',
};
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The pages' track text, written from the maps that are actually in the zip. */
function trackText(maps: MapInfo[]): { list: string; names: string; bullet: string; mgpNote: string } {
  const items = [
    '<li><strong>Oval</strong> — a simple eight-gate loop to learn the sim on (built in).</li>',
    ...maps.map((m) => {
      const note = TRACK_NOTES[m.slug] ?? 'a track from a map file';
      const counts = m.flags > 0 ? `${plural(m.gates, 'gate')} and ${plural(m.flags, 'flag')}` : plural(m.gates, 'gate');
      return `<li><strong>${m.title}</strong> — ${note}: ${counts}.</li>`;
    }),
  ];
  const n = maps.length + 1;
  const hasMgp = maps.some((m) => m.slug.startsWith('mgp-'));
  const word = NUMBER_WORDS[n] ?? String(n);
  return {
    list: `<ul class="steps">\n          ${items.join('\n          ')}\n        </ul>`,
    names: ['Oval', ...maps.map((m) => m.title)].join(', '),
    bullet: `${word[0]!.toUpperCase()}${word.slice(1)} ${n === 1 ? 'track' : 'tracks'} to start with${hasMgp ? ', including MultiGP qualifier courses' : ''}.`,
    mgpNote: hasMgp
      ? ' On the MultiGP tracks the way each gate is flown and the side to pass each flag are worked out from the course layout, not read from the game, so a gate or flag may be the wrong way round compared with the real track: tell us if you see one.'
      : '',
  };
}

/**
 * The NacoSim-for-your-radio page (rc.html) and its download. The zip is built
 * from edgetx/ every time, so what is offered can never differ from what is in
 * the repository; the page text gets the version, size and checksum of that
 * exact file.
 *
 * Build: the zip is emitted into dist/downloads, once under its versioned name
 * and once as NacoSim-latest.zip. Dev: the same two URLs are answered from
 * memory.
 */
function nacosimRc(): Plugin {
  let memo: RcPack | null = null;
  const pack = (): RcPack => {
    const root = resolve(import.meta.dirname, 'edgetx');
    if (!memo || memo.key !== packKey(root)) memo = packRc(import.meta.dirname);
    return memo;
  };
  return {
    name: 'nacosim-rc',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string): string {
        if (!html.includes('{{')) return html;
        const p = pack();
        const t = trackText(p.maps);
        return html
          .replaceAll('{{TRACKS}}', t.list)
          .replaceAll('{{TRACK_NAMES}}', t.names)
          .replaceAll('{{TRACK_BULLET}}', t.bullet)
          .replaceAll('{{MGP_NOTE}}', t.mgpNote)
          .replaceAll('{{ZIP}}', p.name)
          .replaceAll('{{VERSION}}', p.version)
          .replaceAll('{{SIZE}}', `${Math.max(1, Math.round(p.data.length / 1024))} KB`)
          .replaceAll('{{SHA}}', p.sha256);
      },
    },
    configureServer(server) {
      // /rc and /web are addresses, rc.html and web.html the files, so /rc,
      // /rc/, /web and /web/ all serve them; otherwise the HTML fallback would
      // answer with the front page.
      server.middlewares.use((req, _res, next) => {
        const m = /^\/(rc|web)\/?(\?.*)?$/.exec(req.url ?? '');
        if (m) req.url = `/${m[1]}.html${m[2] ?? ''}`;
        next();
      });
      server.middlewares.use((req, res, next) => {
        const m = /^\/downloads\/(NacoSim-[^/?#]*\.zip)/.exec(req.url ?? '');
        if (!m) return next();
        const p = pack();
        if (m[1] !== p.name && m[1] !== 'NacoSim-latest.zip') return next();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', String(p.data.length));
        res.end(p.data);
      });
    },
    generateBundle() {
      const p = pack();
      this.emitFile({ type: 'asset', fileName: `downloads/${p.name}`, source: p.data });
      this.emitFile({ type: 'asset', fileName: 'downloads/NacoSim-latest.zip', source: p.data });
    },
  };
}

// COOP/COEP are set so SharedArrayBuffer / Atomics.wait are available.
// M0 uses them for a precise worker ticker; M1 needs them for the
// physics-thread SharedArrayBuffer. Getting the headers wrong later is a
// tedious debug, so they go in on day one.
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    /**
     * Vite answers only to localhost and bare IPs unless told otherwise, and
     * skips the check entirely over HTTPS. A tunnel reaches this server over
     * plain HTTP carrying the *public* hostname, which is none of those, so
     * every request comes back "Blocked request" — verified, not assumed.
     *
     * The leading dot matches subdomains, so a fresh random trycloudflare
     * hostname works without editing this each time. Set FPVSIM_ALLOWED_HOSTS
     * (comma separated) for a domain of your own. Deliberately not `true`:
     * Vite's own docs flag that as exposing DNS-rebinding, which is a small but
     * real thing to invite onto a home network.
     */
    allowedHosts: (process.env.FPVSIM_ALLOWED_HOSTS ?? '.trycloudflare.com')
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
  },
  define: { __FPVSIM_BUILD__: JSON.stringify(buildId()) },
  plugins: [nacosimRc()],
  build: {
    target: 'esnext',
    // Three pages: the front page (/), the web sim (/web) and the radio page (/rc).
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, 'index.html'),
        web: resolve(import.meta.dirname, 'web.html'),
        rc: resolve(import.meta.dirname, 'rc.html'),
      },
    },
  },
});

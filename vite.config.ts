import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { packKey, packRc, type RcPack } from './tools/nacosim-pack.ts';

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
        if (!html.includes('{{ZIP}}')) return html;
        const p = pack();
        return html
          .replaceAll('{{ZIP}}', p.name)
          .replaceAll('{{VERSION}}', p.version)
          .replaceAll('{{SIZE}}', `${Math.max(1, Math.round(p.data.length / 1024))} KB`)
          .replaceAll('{{SHA}}', p.sha256);
      },
    },
    configureServer(server) {
      // /rc is the page's address and rc.html the file, so /rc and /rc/ both
      // serve it; otherwise the sim's HTML fallback answers with index.html.
      server.middlewares.use((req, _res, next) => {
        const m = /^\/rc\/?(\?.*)?$/.exec(req.url ?? '');
        if (m) req.url = `/rc.html${m[1] ?? ''}`;
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
    // Two pages: the sim and the radio download page.
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), rc: resolve(import.meta.dirname, 'rc.html') } },
  },
});

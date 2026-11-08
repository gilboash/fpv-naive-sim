import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Tracks imported from Velocidrone (`npm run vd:import`), offered as maps by
 * the dev server and by nothing else.
 *
 * They are other people's work and kept out of git on Gilboa's call, so they
 * must not reach a deployment either. A glob import would not guarantee that:
 * Vite emits a chunk for every file a glob matches at build time whether or
 * not the code path that loads it can run, and the box is served by copying
 * `dist`. So this is a virtual module whose *build* answer is an empty list —
 * the data cannot be in a bundle because the build never reads it.
 */
function localTracks(command: 'serve' | 'build'): Plugin {
  const id = 'virtual:local-tracks';
  return {
    name: 'fpvsim-local-tracks',
    resolveId: (source) => (source === id ? '\0' + id : null),
    load(resolved) {
      if (resolved !== '\0' + id) return null;
      if (command !== 'serve') return 'export default [];';
      const dir = 'measurements/velocidrone';
      const slugs = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'track.json'))) : [];
      for (const d of slugs) this.addWatchFile(resolve(join(dir, d, 'track.json')));
      const all = slugs.map((d) => ({ ...JSON.parse(readFileSync(join(dir, d, 'track.json'), 'utf8')), slug: d }));
      return `export default ${JSON.stringify(all)};`;
    },
    /**
     * The course map (/vd-map.html) saves hand corrections here. Dev server
     * only — `configureServer` never runs in a build — and it writes one
     * field of one existing file, named by a slug that cannot leave the
     * directory.
     */
    configureServer(server) {
      server.middlewares.use('/__vd/overrides', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c.toString();
          if (body.length > 1e6) req.destroy();
        });
        req.on('end', () => {
          try {
            const { slug, overrides } = JSON.parse(body) as { slug: string; overrides: unknown };
            if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('bad slug');
            if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) throw new Error('bad overrides');
            const file = resolve('measurements/velocidrone', slug, 'track.json');
            if (!existsSync(file)) throw new Error('no such track');
            const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
            saved.overrides = overrides;
            writeFileSync(file, JSON.stringify(saved, null, 1));
            res.setHeader('content-type', 'application/json');
            res.end('{"ok":true}');
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
  };
}

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

// COOP/COEP are set so SharedArrayBuffer / Atomics.wait are available.
// M0 uses them for a precise worker ticker; M1 needs them for the
// physics-thread SharedArrayBuffer. Getting the headers wrong later is a
// tedious debug, so they go in on day one.
export default defineConfig(({ command }) => ({
  plugins: [localTracks(command)],
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
  build: { target: 'esnext' },
}));

import { defineConfig } from 'vite';

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
  build: { target: 'esnext' },
});

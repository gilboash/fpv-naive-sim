#!/usr/bin/env python3
"""
Serve the built fpvsim with the headers it needs. Standard library only.

Node is not installed on the Windows box and does not need to be: the whole
application is four static files and every byte of computation happens in the
visitor's browser. This exists instead of `vite preview` for that reason, and
because it does not gate on the Host header, which `vite preview` does and which
a tunnel trips over.

    python serve.py [--port 5180] [--root dist] [--host 127.0.0.1]

Defaults to 0.0.0.0 so the machine is reachable from the LAN, which is what you
want while testing from another device in the house. A Cloudflare tunnel does
not need that — it connects locally — so pass --host 127.0.0.1 once the tunnel
is the only way in and there is no reason to answer the rest of the network.
"""

import argparse
import http.server
import mimetypes
import os
import socketserver
import sys

# Explicit, because Python takes MIME types from the Windows registry and has
# been known to return text/plain for .js there. A module served as text/plain
# is refused by the browser and the page simply does not start — with nothing in
# the server log to suggest why.
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".map": "application/json; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return TYPES.get(ext, super().guess_type(path))

    def end_headers(self):
        # Cross-origin isolation, so the worker can allocate a SharedArrayBuffer
        # and the ticker runs on Atomics rather than falling back to a timer.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # The build is content-hashed, but index.html is not, so it must never
        # be cached or a redeploy is invisible to anyone who has visited before.
        if self.path in ("/", "/index.html"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stderr.flush()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5180)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--root", default="dist")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    index = os.path.join(root, "index.html")
    if not os.path.isfile(index):
        sys.stderr.write("no index.html under %s — run `npm run build` first\n" % root)
        return 2
    os.chdir(root)

    with Server((args.host, args.port), Handler) as httpd:
        sys.stderr.write(
            "fpvsim serving %s on http://%s:%d/ (COOP/COEP on)\n"
            % (root, args.host, args.port)
        )
        sys.stderr.flush()
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

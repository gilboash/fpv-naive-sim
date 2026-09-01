#!/usr/bin/env python3
"""
Serve the built fpvsim with the headers it needs. Standard library only.

Node is not installed on the Windows box and does not need to be: the whole
application is a handful of static files and every byte of computation happens in
visitor's browser. This exists instead of `vite preview` for that reason, and
because it does not gate on the Host header, which `vite preview` does and which
a tunnel trips over.

    python serve.py [--port 5180] [--root dist] [--host 127.0.0.1] [--data data]

It also accepts POSTs of usage summaries at /api/session and appends them to
data/sessions.jsonl. That is the only write this server does and the only method
besides GET and HEAD it answers; everything else is 404. Read the file with
tools/admin.py, which binds to localhost on another port so a tunnel pointed at
this one cannot reach it.

Defaults to 0.0.0.0 so the machine is reachable from the LAN, which is what you
want while testing from another device in the house. A Cloudflare tunnel does
not need that — it connects locally — so pass --host 127.0.0.1 once the tunnel
is the only way in and there is no reason to answer the rest of the network.
"""

import argparse
import datetime
import http.server
import json
import os
import posixpath
import socketserver
import sys
import threading
import urllib.parse

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
    ".mp4": "video/mp4",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        """Serve /reference/ from outside the build directory.

        The reference laps are videos, and they live beside `dist` rather than
        inside it for two reasons: `npm run build` empties dist, and they are
        generated artefacts that have no business in the repository. The page
        asks for them with preload="none", so a pilot who never presses play
        never fetches a byte — which is the whole point of not bundling them
        into an 80 KB page.
        """
        clean = urllib.parse.urlparse(path).path
        if REFERENCE_DIR and clean.startswith("/reference/"):
            rel = posixpath.normpath(urllib.parse.unquote(clean[len("/reference/"):]))
            # No traversal out of the directory: this is the one place the
            # server maps a URL onto a path of its own choosing.
            if rel.startswith("..") or rel.startswith("/") or os.path.isabs(rel):
                return ""
            return os.path.join(REFERENCE_DIR, rel)
        return super().translate_path(path)

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

    def do_POST(self):
        """The one write path: a session summary from the page.

        Deliberately narrow. Anyone who can reach the page can reach this, so it
        is one path, one method, a size cap and an append — not a general place
        to put bytes on the disk. Nothing here interprets the payload beyond
        checking that it is a JSON object; the reader is what has to treat every
        field as hostile, because a pilot chooses their own name.
        """
        if self.path.split("?")[0] != "/api/session":
            self.send_error(404, "not found")
            return
        if DATA_FILE is None:
            # Told not to collect. Say so rather than silently accepting and
            # dropping, which would look identical from the page.
            self.send_error(404, "collection disabled")
            return

        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self.send_error(415, "expected application/json")
            return
        try:
            length = int(self.headers.get("Content-Length") or "-1")
        except ValueError:
            length = -1
        # No Content-Length means a chunked body, which nothing here sends and
        # which would otherwise be an unbounded read.
        if length < 0:
            self.send_error(411, "length required")
            return
        if length > MAX_BODY:
            self.send_error(413, "too large")
            return

        raw = self.rfile.read(length)
        try:
            report = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, "not JSON")
            return
        if not isinstance(report, dict):
            self.send_error(400, "expected an object")
            return

        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        line = json.dumps({"receivedAt": now, "report": report}, separators=(",", ":"))
        # One lock and one write per line. This is a threading server, so two
        # concurrent pilots would otherwise be able to interleave halves of a
        # line and make the file unparseable from that point on.
        with WRITE_LOCK:
            with open(DATA_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


# Set in main(), before the server starts. None means collection is off.
DATA_FILE = None
# Where the reference-lap videos live, or "" for none.
REFERENCE_DIR = ""
WRITE_LOCK = threading.Lock()
MAX_BODY = 64 * 1024


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5180)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--root", default="dist")
    ap.add_argument(
        "--data",
        default="data",
        help="directory for sessions.jsonl; empty string turns collection off",
    )
    ap.add_argument(
        "--reference",
        default="reference",
        help="directory of reference-lap videos served at /reference/",
    )
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    index = os.path.join(root, "index.html")
    if not os.path.isfile(index):
        sys.stderr.write("no index.html under %s — run `npm run build` first\n" % root)
        return 2
    # Resolved before the chdir below, or --data would silently mean a
    # directory inside dist and be mirrored away by the next deploy.
    global DATA_FILE, REFERENCE_DIR
    if args.reference:
        REFERENCE_DIR = os.path.abspath(args.reference)
    if args.data:
        data_dir = os.path.abspath(args.data)
        os.makedirs(data_dir, exist_ok=True)
        DATA_FILE = os.path.join(data_dir, "sessions.jsonl")

    os.chdir(root)

    with Server((args.host, args.port), Handler) as httpd:
        sys.stderr.write(
            "fpvsim serving %s on http://%s:%d/ (COOP/COEP on), usage -> %s, reference -> %s\n"
            % (root, args.host, args.port, DATA_FILE or "off", REFERENCE_DIR or "off")
        )
        sys.stderr.flush()
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

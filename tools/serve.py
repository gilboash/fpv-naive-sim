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
data/sessions.jsonl, and it counts visits to the three pages and downloads of the
radio package in data/events.jsonl (see "Counting" below). Those are the only
writes this server does and the only method besides GET and HEAD it answers;
everything else is 404. Read the file with
tools/admin.py, which binds to localhost on another port so a tunnel pointed at
this one cannot reach it.

Defaults to 0.0.0.0 so the machine is reachable from the LAN, which is what you
want while testing from another device in the house. A Cloudflare tunnel does
not need that — it connects locally — so pass --host 127.0.0.1 once the tunnel
is the only way in and there is no reason to answer the rest of the network.
"""

import argparse
import datetime
import hashlib
import hmac
import http.server
import ipaddress
import json
import os
import posixpath
import re
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
    ".zip": "application/zip",
}

# ---- Counting -------------------------------------------------------------
#
# One JSON line per page visit or completed zip download, in data/events.jsonl,
# so the admin page (and anyone with the file) can say how many people came and
# how many took the radio package.
#
# What is kept, and what is not. The visitor is a salted one-way hash of the IP
# address (HMAC-SHA256 with a random secret in data/.salt, first 12 hex digits),
# so the same address is the same visitor on every day and a count of unique
# visitors is possible, but the address cannot be read back out of the file, and
# without .salt it cannot even be tested against a guess. The country is whatever
# Cloudflare says (CF-IPCountry). No address, no user agent, no referrer.
#
# Behind the tunnel the socket address is not the visitor's; Cloudflare puts the
# real one in CF-Connecting-IP, which is used when it is present and a valid
# address, and the socket address otherwise (a visit from the house network).
# The header can be forged by anyone who reaches the port directly. That is fine
# for counting; it is not an access control and nothing here treats it as one.
#
# Not counted: requests that come from the box itself with no Cloudflare header
# (the container's health check polls / every 30 s and would otherwise be most of
# the file), HEAD requests, and downloads that did not finish (the exception on a
# dropped connection skips the write). Counted but flagged "bot": crawlers,
# command-line tools and scripts, by user agent, so the page can leave them out.
PAGES = {
    "/": "home", "/index.html": "home",
    "/web": "web", "/web/": "web", "/web.html": "web",
    "/rc": "rc", "/rc/": "rc", "/rc.html": "rc",
}
BOT_UA = re.compile(
    r"bot|crawl|spider|slurp|curl|wget|python|httpclient|go-http|java/|headless|preview|"
    r"facebookexternalhit|monitor|uptime|node|undici|axios|okhttp|libwww|scrapy|postman|insomnia",
    re.I,
)
ZIP_VERSION = re.compile(r"^NacoSim-(\d+\.\d+\.\d+)\.zip$")
LOOPBACK = ("127.0.0.1", "::1")


def load_salt(data_dir: str) -> bytes:
    """The secret the visitor hashes are keyed with, created on first use."""
    path = os.path.join(data_dir, ".salt")
    try:
        with open(path, "r", encoding="ascii") as f:
            return bytes.fromhex(f.read().strip())
    except (FileNotFoundError, ValueError):
        pass
    salt = os.urandom(32)
    try:
        # "x": never overwrite a salt another worker created a moment ago.
        with open(path, "x", encoding="ascii") as f:
            f.write(salt.hex() + "\n")
    except FileExistsError:
        with open(path, "r", encoding="ascii") as f:
            return bytes.fromhex(f.read().strip())
    return salt


def visitor_id(ip: str) -> str:
    return hmac.new(SALT, ip.encode("ascii", "replace"), hashlib.sha256).hexdigest()[:12]


class _Limited:
    """A file read to the end of a byte range and no further. The stock handler
    copies whatever read() yields, so this is all a 206 needs."""

    def __init__(self, f, length):
        self._f, self._left = f, length

    def read(self, n=-1):
        if self._left <= 0:
            return b""
        n = self._left if n is None or n < 0 else min(n, self._left)
        data = self._f.read(n)
        self._left -= len(data)
        return data

    def close(self):
        self._f.close()


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
        p = super().translate_path(path)
        # Clean URLs: /rc (or /rc/) serves rc.html. Only when nothing by that
        # name exists, so a real file or directory always wins.
        if not os.path.exists(p):
            base = p.rstrip("/\\")
            if not os.path.splitext(base)[1] and os.path.isfile(base + ".html"):
                return base + ".html"
        return p

    def send_head(self):
        """Byte ranges (one range, as browsers ask for it). Safari and iPhones
        will not play a <video> from a server that cannot answer Range with 206,
        and every browser needs it to seek. Anything this cannot parse falls
        through to the stock handler and gets the whole file."""
        rng = (self.headers.get("Range") or "").strip()
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng)
        if not m or (not m.group(1) and not m.group(2)) or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        if not m.group(1):  # "-N": the last N bytes
            start, end = max(0, size - int(m.group(2))), size - 1
        else:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        end = min(end, size - 1)
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        return _Limited(f, end - start + 1)

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def do_GET(self):
        self._status = None
        super().do_GET()
        # Reached only if the whole response was written: a client that hangs up
        # mid-download raises out of the line above, so it is not counted.
        self._count()

    def _client_ip(self):
        """(address, came_through_cloudflare)."""
        header = self.headers.get("CF-Connecting-IP", "").strip()
        if header:
            try:
                return str(ipaddress.ip_address(header)), True
            except ValueError:
                pass
        return self.client_address[0], False

    def _count(self):
        if EVENTS_FILE is None or self._status != 200:
            return
        path = urllib.parse.urlparse(self.path).path
        if path in PAGES:
            kind, name, version = "page", PAGES[path], ""
        elif path.startswith("/downloads/") and path.endswith(".zip"):
            kind, name = "download", posixpath.basename(path)
            m = ZIP_VERSION.match(name)
            version = m.group(1) if m else ("latest" if "latest" in name else "")
        else:
            return
        ip, via_cloudflare = self._client_ip()
        if ip in LOOPBACK and not via_cloudflare:
            return  # the box itself: health checks, a deploy's own verification
        cc = self.headers.get("CF-IPCountry", "").strip().upper()
        event = {
            "t": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "kind": kind,
            "name": name,
            "ver": version,
            "v": visitor_id(ip),
            "cc": cc if re.fullmatch(r"[A-Z0-9]{2}", cc) else "",
            "bot": bool(BOT_UA.search(self.headers.get("User-Agent", "")) or not self.headers.get("User-Agent")),
        }
        try:
            with WRITE_LOCK:
                with open(EVENTS_FILE, "a", encoding="utf-8") as f:
                    f.write(json.dumps(event, separators=(",", ":")) + "\n")
        except OSError as e:
            # Counting must never be the reason a page or a download fails.
            sys.stderr.write("could not record event: %s\n" % e)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return TYPES.get(ext, super().guess_type(path))

    def end_headers(self):
        # Cross-origin isolation, so the worker can allocate a SharedArrayBuffer
        # and the ticker runs on Atomics rather than falling back to a timer.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Accept-Ranges", "bytes")
        # The build is content-hashed, but the pages are not (/, /web, /rc and
        # their .html files), so they must never be cached or a redeploy is
        # invisible to anyone who has visited before. rc.html also names the
        # current download by version.
        page = self.path.split("?")[0]
        if page.endswith("/") or os.path.splitext(page)[1] in ("", ".html"):
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


# Set by setup_data(), before the server starts. None means collection is off.
DATA_FILE = None
EVENTS_FILE = None
SALT = b""
# Where the reference-lap videos live, or "" for none.
REFERENCE_DIR = ""
WRITE_LOCK = threading.Lock()
MAX_BODY = 64 * 1024


def setup_data(data_dir: str) -> None:
    """Point the collection at data_dir (created if need be): the sessions file,
    the events file and the secret that keys the visitor hashes."""
    global DATA_FILE, EVENTS_FILE, SALT
    os.makedirs(data_dir, exist_ok=True)
    DATA_FILE = os.path.join(data_dir, "sessions.jsonl")
    EVENTS_FILE = os.path.join(data_dir, "events.jsonl")
    SALT = load_salt(data_dir)


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
        help="directory for sessions.jsonl, events.jsonl and .salt; empty string turns collection off",
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
    global REFERENCE_DIR
    if args.reference:
        REFERENCE_DIR = os.path.abspath(args.reference)
    if args.data:
        setup_data(os.path.abspath(args.data))

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

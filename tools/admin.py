#!/usr/bin/env python3
"""
Read the usage summaries that serve.py collects. Standard library only.

    python admin.py [--port 5181] [--data data] [--host 127.0.0.1]

**Access control is the bind address.** The Cloudflare tunnel forwards port 5180
and only 5180, so this port has no route from the internet whatever it binds —
and that is the entire protection, because there is no password on this page.

    --host 127.0.0.1   (default) the box only; reach it from elsewhere with
                       ssh -L 5181:127.0.0.1:5181 gilboash@hotmail.com@192.168.7.54
    --host 0.0.0.0     also the local network, so http://192.168.7.54:5181/
                       works from any machine in the house — and from anything
                       else on that network, guest wifi included. Chosen
                       deliberately on 2026-08-31; it is a home LAN, not a
                       public one.

A secret path on port 5180 would have been simpler and wrong: the tunnel carries
whatever that port answers, and the tunnel is the thing the pilots are on. For
the same reason a "is the client localhost?" check would be worthless — every
tunnelled request arrives from 127.0.0.1.

Every value on the page is escaped. Pilot names are typed by pilots, arrive over
an open POST endpoint, and are rendered back here — this page is exactly where a
script tag in a name would run, so nothing reaches the output without going
through html.escape.
"""

import argparse
import html
import http.server
import json
import os
import sys

DATA_FILE = ""


def load(path):
    """Sessions, newest record per session id.

    The page resends its whole summary as it grows, so the file holds several
    records for one session and the last one supersedes the rest. That is what
    makes a lost beacon harmless, and it means this reader takes the newest
    rather than adding them up — summing would multiply every flight by the
    number of heartbeats it survived.
    """
    sessions = {}
    bad = 0
    try:
        # utf-8-sig, not utf-8: anything that rewrites this file with PowerShell's
        # Set-Content leaves a BOM on the first line, and a BOM makes that line
        # unparseable while the file looks perfectly fine in an editor. Learned
        # by doing it to a live collection.
        with open(path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    r = rec["report"]
                    if not isinstance(r, dict):
                        raise ValueError("not an object")
                except (json.JSONDecodeError, KeyError, ValueError, TypeError):
                    bad += 1
                    continue
                sid = str(r.get("sessionId") or f"anon-{len(sessions)}")
                prev = sessions.get(sid)
                if prev is None or rec.get("receivedAt", "") >= prev[0].get("receivedAt", ""):
                    sessions[sid] = (rec, r)
    except FileNotFoundError:
        pass
    return [s for s in sessions.values()], bad


def aggregate(sessions):
    pilots = {}
    for rec, r in sessions:
        pid = str(r.get("pilotId") or "unknown")
        p = pilots.setdefault(
            pid,
            {
                "id": pid,
                "name": "",
                "first": "",
                "last": "",
                "sessions": 0,
                "armedS": 0.0,
                "crashes": 0,
                "maps": {},
                "tune": None,
                "build": "",
                "isolated": True,
                "secure": True,
            },
        )
        seen = rec.get("receivedAt", "")
        if r.get("name"):
            p["name"] = str(r["name"])
        if not p["first"] or seen < p["first"]:
            p["first"] = seen
        if seen > p["last"]:
            p["last"] = seen
            p["tune"] = r.get("tune")
            p["build"] = str(r.get("build") or "")
        p["sessions"] += 1
        p["crashes"] += int(r.get("crashes") or 0)
        p["isolated"] = p["isolated"] and bool(r.get("isolated"))
        p["secure"] = p["secure"] and bool(r.get("secure"))

        for m in r.get("maps") or []:
            if not isinstance(m, dict):
                continue
            name = str(m.get("name") or "?")
            e = p["maps"].setdefault(
                name,
                {"armedS": 0.0, "loads": 0, "crashes": 0, "races": 0, "laps": 0,
                 "bestLap": None, "bestThree": None},
            )
            e["armedS"] += float(m.get("armedS") or 0)
            e["loads"] += int(m.get("loads") or 0)
            e["crashes"] += int(m.get("crashes") or 0)
            e["races"] += int(m.get("races") or 0)
            e["laps"] += int(m.get("laps") or 0)
            for k in ("bestLap", "bestThree"):
                v = m.get(k)
                if isinstance(v, (int, float)) and (e[k] is None or v < e[k]):
                    e[k] = float(v)
            p["armedS"] += float(m.get("armedS") or 0)

    return sorted(pilots.values(), key=lambda p: p["last"], reverse=True)


def hms(seconds):
    s = int(round(seconds))
    if s < 60:
        return "%d s" % s
    if s < 3600:
        return "%d m %02d s" % (s // 60, s % 60)
    return "%d h %02d m" % (s // 3600, (s % 3600) // 60)


def secs(v):
    return "—" if v is None else "%.2f s" % v


E = html.escape


def tune_rows(tune):
    """Rates, PIDs and filters as the pilot has them.

    Rendered from whatever shape arrived rather than from a schema: this reads
    a payload produced by a build that may be older than this file, and a
    missing key should cost a dash, not a traceback.
    """
    if not isinstance(tune, dict):
        return "<p class=dim>no tune reported</p>"
    out = []

    rates = tune.get("rates")
    if isinstance(rates, dict):
        # Rates are stored per field with one entry per axis, not per axis with
        # one entry per field, so the table is transposed on the way out.
        def axis_cells(i):
            return "".join(
                "<td>%s</td>" % E(num(rates.get(f), i))
                for f in ("rcRate", "rate", "expo")
            )

        rows = "".join(
            "<tr><th>%s</th>%s</tr>" % (E(a), axis_cells(i))
            for i, a in enumerate(("roll", "pitch", "yaw"))
        )
        out.append(
            "<h4>Rates <span class=dim>(%s)</span></h4>"
            "<table><tr><th></th><th>RC rate</th><th>Rate</th><th>Expo</th></tr>%s</table>"
            % (E(str(rates.get("type", "?"))), rows)
        )

    pids = tune.get("pids")
    if isinstance(pids, dict):
        rows = []
        for axis in ("roll", "pitch", "yaw"):
            a = pids.get(axis)
            if not isinstance(a, dict):
                continue
            rows.append(
                "<tr><th>%s</th><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
                % (E(axis), E(str(a.get("p", "—"))), E(str(a.get("i", "—"))),
                   E(str(a.get("d", "—"))), E(str(a.get("f", "—"))))
            )
        if rows:
            out.append(
                "<h4>PIDs</h4><table>"
                "<tr><th></th><th>P</th><th>I</th><th>D</th><th>FF</th></tr>%s</table>"
                % "".join(rows)
            )
        filters = [
            ("gyro lpf", pids.get("gyroLowpassHz")),
            ("D lpf", pids.get("dtermLowpassHz")),
            ("iterm relax", pids.get("itermRelaxHz")),
        ]
        out.append(
            "<h4>Filters</h4><table>%s</table>"
            % "".join(
                "<tr><th>%s</th><td>%s Hz</td></tr>" % (E(k), E(str(v)))
                for k, v in filters
                if v is not None
            )
        )

    return "".join(out) or "<p class=dim>no tune reported</p>"


def num(seq, i):
    """One element of a rate triple, tolerant of anything that is not one."""
    if isinstance(seq, list) and i < len(seq):
        return str(seq[i])
    return "—"


PAGE = """<!doctype html>
<meta charset=utf-8><title>fpvsim — who is flying</title>
<style>
 body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background:#14171a; color:#dfe3e6;
        margin:0; padding:24px 28px; }
 h1 { font-size:20px; margin:0 0 4px; }
 h2 { font-size:16px; margin:0 0 2px; }
 h4 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#8b959e; margin:14px 0 4px; }
 .dim { color:#8b959e; }
 .pilot { border:1px solid #2b3138; border-radius:8px; padding:14px 16px; margin:14px 0; background:#191d21; }
 .head { display:flex; gap:14px; align-items:baseline; flex-wrap:wrap; }
 .cols { display:flex; gap:34px; flex-wrap:wrap; align-items:flex-start; }
 table { border-collapse:collapse; margin:0; }
 th, td { text-align:left; padding:2px 12px 2px 0; font-variant-numeric:tabular-nums; }
 th { color:#8b959e; font-weight:500; }
 code { color:#9fb4c7; }
 .warn { color:#d8b24a; }
 .totals { color:#8b959e; margin: 0 0 18px; }
</style>
<h1>fpvsim — who is flying</h1>
<p class=totals>%(totals)s</p>
%(pilots)s
<p class=dim>%(file)s · reload for the latest</p>
"""


def render(path):
    sessions, bad = load(path)
    pilots = aggregate(sessions)

    blocks = []
    for p in pilots:
        maps = sorted(p["maps"].items(), key=lambda kv: kv[1]["armedS"], reverse=True)
        rows = "".join(
            "<tr><th>%s</th><td>%s</td><td>%d loads</td><td>%d crashes</td>"
            "<td>%s</td><td>best %s</td><td>3-lap %s</td></tr>"
            % (
                E(name),
                hms(m["armedS"]),
                m["loads"],
                m["crashes"],
                ("%d races, %d laps" % (m["races"], m["laps"])) if m["races"] else "—",
                secs(m["bestLap"]),
                secs(m["bestThree"]),
            )
            for name, m in maps
        )
        flags = []
        if not p["secure"]:
            flags.append("<span class=warn>insecure origin — cannot fly</span>")
        elif not p["isolated"]:
            flags.append("<span class=warn>not cross-origin isolated — timer fallback</span>")
        blocks.append(
            "<div class=pilot>"
            "<div class=head><h2>%(name)s</h2><code>%(id)s</code>"
            "<span class=dim>%(sessions)d session(s) · %(armed)s armed · %(crashes)d crashes</span>"
            "%(flags)s</div>"
            "<p class=dim>first seen %(first)s · last seen %(last)s · build <code>%(build)s</code></p>"
            "<div class=cols><div><h4>Maps</h4><table>%(rows)s</table></div>"
            "<div>%(tune)s</div></div></div>"
            % {
                "name": E(p["name"] or "(no name)"),
                "id": E(p["id"][:8]),
                "sessions": p["sessions"],
                "armed": hms(p["armedS"]),
                "crashes": p["crashes"],
                "flags": " ".join(flags),
                "first": E(p["first"][:19].replace("T", " ")),
                "last": E(p["last"][:19].replace("T", " ")),
                "build": E(p["build"] or "?"),
                "rows": rows or "<tr><td class=dim>nothing flown</td></tr>",
                "tune": tune_rows(p["tune"]),
            }
        )

    total_armed = sum(p["armedS"] for p in pilots)
    totals = "%d pilot(s), %d session(s), %s armed in total" % (
        len(pilots),
        sum(p["sessions"] for p in pilots),
        hms(total_armed),
    )
    if bad:
        totals += " · <span class=warn>%d unreadable line(s) skipped</span>" % bad
    if not pilots:
        blocks.append("<p class=dim>Nothing collected yet.</p>")

    return PAGE % {
        "totals": totals,
        "pilots": "".join(blocks),
        "file": E(path),
    }


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/sessions.jsonl":
            # The raw file, for anything this page does not answer.
            try:
                with open(DATA_FILE, "rb") as f:
                    body = f.read()
            except FileNotFoundError:
                body = b""
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path != "/":
            self.send_error(404, "not found")
            return
        body = render(DATA_FILE).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stderr.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5181)
    # Defaults to the box alone. Widening it is a decision, so it is a flag with
    # a safe default rather than a default that has to be argued down.
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--data", default="data")
    ap.add_argument("--render", action="store_true", help="print the page and exit")
    args = ap.parse_args()

    global DATA_FILE
    DATA_FILE = os.path.join(os.path.abspath(args.data), "sessions.jsonl")

    if args.render:
        sys.stdout.write(render(DATA_FILE))
        return 0

    with http.server.ThreadingHTTPServer((args.host, args.port), Handler) as httpd:
        sys.stderr.write(
            "fpvsim admin on http://%s:%d/ reading %s%s\n"
            % (
                args.host,
                args.port,
                DATA_FILE,
                "" if args.host in ("127.0.0.1", "localhost") else "  [reachable from the LAN]",
            )
        )
        sys.stderr.flush()
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

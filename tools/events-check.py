#!/usr/bin/env python3
"""
End-to-end check of the visit and download counting: starts the real server on
a free port with a temporary data folder, sends requests as different visitors,
and checks what lands in events.jsonl (and what must not), then that the admin
page reports it. Standard library only.

    python3 tools/events-check.py        (npm run check:events)
"""
import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


serve = load("serve")
admin = load("admin")
serve.Handler.log_message = lambda *a, **k: None

failed = 0


def check(name, ok, detail=""):
    global failed
    if not ok:
        failed += 1
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name, (" - " + str(detail)) if detail else ""))


tmp = tempfile.mkdtemp(prefix="events-check-")
root, data = os.path.join(tmp, "dist"), os.path.join(tmp, "data")
os.makedirs(os.path.join(root, "downloads"))
os.makedirs(os.path.join(root, "assets"))
for name, body in {
    "index.html": "front", "web.html": "sim", "rc.html": "radio",
    "downloads/NacoSim-0.7.1.zip": "PK-fake-zip", "downloads/NacoSim-latest.zip": "PK-fake-zip",
    "assets/x.js": "1",
}.items():
    with open(os.path.join(root, name), "w") as f:
        f.write(body)
serve.setup_data(data)
os.chdir(root)
server = serve.Server(("127.0.0.1", 0), serve.Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()


def req(path, headers=None, method="GET"):
    c = http.client.HTTPConnection("127.0.0.1", port)
    c.request(method, path, headers=headers or {})
    r = c.getresponse()
    r.read()
    c.close()
    return r.status


BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36"
alice = {"CF-Connecting-IP": "203.0.113.7", "CF-IPCountry": "IL", "User-Agent": BROWSER}
bob = {"CF-Connecting-IP": "198.51.100.9", "CF-IPCountry": "DE", "User-Agent": BROWSER}

print("\nvisit and download counting")
check("alice opens /rc (clean url)", req("/rc", alice) == 200)
check("alice downloads the zip", req("/downloads/NacoSim-0.7.1.zip", alice) == 200)
check("bob opens /rc and leaves", req("/rc", bob) == 200)
check("a crawler opens / (flagged, not hidden)", req("/", {"CF-Connecting-IP": "192.0.2.50", "CF-IPCountry": "US", "User-Agent": "curl/8.4.0"}) == 200)
# none of these may be counted
req("/", {"User-Agent": BROWSER})                                        # the box itself, e.g. the health check
req("/rc", {"CF-Connecting-IP": "not-an-ip", "User-Agent": BROWSER})     # forged header falls back to the socket address: loopback
req("/downloads/NacoSim-0.7.1.zip", alice, method="HEAD")
req("/no-such-page", alice)
req("/assets/x.js", alice)
req("/downloads/NacoSim-9.9.9.zip", alice)                               # 404

with open(os.path.join(data, "events.jsonl")) as f:
    text = f.read()
events = [json.loads(l) for l in text.splitlines()]
check("exactly the four counted requests were written", len(events) == 4, "%d events: %s" % (len(events), [(e["kind"], e["name"]) for e in events]))
check("kinds and names", [(e["kind"], e["name"]) for e in events] == [("page", "rc"), ("download", "NacoSim-0.7.1.zip"), ("page", "rc"), ("page", "home")])
check("the download carries its version", events[1]["ver"] == "0.7.1", events[1].get("ver"))
check("the same address is the same visitor, a different one is not", events[0]["v"] == events[1]["v"] and events[0]["v"] != events[2]["v"])
check("a visitor is 12 hex digits", all(len(e["v"]) == 12 and int(e["v"], 16) >= 0 for e in events))
check("the visitor is the keyed hash of the Cloudflare address", events[0]["v"] == serve.visitor_id("203.0.113.7"))
check("a different secret gives different visitors (it cannot be guessed without it)", (lambda orig: (setattr(serve, "SALT", b"other"), serve.visitor_id("203.0.113.7"))[1] != orig)(events[0]["v"]))
serve.SALT = serve.load_salt(data)
check("no address anywhere in the file", not any(a in text for a in ("203.0.113.7", "198.51.100.9", "192.0.2.50", "127.0.0.1")))
check("no user agent in the file", "Mozilla" not in text and "curl" not in text)
check("countries are kept", [e["cc"] for e in events] == ["IL", "IL", "DE", "US"], [e["cc"] for e in events])
check("only the crawler is flagged as a bot", [e["bot"] for e in events] == [False, False, False, True])
check("the secret persists across restarts", serve.load_salt(data) == serve.SALT and os.path.exists(os.path.join(data, ".salt")))

print("\nthe statistics page")
s = admin.summarise_events(admin.load_events(os.path.join(data, "events.jsonl"))[0])
check("1 download by 1 visitor", s["downloads"] == 1 and s["downloaders"] == 1, (s["downloads"], s["downloaders"]))
check("2 people opened /rc, 1 of them downloaded", s["rc_visitors"] == 2 and s["rc_then_download"] == 1 and s["direct"] == 0, (s["rc_visitors"], s["rc_then_download"], s["direct"]))
check("the bot is left out of the counts", s["bots"] == 1 and s["visitors"] == 2, (s["bots"], s["visitors"]))
page = admin.events_html(os.path.join(data, "events.jsonl"))
check("the page says so in words", "1 download(s) by 1 unique visitor(s)" in page and "1 (50%)" in page and "1 request(s) from bots left out" in page)
check("the page lists the country and the file", "IL" in page and "NacoSim-0.7.1.zip" in page)
check("the page never shows an address", "203.0.113.7" not in page)
check("an empty collection says so", "Nothing counted yet" in admin.events_html(os.path.join(tmp, "nothing.jsonl")))
with open(os.path.join(data, "events.jsonl"), "a") as f:
    f.write("this is not json\n")
page = admin.events_html(os.path.join(data, "events.jsonl"))
check("a corrupt line is skipped and reported, not fatal", "unreadable line(s) skipped" in page and "NacoSim-0.7.1.zip" in page)

print("\nanalytics check %s" % ("passed" if failed == 0 else "FAILED (%d)" % failed))
server.shutdown()
sys.exit(0 if failed == 0 else 1)

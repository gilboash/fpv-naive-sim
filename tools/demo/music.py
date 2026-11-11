"""Synthesised soundtrack for the NacoSim demo: 120 BPM, 40 s, plus gate beeps
at the instants the radios really beeped and a whoosh on each cut. numpy only."""
import sys, wave, json
import numpy as np
SR = 44100
DUR = 40.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N); R = np.zeros(N)

def put(buf, start, sig, gain=1.0):
    i = int(start * SR)
    if i >= N: return
    j = min(N, i + len(sig))
    buf[i:j] += sig[: j - i] * gain

def add(start, sig, gain=1.0, pan=0.0):
    put(L, start, sig, gain * (1 - max(0, pan)))
    put(R, start, sig, gain * (1 + min(0, pan)))

def tt(d): return np.arange(int(d * SR)) / SR

def kick():
    t = tt(0.32); f = 42 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 8.5) + 0.25 * rng.standard_normal(len(t)) * np.exp(-t * 90)

def clap():
    t = tt(0.22); n = rng.standard_normal(len(t)); n = n - np.roll(n, 1)
    return n * (np.exp(-t * 22) + 0.6 * np.exp(-((t - 0.012) ** 2) * 9000)) * 0.5

def hat(open_=False):
    d = 0.22 if open_ else 0.05; t = tt(d); n = rng.standard_normal(len(t)); n = n - np.roll(n, 1)
    return n * np.exp(-t * (14 if open_ else 80)) * 0.5

def tone(freq, d, harm=(1, .5, .33, .25), decay=10.0, atk=0.004):
    t = tt(d); y = sum(a * np.sin(2 * np.pi * freq * (k + 1) * t) for k, a in enumerate(harm))
    return y * np.exp(-t * decay) * np.minimum(1, t / atk)

def pad(freq, d):
    t = tt(d); y = sum(np.sin(2 * np.pi * freq * m * t + p) for m, p in ((1, 0), (1.004, 1.3), (2, .4), (0.996, 2.1)))
    return y * (0.5 + 0.5 * np.sin(2 * np.pi * 0.35 * t + 1)) * np.minimum(1, t / 0.8) * np.minimum(1, (d - t) / 0.8) / 4

def riser(d):
    t = tt(d); n = rng.standard_normal(len(t)); n = n - np.roll(n, 1)
    return n * (t / d) ** 2.2 * 0.6

def whoosh(d=0.45):
    t = tt(d); n = rng.standard_normal(len(t)); n = (n + np.roll(n, 1) + np.roll(n, 2)) / 3
    return n * np.sin(np.pi * t / d) ** 2 * 0.5

def beep(freq=1500, d=0.09):
    t = tt(d); return np.sin(2 * np.pi * freq * t) * np.minimum(1, t / 0.003) * np.minimum(1, (d - t) / 0.02)

BEAT = 0.5; BAR = 2.0
CH = [  # (bass, chord tones for pad/arp)
    (55.0, (220.0, 261.63, 329.63)),
    (43.65, (174.61, 220.0, 261.63)),
    (65.41, (261.63, 329.63, 392.0)),
    (49.0, (196.0, 246.94, 293.66)),
]
ARP = [0, 1, 2, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1, 0, 1]
GROOVE0, END0 = 4.0, 36.0        # the beat drops at 4 s and stops for the end card

# title: a pad and a riser into the drop
for b in range(2):
    for f in CH[b % 4][1]: add(b * BAR, pad(f / 2, BAR + 0.5), 0.5)
add(1.6, riser(2.4), 0.7)
add(GROOVE0 - 0.02, kick(), 1.1); add(GROOVE0, whoosh(0.9)[::-1] * 0.0 + 0, 0)  # (a hit on the drop)
add(GROOVE0, clap() * 1.5, 0.8)

nb = int(DUR / BEAT)
for k in range(nb):
    t0 = k * BEAT
    bar = int(t0 // BAR) % 4
    if GROOVE0 <= t0 < END0:
        add(t0, kick(), 0.95)
        if k % 2 == 1: add(t0, clap(), 0.55)
        add(t0 + BEAT / 2, hat(open_=(k % 2 == 0)), 0.30, pan=0.3)
        add(t0, hat(), 0.18, pan=-0.3)
        bassf = CH[bar][0]
        add(t0, tone(bassf, BEAT * 0.95, harm=(1, .45, .2), decay=5.0), 0.55)
        add(t0 + BEAT * 0.75, tone(bassf * 2, BEAT * 0.2, harm=(1, .3), decay=18.0), 0.18)
        # sixteenth-note pluck arpeggio, louder as it goes
        gain = 0.17 + 0.07 * min(1.0, (t0 - GROOVE0) / 12)
        for s in range(2):
            ts = t0 + s * BEAT / 2
            idx = ARP[(k * 2 + s) % 16]
            f = CH[bar][1][idx] * (2 if (k * 2 + s) % 4 else 4)
            add(ts, tone(f, 0.35, harm=(1, .0, .33, .0, .2), decay=13.0), gain, pan=0.25 if s else -0.25)
        if int(t0 // BAR) != int((t0 - BEAT) // BAR) or k == int(GROOVE0 / BEAT):
            for f in CH[bar][1]: add(t0, pad(f / 2, BAR), 0.35)
    elif t0 >= END0:
        if abs(t0 - END0) < 1e-6:
            add(END0 - 0.01, kick(), 1.0)
            for f in (220.0, 261.63, 329.63, 440.0): add(END0, pad(f / 2, 4.2), 0.9)
        if t0 < DUR - 1.0:
            add(t0, tone(CH[0][1][int(t0 / BEAT) % 3] * 4, 0.6, harm=(1, .3, .1), decay=6.0), 0.07, pan=0.4)

# the cuts: a whoosh on each transition (boundaries from the edit)
CUTS = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
for c in CUTS: add(c - 0.28, whoosh(), 0.55)
# gate beeps where the radios really beeped (output-time seconds)
BEEPS = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
for b in BEEPS: add(b, beep(), 0.45)

# master: soft clip, trim fade out, 16-bit stereo
m = np.stack([L, R], axis=1)
fade = np.minimum(1, (DUR - np.arange(N) / SR) / 1.6)[:, None]
m = np.tanh(1.4 * m) * fade
m = m / max(1e-9, np.abs(m).max()) * 0.89
pcm = (m * 32767).astype("<i2")
with wave.open(sys.argv[3] if len(sys.argv) > 3 else "music.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("music written", N / SR, "s, cuts", len(CUTS), "beeps", len(BEEPS))

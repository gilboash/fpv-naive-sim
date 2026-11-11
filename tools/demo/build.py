"""Builds the NacoSim demo: 40 s, 1920x1080, from four iPhone clips in ~/Downloads.

    python3 tools/demo/music.py "[4,7,11,14,20,26,32,36]" "[20.2,21.64,31.18]" /tmp/music.wav
    python3 tools/demo/build.py out.mp4 /tmp/music.wav

The clips are not in the repository (IMG_7558.MOV, IMG_7561 2.MOV, IMG_7562.mov,
IMG_7563.mov: the T14 menu tour, the T14 flying and the TX16S flying). The picture
is tone-mapped from the phone's HLG HDR, every cut is on a beat of the 120 BPM
soundtrack that music.py synthesises, and the three beeps are placed where the
radios really beeped. Needs ffmpeg with zscale, xfade and drawtext, and numpy.
The web copy is a 720p re-encode (public/nacosim/demo.mp4). The end card carries
no version number and no repository address, on purpose.
"""
import os, subprocess, sys, json, tempfile
DL = os.path.expanduser("~/Downloads")
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FPS = 30
XF = 0.4
# HLG/BT.2020 from the iPhone -> SDR BT.709, tone mapped: without it the clips come out flat
TM = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
SRC = {
    "menu": f"{DL}/IMG_7558.MOV",       # T14, portrait: tools list, settings, rates, flying
    "t14": f"{DL}/IMG_7562.mov",        # T14 flying
    "tx_a": f"{DL}/IMG_7561 2.MOV",     # TX16S flying, angled close-up (real gate beeps)
    "tx_b": f"{DL}/IMG_7563.mov",       # TX16S flying
}
# boundaries on the beat grid (120 BPM, 0.5 s a beat)
B = [0, 4, 7, 11, 14, 20, 26, 32, 36, 40]

def esc(s): return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "")

def text(txt, a, b, size=64, y="h-190", x="(w-text_w)/2", color="white", box=True, fade=0.3, rise=14):
    """A caption on the clip's own clock, fading in and out, with a soft shadow."""
    alpha = f"if(lt(t,{a}+{fade}),(t-{a})/{fade},if(gt(t,{b}-{fade}),({b}-t)/{fade},1))"
    yy = f"({y})+{rise}*max(0,1-(t-{a})/{fade+0.2})"
    boxs = ":box=1:boxcolor=black@0.50:boxborderw=24" if box else ""
    return (f"drawtext=fontfile='{FONT}':text='{esc(txt)}':fontsize={size}:fontcolor={color}:x='{x}':y='{yy}'"
            f":alpha='{alpha}':shadowx=3:shadowy=3:shadowcolor=black@0.7{boxs}:enable='between(t,{a},{b})'")

def chip(txt, a, b, color="0x4fc3f7"):
    return text(txt, a, b, size=36, y="46", x="56", color=color, rise=0)

CLIPS = []   # each: dict(key, ss (source seconds at its boundary), speed, layout, caps[], label)
def clip(i, key, ss, speed, layout, caps, **kw):
    d = dict(i=i, key=key, ss=ss, speed=speed, layout=layout, caps=caps); d.update(kw); CLIPS.append(d)

# ---- the shots (index = slot between B[i] and B[i+1])
clip(1, "menu", 0.9, 1.65, "zoom", [text("Open it from the Tools menu", 0.5, 3.1)], crop=(1080, 608, 0, 992))
clip(2, "menu", 10.4, 2.35, "zoom", [text("Pick your track, laps and camera tilt", 0.5, 4.0)], crop=(1080, 608, 0, 992))
clip(3, "menu", 23.7, 1.15, "zoom", [text("Type in your own rates", 0.4, 3.0)], crop=(1080, 608, 0, 992))
clip(4, "t14", 2.6, 1.0, "zoom", [chip("Jumper T14", 0.2, 5.8), text("Fly the gates, on a tiny screen", 0.6, 5.6, y="130")], crop=(1018, 573, 0, 309))
clip(5, "tx_a", 0.6, 1.0, "cover", [chip("RadioMaster TX16S", 0.2, 5.8), text("Beep on every gate", 0.5, 5.7, y="130")])
clip(6, "tx_b", 8.0, 1.0, "zoom", [chip("RadioMaster TX16S", 0.2, 5.8), text("In colour on a TX16S", 0.5, 5.7, y="130")], crop=(974, 548, 0, 450))

def src_chain(c, n):
    ss, sp = c["ss"], c["speed"]
    L = (B[c["i"] + 1] - B[c["i"]]) + XF
    start = max(0.0, ss - (XF / 2) * sp)                 # the stream starts XF/2 before its boundary
    span = L * sp + 0.05
    base = f"[{n}:v]trim=start={start:.3f}:duration={span:.3f},setpts=(PTS-STARTPTS)/{sp},fps={FPS},{TM}"
    caps = ",".join(c["caps"])
    if c["layout"] == "zoom":   # crop to the screen end of the radio, 16:9
        cw, ch, cx, cy = c["crop"]
        body = f"{base},crop={cw}:{ch}:{cx}:{cy},scale=1920:1080:flags=lanczos,unsharp=5:5:0.8"
    elif c["layout"] == "cover":
        body = f"{base},scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080"
    else:                       # fit: sharp centred picture on a blurred, darkened copy of itself
        body = (f"{base},split[a{n}][b{n}];"
                f"[a{n}]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=40,eq=brightness=-0.18:saturation=1.15[bg{n}];"
                f"[b{n}]scale=-2:1000:flags=lanczos[fg{n}];[bg{n}][fg{n}]overlay=(W-w)/2:(H-h)/2")
    return f"{body},{caps},setsar=1,format=yuv420p,trim=duration={L:.3f}"

def split_clip(n_left, n_right):
    """Two radios flying side by side, labelled."""
    L = (B[7] - B[6]) + XF
    start_l = max(0, 9.0 - XF / 2); start_r = max(0, 9.0 - XF / 2)
    left = (f"[{n_left}:v]trim=start={start_l}:duration={L + .05},setpts=PTS-STARTPTS,fps={FPS},{TM},"
            f"scale=-2:1080,crop=960:1080")
    right = (f"[{n_right}:v]trim=start={start_r}:duration={L + .05},setpts=PTS-STARTPTS,fps={FPS},{TM},"
             f"scale=-2:1080,crop=960:1080")
    lab_l = text("Jumper T14", 0.3, L - 0.3, size=44, y="40", x="(480-text_w/2)", rise=0)
    lab_r = text("RadioMaster TX16S", 0.3, L - 0.3, size=44, y="40", x="(1440-text_w/2)", rise=0)
    return (f"{left},{lab_l}[sl];{right},{lab_r}[sr];[sl][sr]hstack=inputs=2,"
            f"drawbox=x=958:y=0:w=4:h=1080:color=0x4fc3f7@0.9:t=fill,setsar=1,format=yuv420p,trim=duration={L:.3f}")

def title_card(n_bg):
    L = B[1] + XF / 2
    bg = (f"[{n_bg}:v]trim=start=8:duration={L + .05},setpts=PTS-STARTPTS,fps={FPS},{TM},"
          f"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=30,eq=brightness=-0.42:saturation=1.1,")
    t = (text("NacoSim", 0.3, L, size=230, y="h/2-230", box=False, fade=0.9, rise=40) + ","
         + text("A flight simulator that lives on your EdgeTX radio", 1.2, L, size=54, y="h/2+40", box=False, color="0xd6dde5", fade=0.8, rise=24) + ","
         + f"drawbox=x=(iw-560)/2:y=ih/2+8:w=min(560\\,560*(t-0.5)/0.9):h=6:color=0x4fc3f7:t=fill:enable='gte(t,0.5)'")
    return f"{bg}{t},setsar=1,format=yuv420p,trim=duration={L:.3f}"

def end_card(n_bg):
    L = (B[9] - B[8]) + XF / 2
    bg = (f"[{n_bg}:v]trim=start=2:duration={L + .05},setpts=PTS-STARTPTS,fps={FPS},{TM},"
          f"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=34,eq=brightness=-0.5:saturation=1.1,")
    t = ",".join([
        text("NacoSim", 0.2, L, size=190, y="h/2-210", box=False, fade=0.6, rise=30),
        text("A flight simulator that lives on your EdgeTX radio", 0.8, L, size=54, y="h/2+10", box=False, color="0xd6dde5", fade=0.6),
        text("Tested on Jumper T14 and RadioMaster TX16S", 1.5, L, size=44, y="h/2+110", box=False, color="0x9fb4c7", fade=0.6),
    ])
    return f"{bg}{t},setsar=1,format=yuv420p,trim=duration={L:.3f}"

def main(out, music, preview=None):
    inputs = []   # (path)
    def inp(path): inputs.append(path); return len(inputs) - 1
    g = []
    labels = []
    n = inp(SRC["t14"]); g.append(f"{title_card(n)}[v0]"); labels.append("v0")
    for c in CLIPS:
        n = inp(SRC[c["key"]]); g.append(f"{src_chain(c, n)}[v{c['i']}]"); labels.append(f"v{c['i']}")
    nl, nr = inp(SRC["t14"]), inp(SRC["tx_b"])
    g.append(f"{split_clip(nl, nr)}[v7]"); labels.append("v7")
    n = inp(SRC["tx_a"]); g.append(f"{end_card(n)}[v8]"); labels.append("v8")
    # transitions between consecutive clips, centred on the boundary
    trans = ["fade", "fade", "fade", "slideleft", "wipeleft", "fade", "circleopen", "fadeblack"]
    cur = labels[0]
    for k in range(1, len(labels)):
        off = B[k] - XF / 2
        g.append(f"[{cur}][{labels[k]}]xfade=transition={trans[k-1]}:duration={XF}:offset={off:.3f}[x{k}]")
        cur = f"x{k}"
    g.append(f"[{cur}]fade=t=in:st=0:d=0.3,fade=t=out:st=39.4:d=0.6,format=yuv420p" + (",scale=960:540" if preview else "") + "[vout]")
    script = os.path.join(tempfile.mkdtemp(prefix="nacosim-demo-"), "graph.txt")
    open(script, "w").write(";\n".join(g))
    cmd = ["ffmpeg", "-v", "error", "-stats", "-y"]
    for p in inputs: cmd += ["-i", p]
    cmd += ["-i", music, "-/filter_complex", script, "-map", "[vout]", "-map", f"{len(inputs)}:a",
            "-t", "40", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    if preview: cmd += ["-crf", "26", "-preset", "veryfast"]
    cmd.append(out)
    print(" ".join(cmd[:8]), "...", len(inputs), "video inputs")
    subprocess.run(cmd, check=True)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], preview=len(sys.argv) > 3)

#!/usr/bin/env python3
"""HUD speed (mph) over time from a screen.mp4 (960x600), plus the throttle
overlay dot, which anchors the video clock to the sticks sent.

  python3 tools/vd-speed.py screen.mp4 [fps=15] > speed.csv      # t,mph,thr_dot_y
"""
import subprocess, sys, os, tempfile, glob
v = sys.argv[1]; fps = int(sys.argv[2]) if len(sys.argv) > 2 else 15
d = tempfile.mkdtemp()
subprocess.run(['ffmpeg','-loglevel','error','-i',v,'-vf',f'fps={fps},crop=70:22:18:487,scale=420:-2,format=gray,negate','-q:v','2',f'{d}/s_%05d.png'])
W,H=960,600
x0,y0,w,h=int(W*.425),int(H*.77),int(W*.15),int(H*.12)
raw=subprocess.run(['ffmpeg','-loglevel','error','-i',v,'-vf',f'fps={fps},crop={w}:{h}:{x0}:{y0}','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],capture_output=True).stdout
def dot(b):
    pts=[(i//3%w, i//3//w) for i in range(0,len(b),3) if b[i+1]>170 and b[i+1]-b[i]>90 and b[i+1]-b[i+2]>90 and i//3%w < w/2]
    return sum(p[1] for p in pts)/len(pts) if pts else float('nan')
files=sorted(glob.glob(f'{d}/s_*.png'))
print('t,mph,thr_dot_y')
for k,f in enumerate(files):
    t=subprocess.run(['tesseract',f,'-','--psm','7','-c','tessedit_char_whitelist=0123456789'],capture_output=True,text=True).stdout.strip()
    b=raw[k*w*h*3:(k+1)*w*h*3]
    print(f'{k/fps:.3f},{t if t.isdigit() else ""},{dot(b) if len(b)==w*h*3 else float("nan"):.1f}')

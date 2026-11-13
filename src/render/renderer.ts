/**
 * The FPV view. WebGL2, one shader, two draw calls, and an optional motion
 * blur pass after them (see POST_FRAG).
 *
 * Written directly rather than on a scene-graph library because the scene the
 * brief asks for is static geometry and a camera, and this way the frame cost
 * is measurable next to everything else in the project. Rendering happens in
 * requestAnimationFrame and never in the physics tick — the whole point of the
 * M0 measurement was to keep that tick clean.
 *
 * Frames. The physics is FRD body inside NED world, which is where the gyro
 * and PID signs come from and is not negotiable. WebGL wants Y up. The
 * conversion happens here, at the boundary, exactly once:
 *
 *   render.x =  east   =  ned.y
 *   render.y = -down   = -ned.z
 *   render.z = -north  = -ned.x
 *
 * which is right-handed, so nothing ends up mirrored.
 */

import type { FlightSim } from '../flight/sim.ts';
import { rotateBodyToWorld, vec3, type Vec3 } from '../flight/math.ts';
import { MeshBuilder, FLOATS_PER_VERTEX, type MeshData } from './mesh.ts';
import { invert, mat4, multiply, perspective, viewFromBasis, type Mat4 } from './mat4.ts';
import type { Track } from './track.ts';
import type { Obstacle } from '../flight/collision.ts';
import type { Checkpoint, Flag, Gate } from '../race/course.ts';
import { planeAxes } from '../race/race.ts';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
out vec3 vNormal;
out vec3 vColor;
out float vDist;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vWorld = aPos;
  vColor = aColor;
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  vDist = length(aPos - uCamPos);
  gl_Position = clip;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in float vDist;
in vec3 vWorld;
uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uUnlit;
uniform vec3 uTint;
out vec4 outColor;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec3 base = vColor * uTint;
  // Grass detail on the ground plane only (y = 0, facing up; the markers and
  // tarmac sit a centimetre or more above it). The chequer says where you are;
  // this is the fine texture that streams past underneath and gives speed
  // close to the ground, and the only thing motion blur has to smear there.
  // Faded out with distance, where it would only shimmer.
  if (uUnlit < 0.5 && vWorld.y < 0.005 && vNormal.y > 0.9) {
    float n = vnoise(vWorld.xz * 16.0) * 0.35 + vnoise(vWorld.xz * 5.0) * 0.3 + vnoise(vWorld.xz * 1.5) * 0.2 + vnoise(vWorld.xz * 0.45) * 0.15;
    float fade = 1.0 - smoothstep(6.0, 45.0, vDist);
    base *= 1.0 + (n - 0.5) * 0.42 * fade;
  }
  if (uUnlit < 0.5) {
    float lambert = max(dot(normalize(vNormal), uLightDir), 0.0);
    // Generous ambient: this is a training scene, and unreadable shadow is
    // worse than flat light when the job is judging depth and speed.
    base *= 0.45 + 0.55 * lambert;
    float fog = 1.0 - exp(-uFogDensity * vDist);
    base = mix(base, uFogColor, clamp(fog, 0.0, 1.0));
  }
  outColor = vec4(base, 1.0);
}`;

/**
 * Motion blur, as a camera's exposure makes it.
 *
 * A post pass over the drawn frame. Each pixel's world position comes back
 * from the depth buffer and is projected again with the camera where it was
 * when the shutter opened, `shutterMs` ago, worked out from the quad's own
 * velocity and body rates rather than from the previous frame. So the streak
 * is one exposure long whatever the frame rate, and it needs no history.
 *
 * Nothing special is done for the ground. On screen a point moves at about
 * speed / distance, so grass half a metre under a fast quad smears hard while a
 * gate forty metres off hardly moves, which is what a real camera shows.
 *
 * The streak is capped (a training sim that hides the gate is working against
 * itself), and the rotational part has its own weight, because a flip would
 * otherwise smear the whole frame.
 */
const POST_VERT = `#version 300 es
out vec2 vUv;
void main() {
  // One triangle covering the screen, from the vertex index alone.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const POST_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uColor;
uniform highp sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform mat4 uOpenViewProj;
uniform vec2 uRes;
uniform float uMaxPx;
uniform float uDebug;
out vec4 outColor;
const int N = 12;
void main() {
  float d = texture(uDepth, vUv).r;
  vec4 world = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  world /= world.w;
  vec4 open = uOpenViewProj * world;
  vec2 px = vec2(0.0);
  // A point that was behind the camera when the shutter opened has no streak.
  if (open.w > 0.01) px = (vUv - (open.xy / open.w * 0.5 + 0.5)) * uRes;
  float len = length(px);
  // For the checks: the streak length itself, 1/4 px per level, uncapped up to 64 px.
  if (uDebug > 0.5) {
    outColor = vec4(min(len, 63.75) / 63.75, 0.0, 0.0, 1.0);
    return;
  }
  if (len < 0.5) {
    outColor = texture(uColor, vUv);
    return;
  }
  if (len > uMaxPx) px *= uMaxPx / len;
  vec2 step = px / uRes;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1) - 0.5;
    acc += texture(uColor, vUv + step * t).rgb;
  }
  outColor = vec4(acc / float(N), 1.0);
}`;

export interface MotionBlurConfig {
  /** Exposure, ms. 0 is off, and off draws exactly as before: no extra pass. */
  shutterMs: number;
  /** Share of the body rotation that blurs, 0..1. Translation always counts fully. */
  rotation: number;
  /** Longest streak, as a fraction of the frame height. */
  maxFrac: number;
  /** Checks only: draw each pixel's streak length (red, 0.25 px a level) instead of the picture. */
  debugStreak?: boolean;
}

interface PostTargets {
  w: number;
  h: number;
  msFbo: WebGLFramebuffer;
  msColor: WebGLRenderbuffer;
  msDepth: WebGLRenderbuffer;
  fbo: WebGLFramebuffer;
  color: WebGLTexture;
  depth: WebGLTexture;
}

const SKY_TOP: [number, number, number] = [0.24, 0.42, 0.72];
const SKY_HORIZON: [number, number, number] = [0.68, 0.78, 0.86];

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('could not create shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? 'unknown'}`);
  }
  return sh;
}

interface Batch {
  vao: WebGLVertexArrayObject;
  count: number;
}

export interface CameraConfig {
  /** Vertical field of view, degrees. FPV cameras are wide. */
  fovDeg: number;
  /** Uptilt, degrees. Every racing pilot flies with some. */
  tiltDeg: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  // 75 degrees vertical is about 120 horizontal at 16:9. Real FPV lenses are
  // wider still, but they are also strongly barrel-distorted, and a rectilinear
  // projection at that angle stretches the edges into something no camera
  // produces. Matching the lens properly is a later job; this at least does not
  // lie about the middle of the frame.
  readonly camera: CameraConfig = { fovDeg: 75, tiltDeg: 25 };
  /** Milliseconds spent in the last draw, exponentially averaged. */
  frameCostMs = 0;
  readonly motionBlur: MotionBlurConfig = { shutterMs: 0, rotation: 0.35, maxFrac: 0.08 };
  /** Set if the blur's render targets could not be made; the view then draws unblurred. */
  blurUnsupported = '';
  /** Whether the last frame went through the blur pass. */
  lastFrameBlurred = false;

  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uViewProj: WebGLUniformLocation;
  private uCamPos: WebGLUniformLocation;
  private uLightDir: WebGLUniformLocation;
  private uFogColor: WebGLUniformLocation;
  private uFogDensity: WebGLUniformLocation;
  private uUnlit: WebGLUniformLocation;
  private uTint: WebGLUniformLocation;
  private scene: Batch | null = null;
  private sky: Batch;
  /** Index count of the active checkpoint marker; 0 when there is none. */
  get markerTriangleCount(): number {
    return this.marker?.count ?? 0;
  }

  /** Rebuilt when the active checkpoint changes, not per frame. */
  private marker: Batch | null = null;
  private markerVbo: WebGLBuffer | null = null;
  private markerEbo: WebGLBuffer | null = null;
  private markerKey = '';
  private markerCp: Checkpoint | null = null;

  private proj: Mat4 = mat4();
  private view: Mat4 = mat4();
  private viewProj: Mat4 = mat4();
  private fwdBody: Vec3 = vec3();
  private upBody: Vec3 = vec3();
  private rightBody: Vec3 = vec3();
  private fwdW: Vec3 = vec3();
  private upW: Vec3 = vec3();
  private rightW: Vec3 = vec3();
  private openView: Mat4 = mat4();
  private openViewProj: Mat4 = mat4();
  private invViewProj: Mat4 = mat4();
  private axis: Vec3 = vec3();
  private tmpA: Vec3 = vec3();
  private tmpF: Vec3 = vec3();
  private tmpU: Vec3 = vec3();
  private tmpR: Vec3 = vec3();

  private post: {
    prog: WebGLProgram;
    uColor: WebGLUniformLocation;
    uDepth: WebGLUniformLocation;
    uInvViewProj: WebGLUniformLocation;
    uOpenViewProj: WebGLUniformLocation;
    uRes: WebGLUniformLocation;
    uMaxPx: WebGLUniformLocation;
    uDebug: WebGLUniformLocation;
  } | null = null;
  private targets: PostTargets | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, depth: true });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const prog = gl.createProgram();
    if (!prog) throw new Error('could not create program');
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(prog) ?? 'unknown'}`);
    }
    this.program = prog;

    const need = (n: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(prog, n);
      if (!loc) throw new Error(`uniform ${n} missing`);
      return loc;
    };
    this.uViewProj = need('uViewProj');
    this.uCamPos = need('uCamPos');
    this.uLightDir = need('uLightDir');
    this.uFogColor = need('uFogColor');
    this.uFogDensity = need('uFogDensity');
    this.uUnlit = need('uUnlit');
    this.uTint = need('uTint');

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(SKY_HORIZON[0], SKY_HORIZON[1], SKY_HORIZON[2], 1);

    this.sky = this.upload(buildSky());
  }

  /**
   * Mark the next checkpoint, on the checkpoint itself.
   *
   * A first version floated an arrowhead above it, and a pilot's verdict was
   * that it was unclear — which it was: a shape hanging in the air names no
   * gate, shows no aperture and gives no direction. This outlines the hole you
   * are meant to fly through and puts an arrow through it pointing the way,
   * so the marker *is* the instruction.
   *
   * Built in world space, so it needs no model matrix. Rebuilt only when the
   * checkpoint changes — a few times a lap, not sixty times a second.
   */
  setNextCheckpoint(cp: Checkpoint | null): void {
    const key = cp === null ? '' : JSON.stringify(cp);
    if (key === this.markerKey) return;
    this.markerKey = key;
    this.markerCp = cp;
    if (cp === null) {
      this.marker = null;
      return;
    }
    this.uploadMarker(cp.kind === 'gate' ? buildGateMarker(cp) : buildFlagMarker(cp));
  }

  /**
   * One buffer, re-filled. Creating a fresh VAO per checkpoint would leak one
   * per gate for the length of a session.
   */
  /**
   * Which side of the next checkpoint the quad is on.
   *
   * A method rather than three lines inline so the checks can ask it without a
   * camera and a pixel count — and the vertical term matters: for a cube's
   * floors dirN and dirE are both zero, so the horizontal dot product is
   * identically zero and the tint would sit on the boundary, saying nothing
   * about the one checkpoint where the side you are on means above or below.
   */
  markerTint(cp: Checkpoint, sim: FlightSim): 'green' | 'red' {
    const up = cp.kind === 'gate' ? cp.up : cp.height;
    const dU = cp.kind === 'gate' ? (cp.dirU ?? 0) : 0;
    const ahead =
      (sim.pos.x - cp.north) * cp.dirN +
      (sim.pos.y - cp.east) * cp.dirE +
      (-sim.pos.z - up) * dU;
    return ahead < 0 ? 'green' : 'red';
  }

  private uploadMarker(data: MeshData): void {
    const gl = this.gl;
    if (!this.marker) {
      const vao = gl.createVertexArray();
      this.markerVbo = gl.createBuffer();
      this.markerEbo = gl.createBuffer();
      if (!vao || !this.markerVbo || !this.markerEbo) return;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.markerVbo);
      const stride = FLOATS_PER_VERTEX * 4;
      for (const [loc, size, off] of [
        [0, 3, 0],
        [1, 3, 12],
        [2, 3, 24],
      ] as [number, number, number][]) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.markerEbo);
      gl.bindVertexArray(null);
      this.marker = { vao, count: 0 };
    }
    gl.bindVertexArray(this.marker.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerVbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.markerEbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.marker.count = data.indices.length;
  }

  private upload(data: MeshData): Batch {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('could not create VAO');
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    for (const [loc, size, offset] of [
      [0, 3, 0],
      [1, 3, 12],
      [2, 3, 24],
    ] as [number, number, number][]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    }

    const ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: data.indices.length };
  }

  /** Builds the mesh and returns the collision volumes that came with it. */
  loadTrack(track: Track): Obstacle[] {
    const m = new MeshBuilder();
    const obstacles: Obstacle[] = [];
    track.build(m, obstacles);
    this.scene = this.upload(m.build());
    return obstacles;
  }

  /** Draw one frame from the simulator's current state. */
  render(sim: FlightSim): void {
    const t0 = performance.now();
    const gl = this.gl;
    const canvas = this.canvas;

    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    // Camera basis in the body frame, including the uptilt every FPV pilot
    // flies with: the camera looks above the direction of travel, which is why
    // a quad appears to fly nose-down on the screen.
    const tilt = (this.camera.tiltDeg * Math.PI) / 180;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    this.fwdBody.x = ct;
    this.fwdBody.y = 0;
    this.fwdBody.z = -st;
    // Rotating body up (0,0,-1) about the body's right axis by the tilt gives
    // (-sin t, 0, -cos t). The sign of that first term is not optional: with
    // +sin t the basis is not orthogonal — forward dot up came to 0.766 at 25
    // degrees — and a skewed basis makes a skewed view matrix, which shows up
    // as a horizon in the wrong place and vertical posts that lean.
    this.upBody.x = -st;
    this.upBody.y = 0;
    this.upBody.z = -ct;
    this.rightBody.x = 0;
    this.rightBody.y = 1;
    this.rightBody.z = 0;

    rotateBodyToWorld(this.fwdW, sim.q, this.fwdBody);
    rotateBodyToWorld(this.upW, sim.q, this.upBody);
    rotateBodyToWorld(this.rightW, sim.q, this.rightBody);

    // NED to render, at the boundary and nowhere else.
    const ex = sim.pos.y;
    const ey = -sim.pos.z;
    const ez = -sim.pos.x;

    perspective(this.proj, (this.camera.fovDeg * Math.PI) / 180, w / h, 0.05, 900);
    this.viewFrom(this.view, ex, ey, ez, this.rightW, this.upW, this.fwdW);
    multiply(this.viewProj, this.proj, this.view);

    const blur = this.motionBlur.shutterMs > 0 && !this.blurUnsupported && this.ensureTargets(w, h);
    this.lastFrameBlurred = blur;
    if (blur) {
      this.openCamera(sim, ex, ey, ez);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets!.msFbo);
    }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj);
    gl.uniform3f(this.uCamPos, ex, ey, ez);
    gl.uniform3f(this.uLightDir, 0.42, 0.82, 0.39);
    gl.uniform3f(this.uFogColor, SKY_HORIZON[0], SKY_HORIZON[1], SKY_HORIZON[2]);
    gl.uniform1f(this.uFogDensity, 0.0035);
    gl.uniform3f(this.uTint, 1, 1, 1);

    // Sky first, unlit and without depth writes, so everything draws over it.
    gl.uniform1f(this.uUnlit, 1);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.sky.vao);
    gl.drawElements(gl.TRIANGLES, this.sky.count, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);

    if (this.scene) {
      gl.uniform1f(this.uUnlit, 0);
      gl.bindVertexArray(this.scene.vao);
      gl.drawElements(gl.TRIANGLES, this.scene.count, gl.UNSIGNED_INT, 0);
    }

    // The blur goes between the scene and the marker, so the marker (a HUD
    // element in world space) stays sharp, as the OSD over the canvas does.
    if (blur) this.blurPass(w, h);

    // The next-checkpoint marker, folded into its own matrix. Unlit and drawn
    // without fog so it stays readable from the far end of the course, which is
    // exactly where a pilot needs it.
    if (this.marker && this.marker.count > 0 && this.markerCp) {
      // Green from the side you are meant to take it from, red from the other.
      // The marker geometry is drawn in white and tinted here, so telling a
      // pilot they are on the wrong side costs a uniform rather than a rebuilt
      // mesh every frame.
      const cp = this.markerCp;
      if (this.markerTint(cp, sim) === 'green') gl.uniform3f(this.uTint, 0.16, 1.0, 0.42);
      else gl.uniform3f(this.uTint, 1.0, 0.24, 0.24);

      gl.uniform1f(this.uUnlit, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(this.marker.vao);
      gl.drawElements(gl.TRIANGLES, this.marker.count, gl.UNSIGNED_INT, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.uniform3f(this.uTint, 1, 1, 1);
    }
    gl.bindVertexArray(null);

    const dt = performance.now() - t0;
    this.frameCostMs += (dt - this.frameCostMs) * 0.05;
  }

  /** View matrix from a camera basis given in NED, converted at the boundary as everywhere here. */
  private viewFrom(out: Mat4, ex: number, ey: number, ez: number, r: Vec3, u: Vec3, f: Vec3): void {
    viewFromBasis(out, ex, ey, ez, r.y, -r.z, -r.x, u.y, -u.z, -u.x, f.y, -f.z, -f.x);
  }

  /**
   * The camera when the shutter opened, one exposure ago: back along the
   * velocity, and the body rotation undone. Body to world then was
   * R(now) * exp(-[omega] T), so each body-frame camera axis is turned about
   * omega by -|omega| T before going to the world. Exact for a constant rate,
   * which over a few milliseconds it is.
   */
  private openCamera(sim: FlightSim, ex: number, ey: number, ez: number): void {
    const T = this.motionBlur.shutterMs / 1000;
    const k = Math.max(0, Math.min(1, this.motionBlur.rotation));
    const wx = sim.omega.x * k;
    const wy = sim.omega.y * k;
    const wz = sim.omega.z * k;
    const wl = Math.hypot(wx, wy, wz);
    const ang = -wl * T;
    const ax = this.axis;
    if (wl > 1e-6) {
      ax.x = wx / wl;
      ax.y = wy / wl;
      ax.z = wz / wl;
    }
    const turn = (out: Vec3, v: Vec3): void => {
      if (wl <= 1e-6) {
        out.x = v.x;
        out.y = v.y;
        out.z = v.z;
      } else {
        // Rodrigues.
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const kd = (ax.x * v.x + ax.y * v.y + ax.z * v.z) * (1 - c);
        out.x = v.x * c + (ax.y * v.z - ax.z * v.y) * s + ax.x * kd;
        out.y = v.y * c + (ax.z * v.x - ax.x * v.z) * s + ax.y * kd;
        out.z = v.z * c + (ax.x * v.y - ax.y * v.x) * s + ax.z * kd;
      }
      rotateBodyToWorld(this.tmpA, sim.q, out);
      out.x = this.tmpA.x;
      out.y = this.tmpA.y;
      out.z = this.tmpA.z;
    };
    turn(this.tmpF, this.fwdBody);
    turn(this.tmpU, this.upBody);
    turn(this.tmpR, this.rightBody);
    // NED velocity to render: east, up, -north.
    this.viewFrom(
      this.openView,
      ex - sim.vel.y * T,
      ey + sim.vel.z * T,
      ez + sim.vel.x * T,
      this.tmpR,
      this.tmpU,
      this.tmpF,
    );
    multiply(this.openViewProj, this.proj, this.openView);
  }

  /** Multisampled scene target, resolved into textures the blur can read. Rebuilt on resize. */
  private ensureTargets(w: number, h: number): boolean {
    const gl = this.gl;
    if (this.targets && this.targets.w === w && this.targets.h === h) return true;
    this.dropTargets();
    try {
      if (!this.post) this.post = this.buildPost();
      const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
      const msFbo = gl.createFramebuffer()!;
      const msColor = gl.createRenderbuffer()!;
      const msDepth = gl.createRenderbuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
      gl.bindRenderbuffer(gl.RENDERBUFFER, msColor);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColor);
      gl.bindRenderbuffer(gl.RENDERBUFFER, msDepth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msDepth);
      const msOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

      const tex = (internal: number, format: number, type: number): WebGLTexture => {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
        // Nearest on both: depth cannot be filtered, and the streak samples
        // land between texels anyway.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      const color = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      const depth = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      this.targets = { w, h, msFbo, msColor, msDepth, fbo, color, depth };
      if (!msOk || !ok) throw new Error('motion blur framebuffer incomplete');
      return true;
    } catch (e) {
      this.dropTargets();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.blurUnsupported = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private dropTargets(): void {
    const t = this.targets;
    if (!t) return;
    const gl = this.gl;
    gl.deleteFramebuffer(t.msFbo);
    gl.deleteFramebuffer(t.fbo);
    gl.deleteRenderbuffer(t.msColor);
    gl.deleteRenderbuffer(t.msDepth);
    gl.deleteTexture(t.color);
    gl.deleteTexture(t.depth);
    this.targets = null;
  }

  private buildPost(): NonNullable<Renderer['post']> {
    const gl = this.gl;
    const prog = gl.createProgram();
    if (!prog) throw new Error('could not create blur program');
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, POST_VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, POST_FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`blur link: ${gl.getProgramInfoLog(prog) ?? 'unknown'}`);
    }
    const need = (n: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(prog, n);
      if (!loc) throw new Error(`blur uniform ${n} missing`);
      return loc;
    };
    this.emptyVao = gl.createVertexArray();
    return {
      prog,
      uColor: need('uColor'),
      uDepth: need('uDepth'),
      uInvViewProj: need('uInvViewProj'),
      uOpenViewProj: need('uOpenViewProj'),
      uRes: need('uRes'),
      uMaxPx: need('uMaxPx'),
      uDebug: need('uDebug'),
    };
  }

  /** Resolve the multisampled scene, then draw it to the canvas through the blur. */
  private blurPass(w: number, h: number): void {
    const gl = this.gl;
    const t = this.targets!;
    const p = this.post!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);

    invert(this.invViewProj, this.viewProj);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.color);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.depth);
    gl.uniform1i(p.uColor, 0);
    gl.uniform1i(p.uDepth, 1);
    gl.uniformMatrix4fv(p.uInvViewProj, false, this.invViewProj);
    gl.uniformMatrix4fv(p.uOpenViewProj, false, this.openViewProj);
    gl.uniform2f(p.uRes, w, h);
    gl.uniform1f(p.uMaxPx, Math.max(1, this.motionBlur.maxFrac * h));
    gl.uniform1f(p.uDebug, this.motionBlur.debugStreak ? 1 : 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.enable(gl.DEPTH_TEST);
    // Back to the scene program for the marker.
    gl.useProgram(this.program);
  }
}

// White, because the colour comes from uTint at draw time — green when the
// pilot is on the right side of the checkpoint, red when they are not.
const MARK: [number, number, number] = [1, 1, 1];
const MARK_DIM: [number, number, number] = [0.55, 0.55, 0.55];

/** A flat bar between two world points, facing the viewer well enough. */
function bar(
  m: MeshBuilder,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  w: number,
  colour: readonly [number, number, number],
): void {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const dz = b[2]! - a[2]!;
  const len = Math.hypot(dx, dy, dz) || 1;
  // Any perpendicular will do; prefer one that is not nearly parallel to up.
  let px = -dz / len;
  let py = 0;
  let pz = dx / len;
  if (Math.hypot(px, pz) < 0.1) {
    px = 1;
    py = 0;
    pz = 0;
  }
  const nx = px * w;
  const ny = py * w;
  const nz = pz * w;
  m.quadColored(
    [a[0]! - nx, a[1]! - ny, a[2]! - nz],
    [b[0]! - nx, b[1]! - ny, b[2]! - nz],
    [b[0]! + nx, b[1]! + ny, b[2]! + nz],
    [a[0]! + nx, a[1]! + ny, a[2]! + nz],
    colour, colour, colour, colour,
  );
  // A second quad in the vertical plane, so the bar does not vanish edge-on.
  m.quadColored(
    [a[0]!, a[1]! - w, a[2]!],
    [b[0]!, b[1]! - w, b[2]!],
    [b[0]!, b[1]! + w, b[2]!],
    [a[0]!, a[1]! + w, a[2]!],
    colour, colour, colour, colour,
  );
}

/**
 * The gate marker: the aperture outlined, with an arrow through it.
 *
 * A first version floated an arrowhead above the gate. A pilot's verdict was
 * that it was unclear, and it was — a shape in the air names no gate, shows no
 * aperture and gives no direction. This outlines the exact hole the timer will
 * accept and points an arrow the way it must be taken, so the marker is the
 * instruction rather than a hint at one.
 */
/**
 * Exported so the headless checks can measure it. The marker has to trace the
 * aperture it marks — that is the whole of what it promises — and the only way
 * to assert that without a GPU is to build the mesh and read its corners.
 */
export function buildGateMarker(gate: Gate): MeshData {
  const m = new MeshBuilder();
  // NED to render, and the gate's across-axis in render space.
  const cx = gate.east;
  const cz = -gate.north;
  // Across the aperture: perpendicular to the direction of travel, in the
  // ground plane. In NED that is (-dirE, dirN); converting to render, where
  // x = east and z = -north, gives (dirN, dirE). Getting these two the wrong
  // way round drew the frame across the direction of flight instead of across
  // the gate, which looked like a skewed sliver rather than a rectangle.
  // Both in-plane axes come from the shared helper, so a horizontal checkpoint
  // — the open top of a cube — traces a rectangle lying flat rather than a
  // frame standing on edge. NED to render on the way out: x = east, y = up,
  // z = -north.
  const [axN, ayN] = planeAxes(gate.dirN, gate.dirE, gate.dirU ?? 0);
  const ax: [number, number, number] = [axN[1], axN[2], -axN[0]];
  const ay: [number, number, number] = [ayN[1], ayN[2], -ayN[0]];
  const w = gate.halfWidth;
  const h = gate.halfHeight;
  const corner = (sx: number, sy: number): [number, number, number] => [
    cx + ax[0] * w * sx + ay[0] * h * sy,
    gate.up + ax[1] * w * sx + ay[1] * h * sy,
    cz + ax[2] * w * sx + ay[2] * h * sy,
  ];
  const t = 0.07;
  bar(m, corner(-1, -1), corner(1, -1), t, MARK);
  bar(m, corner(-1, 1), corner(1, 1), t, MARK);
  bar(m, corner(-1, -1), corner(-1, 1), t, MARK);
  bar(m, corner(1, -1), corner(1, 1), t, MARK);

  // No arrow. The frame plus its colour says everything the rule cares about —
  // this is the gate, and green means you are on the side you take it from.
  // An arrow through the aperture was large, cluttered the thing a pilot is
  // trying to aim at, and said what the colour now says more quietly.
  return m.build();
}

/**
 * The flag marker: an arrow beside the pole, on the side you pass, pointing the
 * way you pass it.
 *
 * It was a circle on the ground with chevrons round it, which said "fly this
 * shape" when the shape was never the point — and a pilot reported it as
 * unclear and unpassable. One arrow says everything the rule cares about: this
 * side, this way.
 */
function buildFlagMarker(flag: Flag): MeshData {
  const m = new MeshBuilder();
  // Render direction of travel, and the across-axis on the passing side.
  const dx = flag.dirE;
  const dz = -flag.dirN;
  // Right of the direction of travel, in render space.
  const rx = flag.dirN;
  const rz = flag.dirE;
  const off = flag.passWidth * 0.6 * flag.side;
  const cx = flag.east + rx * off;
  const cz = -flag.north + rz * off;
  const y = Math.max(2.0, flag.height * 0.75);

  // Small: it marks a side, it is not a runway.
  const tip: [number, number, number] = [cx + dx * 1.3, y, cz + dz * 1.3];
  const tail: [number, number, number] = [cx - dx * 1.3, y, cz - dz * 1.3];
  bar(m, tail, tip, 0.07, MARK_DIM);
  for (const s of [-1, 1]) {
    const back: [number, number, number] = [
      tip[0] - dx * 0.6 + rx * 0.45 * s,
      y,
      tip[2] - dz * 0.6 + rz * 0.45 * s,
    ];
    bar(m, back, tip, 0.07, MARK);
  }
  return m.build();
}

/**
 * Sky dome: a real hemisphere, cheaper and simpler than a cubemap.
 *
 * The first version was a cylinder with a flat lid, and the lid's edge was
 * plainly visible as a hard-edged shape overhead the moment the camera tilted
 * up. A dome has no seam to see.
 */
function buildSky(): MeshData {
  const m = new MeshBuilder();
  const R = 700;
  const lon = 28;
  const lat = 12;
  const colourAt = (elev: number): [number, number, number] => {
    // Blend by elevation, biased so the gradient happens low where the eye is.
    const t = Math.min(1, Math.max(0, Math.sin(elev))) ** 0.6;
    return [
      SKY_HORIZON[0] + (SKY_TOP[0] - SKY_HORIZON[0]) * t,
      SKY_HORIZON[1] + (SKY_TOP[1] - SKY_HORIZON[1]) * t,
      SKY_HORIZON[2] + (SKY_TOP[2] - SKY_HORIZON[2]) * t,
    ];
  };
  // Start slightly below the horizon so there is no gap under a tilted camera.
  const elev0 = -0.12;
  for (let j = 0; j < lat; j++) {
    const e0 = elev0 + ((Math.PI / 2 - elev0) * j) / lat;
    const e1 = elev0 + ((Math.PI / 2 - elev0) * (j + 1)) / lat;
    const y0 = Math.sin(e0) * R;
    const y1 = Math.sin(e1) * R;
    const r0 = Math.cos(e0) * R;
    const r1 = Math.cos(e1) * R;
    const c0 = colourAt(e0);
    const c1 = colourAt(e1);
    for (let i = 0; i < lon; i++) {
      const a0 = (i / lon) * Math.PI * 2;
      const a1 = ((i + 1) / lon) * Math.PI * 2;
      m.quadColored(
        [Math.cos(a0) * r0, y0, Math.sin(a0) * r0],
        [Math.cos(a1) * r0, y0, Math.sin(a1) * r0],
        [Math.cos(a1) * r1, y1, Math.sin(a1) * r1],
        [Math.cos(a0) * r1, y1, Math.sin(a0) * r1],
        c0,
        c0,
        c1,
        c1,
      );
    }
  }
  return m.build();
}

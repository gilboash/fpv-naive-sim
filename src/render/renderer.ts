/**
 * The FPV view. WebGL2, one shader, two draw calls.
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
import { mat4, multiply, perspective, viewFromBasis, type Mat4 } from './mat4.ts';
import type { Track } from './track.ts';
import type { Obstacle } from '../flight/collision.ts';
import type { Checkpoint, Flag, Gate } from '../race/course.ts';

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
void main() {
  vNormal = aNormal;
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
uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uUnlit;
out vec4 outColor;
void main() {
  vec3 base = vColor;
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

  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uViewProj: WebGLUniformLocation;
  private uCamPos: WebGLUniformLocation;
  private uLightDir: WebGLUniformLocation;
  private uFogColor: WebGLUniformLocation;
  private uFogDensity: WebGLUniformLocation;
  private uUnlit: WebGLUniformLocation;
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

  private proj: Mat4 = mat4();
  private view: Mat4 = mat4();
  private viewProj: Mat4 = mat4();
  private fwdBody: Vec3 = vec3();
  private upBody: Vec3 = vec3();
  private rightBody: Vec3 = vec3();
  private fwdW: Vec3 = vec3();
  private upW: Vec3 = vec3();
  private rightW: Vec3 = vec3();

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
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

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
    viewFromBasis(
      this.view,
      ex,
      ey,
      ez,
      this.rightW.y,
      -this.rightW.z,
      -this.rightW.x,
      this.upW.y,
      -this.upW.z,
      -this.upW.x,
      this.fwdW.y,
      -this.fwdW.z,
      -this.fwdW.x,
    );
    multiply(this.viewProj, this.proj, this.view);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj);
    gl.uniform3f(this.uCamPos, ex, ey, ez);
    gl.uniform3f(this.uLightDir, 0.42, 0.82, 0.39);
    gl.uniform3f(this.uFogColor, SKY_HORIZON[0], SKY_HORIZON[1], SKY_HORIZON[2]);
    gl.uniform1f(this.uFogDensity, 0.0035);

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

    // The next-checkpoint marker, folded into its own matrix. Unlit and drawn
    // without fog so it stays readable from the far end of the course, which is
    // exactly where a pilot needs it.
    if (this.marker && this.marker.count > 0) {
      gl.uniform1f(this.uUnlit, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(this.marker.vao);
      gl.drawElements(gl.TRIANGLES, this.marker.count, gl.UNSIGNED_INT, 0);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.bindVertexArray(null);

    const dt = performance.now() - t0;
    this.frameCostMs += (dt - this.frameCostMs) * 0.05;
  }
}

const MARK: [number, number, number] = [0.16, 1.0, 0.42];
const MARK_DIM: [number, number, number] = [0.08, 0.5, 0.24];

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
function buildGateMarker(gate: Gate): MeshData {
  const m = new MeshBuilder();
  // NED to render, and the gate's across-axis in render space.
  const cx = gate.east;
  const cz = -gate.north;
  // Across the aperture: perpendicular to the direction of travel, in the
  // ground plane. In NED that is (-dirE, dirN); converting to render, where
  // x = east and z = -north, gives (dirN, dirE). Getting these two the wrong
  // way round drew the frame across the direction of flight instead of across
  // the gate, which looked like a skewed sliver rather than a rectangle.
  const ux = gate.dirN;
  const uz = gate.dirE;
  const w = gate.halfWidth;
  const h = gate.halfHeight;
  const y0 = gate.up - h;
  const y1 = gate.up + h;
  const corner = (sx: number, sy: number): [number, number, number] => [
    cx + ux * w * sx,
    sy > 0 ? y1 : y0,
    cz + uz * w * sx,
  ];
  const t = 0.07;
  bar(m, corner(-1, -1), corner(1, -1), t, MARK);
  bar(m, corner(-1, 1), corner(1, 1), t, MARK);
  bar(m, corner(-1, -1), corner(-1, 1), t, MARK);
  bar(m, corner(1, -1), corner(1, 1), t, MARK);

  // Arrow through the middle, pointing the way the gate is taken. Render
  // direction is the NED direction with z negated.
  const dx = gate.dirE;
  const dz = -gate.dirN;
  const tip: [number, number, number] = [cx + dx * 1.8, gate.up, cz + dz * 1.8];
  const tail: [number, number, number] = [cx - dx * 1.4, gate.up, cz - dz * 1.4];
  bar(m, tail, tip, 0.055, MARK_DIM);
  for (const side of [-1, 1]) {
    const back: [number, number, number] = [
      tip[0] - dx * 0.75 + ux * 0.55 * side,
      gate.up,
      tip[2] - dz * 0.75 + uz * 0.55 * side,
    ];
    bar(m, back, tip, 0.055, MARK);
  }
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
  const off = flag.passWidth * 0.5 * flag.side;
  const cx = flag.east + rx * off;
  const cz = -flag.north + rz * off;
  const y = 2.0;

  const tip: [number, number, number] = [cx + dx * 2.6, y, cz + dz * 2.6];
  const tail: [number, number, number] = [cx - dx * 2.6, y, cz - dz * 2.6];
  bar(m, tail, tip, 0.1, MARK);
  for (const s of [-1, 1]) {
    const back: [number, number, number] = [
      tip[0] - dx * 1.1 + rx * 0.85 * s,
      y,
      tip[2] - dz * 1.1 + rz * 0.85 * s,
    ];
    bar(m, back, tip, 0.1, MARK);
  }
  // A short upright at the arrow, so it reads from a distance and from above.
  bar(m, [cx, 0.2, cz], [cx, y, cz], 0.07, MARK_DIM);
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

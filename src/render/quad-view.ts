/**
 * A small 3D quad that answers one question: did the channel mapping come out
 * right?
 *
 * It is driven by the sticks, not by the simulator, and it is deliberately
 * *not* a repeat of the FPV view — pointing two things at the same state would
 * only tell a pilot the same thing twice. Push right, the quad banks right.
 * Push forward, the nose drops. If either is backwards, the mapping is wrong
 * and it takes a second to see rather than a takeoff to discover.
 *
 * It integrates, like acro. Hold the stick and it keeps rolling; centre the
 * stick and it stays where it is. An earlier version sprang back to level,
 * which is angle mode — the one thing this simulator is not — and a stick check
 * behaving like a mode the pilot never flies checks the wrong thing. The Level
 * button is there for when it ends up somewhere unreadable.
 *
 * Throttle does not move it — there is no thrust here and it hangs in space —
 * but it does drive the prop speed, so the throttle channel can be checked in
 * the same glance.
 *
 * Deliberately reuses the scene renderer's shader and MeshBuilder rather than
 * introducing a second way of drawing things. The shader takes one combined
 * matrix and no model matrix, which suits this: there are five rigid pieces —
 * the airframe and four prop discs — so the model transform is folded into the
 * matrix per draw and the shader is untouched.
 */

import { MeshBuilder, FLOATS_PER_VERTEX, type MeshData } from './mesh.ts';
import { mat4, multiply, perspective, viewFromBasis, type Mat4 } from './mat4.ts';
import type { Airframe } from '../flight/airframe.ts';
import type { Commands } from '../mapping.ts';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uMVP;
out vec3 vNormal;
out vec3 vColor;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
uniform vec3 uLightDir;
uniform float uAlpha;
out vec4 outColor;
void main() {
  float lambert = max(dot(normalize(vNormal), uLightDir), 0.0);
  outColor = vec4(vColor * (0.42 + 0.58 * lambert), uAlpha);
}`;

interface Batch {
  vao: WebGLVertexArrayObject;
  count: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('could not create shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`quad-view shader: ${gl.getShaderInfoLog(sh) ?? 'unknown'}`);
  }
  return sh;
}

/** Airframe body, in render space: x right, y up, z toward the viewer. */
function buildBody(af: Airframe): MeshData {
  const m = new MeshBuilder();
  const arm = 0.012;
  for (const mount of af.mounts) {
    // NED body (x fwd, y right, z down) to render (x right, y up, z back).
    const ex = mount.pos.y;
    const ez = -mount.pos.x;
    // Arm as a slab from the centre out to the motor.
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      m.slab(
        Math.min(ex * t0, ex * t1) - arm, -arm, Math.min(ez * t0, ez * t1) - arm,
        Math.max(ex * t0, ex * t1) + arm, arm, Math.max(ez * t0, ez * t1) + arm,
        0.32, 0.34, 0.38,
      );
    }
    // Motor can under each arm end.
    m.cylinder(ex, ez, -0.004, 0.022, 0.017, 10, 0.62, 0.64, 0.7);
  }
  // Body: a slab, with a lighter nose block so the front is unmistakable.
  m.slab(-0.03, -0.016, -0.05, 0.03, 0.018, 0.05, 0.2, 0.22, 0.26);
  m.slab(-0.018, 0.004, -0.075, 0.018, 0.022, -0.05, 0.85, 0.3, 0.18);
  return m.build();
}

/** One prop disc, centred on the origin so it can spin about its own axis. */
function buildProp(radius: number): MeshData {
  const m = new MeshBuilder();
  const blades = 3;
  // One mesh for all four rotors, drawn four times; the spin direction comes
  // from the mount, not the geometry. An earlier signature took a `ccw` flag
  // and coloured by it, which was a lie once the mesh was shared.
  const c: [number, number, number] = [0.36, 0.62, 0.95];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // A tapered blade, drawn as two triangles via a quad.
    const rootW = 0.006;
    const tipW = 0.011;
    const pt = (r: number, w: number): [number, number, number] => [
      ca * r - sa * w,
      0,
      sa * r + ca * w,
    ];
    m.quadColored(
      pt(0.008, -rootW), pt(radius, -tipW), pt(radius, tipW), pt(0.008, rootW),
      c, c, c, c,
    );
  }
  m.cylinder(0, 0, 0.0, 0.006, 0.008, 8, 0.5, 0.5, 0.55);
  return m.build();
}

export class QuadView {
  readonly canvas: HTMLCanvasElement;
  /** Accumulated prop angle, radians, one per motor. */
  private spin = [0, 0, 0, 0];
  private lastFrame = 0;

  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uMVP: WebGLUniformLocation;
  private uLightDir: WebGLUniformLocation;
  private uAlpha: WebGLUniformLocation;
  private body: Batch;
  private prop: Batch;
  private mounts: { x: number; y: number; z: number; ccw: boolean }[];

  private proj: Mat4 = mat4();
  private view: Mat4 = mat4();
  private vp: Mat4 = mat4();
  private mvp: Mat4 = mat4();
  private model: Mat4 = mat4();

  constructor(canvas: HTMLCanvasElement, af: Airframe) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const prog = gl.createProgram();
    if (!prog) throw new Error('could not create program');
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`quad-view link: ${gl.getProgramInfoLog(prog) ?? 'unknown'}`);
    }
    this.program = prog;
    const need = (n: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(prog, n);
      if (!loc) throw new Error(`uniform ${n} missing`);
      return loc;
    };
    this.uMVP = need('uMVP');
    this.uLightDir = need('uLightDir');
    this.uAlpha = need('uAlpha');

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.067, 0.086, 0.122, 1);

    this.body = this.upload(buildBody(af));
    this.prop = this.upload(buildProp(af.prop.radius));
    this.mounts = af.mounts.map((m) => ({
      x: m.pos.y,
      y: -m.pos.z,
      z: -m.pos.x,
      ccw: m.spin === 1,
    }));
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
    for (const [loc, size, off] of [
      [0, 3, 0],
      [1, 3, 12],
      [2, 3, 24],
    ] as [number, number, number][]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    }
    const ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: data.indices.length };
  }

  /**
   * Integrate the model's attitude by a body-frame rate, the way an aircraft
   * actually rotates: post-multiply the current orientation by a small local
   * rotation. Gimbal-lock free, and no Euler angles at all — which matters
   * because a quad in acro spends real time inverted.
   *
   * Signs, derived from the geometry rather than guessed. The nose is drawn at
   * -z and the camera sits at +z looking at it, so we watch from behind:
   *
   *   roll right     right wingtip drops, +x toward -y: negative about +z
   *   pitch forward  nose drops, and the nose is at -z:  negative about +x
   *   yaw right      nose swings toward +x:              negative about +y
   *
   * All three come out negative, which is a property of this view's axes and
   * not a rule worth generalising.
   */
  private integrate(rollRate: number, pitchRate: number, yawRate: number, dt: number): void {
    const rx = -pitchRate * dt;
    const ry = -yawRate * dt;
    const rz = -rollRate * dt;

    const inc = mat4();
    inc[0] = 1; inc[1] = rz; inc[2] = -ry; inc[3] = 0;
    inc[4] = -rz; inc[5] = 1; inc[6] = rx; inc[7] = 0;
    inc[8] = ry; inc[9] = -rx; inc[10] = 1; inc[11] = 0;
    inc[12] = inc[13] = inc[14] = 0; inc[15] = 1;

    const out = mat4();
    multiply(out, this.model, inc);
    this.model.set(out);
    this.orthonormalise();
  }

  /**
   * Gram-Schmidt. A small-angle increment is not exactly a rotation, so without
   * this the model slowly shears — the same failure as a bad camera basis, and
   * just as easy to mistake for something else.
   */
  private orthonormalise(): void {
    const m = this.model;
    const norm = (i: number): void => {
      const l = Math.hypot(m[i]!, m[i + 1]!, m[i + 2]!) || 1;
      m[i] = m[i]! / l;
      m[i + 1] = m[i + 1]! / l;
      m[i + 2] = m[i + 2]! / l;
    };
    norm(0);
    const d = m[0]! * m[4]! + m[1]! * m[5]! + m[2]! * m[6]!;
    m[4] = m[4]! - d * m[0]!;
    m[5] = m[5]! - d * m[1]!;
    m[6] = m[6]! - d * m[2]!;
    norm(4);
    m[8] = m[1]! * m[6]! - m[2]! * m[5]!;
    m[9] = m[2]! * m[4]! - m[0]! * m[6]!;
    m[10] = m[0]! * m[5]! - m[1]! * m[4]!;
  }

  /** The current orientation, for tests that need the state and not the pixels. */
  get modelMatrix(): Mat4 {
    return this.model;
  }

  /**
   * Back to level, for when acro has left it somewhere unreadable.
   *
   * Also forgets the frame clock. Without that the next frame's dt is measured
   * from whenever this last drew — which after a tab switch is a long time, and
   * the model would snap through a large rotation the instant it came back.
   */
  level(): void {
    this.model.fill(0);
    this.model[0] = this.model[5] = this.model[10] = this.model[15] = 1;
    this.lastFrame = 0;
  }

  /**
   * The rate the sticks are asking for, deg/s per axis, from the pilot's own
   * rate curve. Set by the owner each frame.
   *
   * An earlier version turned at a made-up constant, which showed the direction
   * and nothing else. Using the real curve makes this a check of the rates too:
   * full stick here turns at exactly the figure the rates panel quotes, so a
   * curve that is wrong is visible as a model that is too lazy or too frantic.
   */
  rateDps: [number, number, number] = [0, 0, 0];

  render(cmd: Commands, nowMs: number): void {
    const gl = this.gl;
    const canvas = this.canvas;
    const dt = this.lastFrame ? Math.min(0.1, (nowMs - this.lastFrame) / 1000) : 0;
    this.lastFrame = nowMs;

    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Fixed camera, behind and above, looking down at the quad. The quad moves;
    // the camera does not, which is what makes the attitude readable.
    perspective(this.proj, (42 * Math.PI) / 180, w / h, 0.02, 10);
    const eye = { x: 0.13, y: 0.19, z: 0.33 };
    const len = Math.hypot(eye.x, eye.y, eye.z);
    const fx = -eye.x / len;
    const fy = -eye.y / len;
    const fz = -eye.z / len;
    // right = normalise(forward x worldUp), up = right x forward.
    //
    // Written out term by term rather than trusted, because I got this exact
    // cross product wrong here on the first attempt — and wrong in the scene
    // renderer before that. A basis that is not orthonormal still draws a
    // picture, just a sheared one with the subject sliding off the frame.
    // There is a test asserting orthonormality; see tools/flight-check.ts.
    const rx = fy * 0 - fz * 1;
    const ry = fz * 0 - fx * 0;
    const rz = fx * 1 - fy * 0;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const rX = rx / rl;
    const rY = ry / rl;
    const rZ = rz / rl;
    const ux = rY * fz - rZ * fy;
    const uy = rZ * fx - rX * fz;
    const uz = rX * fy - rY * fx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    viewFromBasis(
      this.view, eye.x, eye.y, eye.z,
      rX, rY, rZ,
      ux / ul, uy / ul, uz / ul,
      fx, fy, fz,
    );
    multiply(this.vp, this.proj, this.view);

    // Sticks are rates, not angles. No sign flips: the integrator's pitch is
    // nose-down positive and so is a pitch command, so they already agree —
    // negating on top of that was the reversal a pilot reported.
    const D = Math.PI / 180;
    this.integrate(this.rateDps[0] * D, this.rateDps[1] * D, this.rateDps[2] * D, dt);
    multiply(this.mvp, this.vp, this.model);

    gl.useProgram(this.program);
    gl.uniform3f(this.uLightDir, 0.38, 0.86, 0.34);
    gl.uniform1f(this.uAlpha, 1);
    gl.uniformMatrix4fv(this.uMVP, false, this.mvp);
    gl.bindVertexArray(this.body.vao);
    gl.drawElements(gl.TRIANGLES, this.body.count, gl.UNSIGNED_INT, 0);

    // Props: one draw each, the spin folded into the same matrix.
    gl.uniform1f(this.uAlpha, 0.72);
    gl.bindVertexArray(this.prop.vao);
    for (let i = 0; i < this.mounts.length; i++) {
      const mount = this.mounts[i]!;
  // Idle plus throttle, so the props turn even at rest — a still disc reads
      // as broken — and speed up with the throttle channel, which is the only
      // thing throttle does here. Radians per second, already legible, so this
      // one needs no scaling: it is not pretending to be a rotor speed.
      const rate = 2.5 + Math.max(0, Math.min(1, cmd.throttle)) * 26;
      this.spin[i] = (this.spin[i]! + rate * dt * (mount.ccw ? 1 : -1)) % (Math.PI * 2);
      const ca = Math.cos(this.spin[i]!);
      const sa = Math.sin(this.spin[i]!);

      // model * translate(mount) * rotateY(spin), built directly.
      const p = this.model;
      const m = this.mvp;
      // Local basis after the spin, in body axes.
      const bx = [ca, 0, -sa];
      const bz = [sa, 0, ca];
      const local = mat4();
      local[0] = bx[0]!; local[1] = 0; local[2] = bx[2]!; local[3] = 0;
      local[4] = 0; local[5] = 1; local[6] = 0; local[7] = 0;
      local[8] = bz[0]!; local[9] = 0; local[10] = bz[2]!; local[11] = 0;
      local[12] = mount.x; local[13] = mount.y + 0.026; local[14] = mount.z; local[15] = 1;
      const world = mat4();
      multiply(world, p, local);
      multiply(m, this.vp, world);
      gl.uniformMatrix4fv(this.uMVP, false, m);
      gl.drawElements(gl.TRIANGLES, this.prop.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }
}

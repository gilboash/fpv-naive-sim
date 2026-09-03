/**
 * Geometry for the scene, built once into one interleaved buffer.
 *
 * The whole track is static, so it becomes a single vertex array and a single
 * draw call rather than an object graph walked every frame. That is not
 * premature: this has to share a frame with a 1 kHz physics loop, and the
 * cheapest renderer is the one that does nothing per object.
 *
 * Layout per vertex: position xyz, normal xyz, colour rgb. Flat colours and one
 * directional light — the brief asks for simple maps with basic obstacles, and
 * a pilot judging feel needs to read depth and speed, not materials.
 */

export interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
}

export const FLOATS_PER_VERTEX = 9;

export class MeshBuilder {
  private verts: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.verts.length / FLOATS_PER_VERTEX;
  }

  private push(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    r: number,
    g: number,
    b: number,
  ): void {
    this.verts.push(x, y, z, nx, ny, nz, r, g, b);
  }

  /**
   * Rectangular slab, given directly by its corner extents. Simpler and less
   * error-prone than the general box above for axis-aligned scenery.
   */
  slab(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const quads: [number[], number[], number[], number[], number[]][] = [
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]],
      [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]],
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]],
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]],
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]],
      [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]],
    ];
    for (const [a, b2, c, d, n] of quads) {
      const base = this.vertexCount;
      for (const p of [a, b2, c, d]) {
        this.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, r, g, b);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Vertical cylinder, for gate posts and pylons. */
  cylinder(
    cx: number,
    cz: number,
    yBase: number,
    yTop: number,
    radius: number,
    segments: number,
    r: number,
    g: number,
    b: number,
  ): void {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius;
      const z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius;
      const z1 = cz + Math.sin(a1) * radius;
      const nx0 = Math.cos(a0);
      const nz0 = Math.sin(a0);
      const nx1 = Math.cos(a1);
      const nz1 = Math.sin(a1);
      const base = this.vertexCount;
      this.push(x0, yBase, z0, nx0, 0, nz0, r, g, b);
      this.push(x1, yBase, z1, nx1, 0, nz1, r, g, b);
      this.push(x1, yTop, z1, nx1, 0, nz1, r, g, b);
      this.push(x0, yTop, z0, nx0, 0, nz0, r, g, b);
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /**
   * A cylinder between two arbitrary points, with end caps.
   *
   * `cylinder` above is vertical only, which is all a post needs; a gate's top
   * and bottom rails run horizontally at whatever heading the gate faces, so
   * they need the general case. Normals are radial, so it lights like a tube
   * rather than like a flat bar.
   */
  rod(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    radius: number,
    segments: number,
    r: number,
    g: number,
    bl: number,
  ): void {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return;
    dx /= len;
    dy /= len;
    dz /= len;
    // Any vector not parallel to the axis will do to start the frame; picking
    // the world axis the rod points at least along keeps it well conditioned.
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    const hx = ax < ay && ax < az ? 1 : 0;
    const hy = ay <= ax && ay < az ? 1 : 0;
    const hz = hx === 0 && hy === 0 ? 1 : 0;
    // u = normalise(d x h), v = d x u.
    let ux = dy * hz - dz * hy;
    let uy = dz * hx - dx * hz;
    let uz = dx * hy - dy * hx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    for (let i = 0; i < segments; i++) {
      const t0 = (i / segments) * Math.PI * 2;
      const t1 = ((i + 1) / segments) * Math.PI * 2;
      const n0x = ux * Math.cos(t0) + vx * Math.sin(t0);
      const n0y = uy * Math.cos(t0) + vy * Math.sin(t0);
      const n0z = uz * Math.cos(t0) + vz * Math.sin(t0);
      const n1x = ux * Math.cos(t1) + vx * Math.sin(t1);
      const n1y = uy * Math.cos(t1) + vy * Math.sin(t1);
      const n1z = uz * Math.cos(t1) + vz * Math.sin(t1);
      const base = this.vertexCount;
      this.push(a[0] + n0x * radius, a[1] + n0y * radius, a[2] + n0z * radius, n0x, n0y, n0z, r, g, bl);
      this.push(a[0] + n1x * radius, a[1] + n1y * radius, a[2] + n1z * radius, n1x, n1y, n1z, r, g, bl);
      this.push(b[0] + n1x * radius, b[1] + n1y * radius, b[2] + n1z * radius, n1x, n1y, n1z, r, g, bl);
      this.push(b[0] + n0x * radius, b[1] + n0y * radius, b[2] + n0z * radius, n0x, n0y, n0z, r, g, bl);
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);

      // Caps, as a fan of degenerate quads. Usually buried inside whatever the
      // rod meets, and cheap enough not to reason about when they are not.
      for (const [p, sign] of [[a, -1], [b, 1]] as [readonly [number, number, number], number][]) {
        const c = this.vertexCount;
        const nx = dx * sign;
        const ny = dy * sign;
        const nz = dz * sign;
        this.push(p[0], p[1], p[2], nx, ny, nz, r, g, bl);
        this.push(p[0] + n0x * radius, p[1] + n0y * radius, p[2] + n0z * radius, nx, ny, nz, r, g, bl);
        this.push(p[0] + n1x * radius, p[1] + n1y * radius, p[2] + n1z * radius, nx, ny, nz, r, g, bl);
        this.idx.push(c, c + 1, c + 2);
      }
    }
  }

  /** Flat quad on the ground plane. */
  groundQuad(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const base = this.vertexCount;
    this.push(x0, y, z0, 0, 1, 0, r, g, b);
    this.push(x1, y, z0, 0, 1, 0, r, g, b);
    this.push(x1, y, z1, 0, 1, 0, r, g, b);
    this.push(x0, y, z1, 0, 1, 0, r, g, b);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Vertical quad spanning two ground points, with the colour graded from
   * bottom to top. Used for the sky bands, where the gradient is the point.
   */
  bandQuad(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    yBottom: number,
    yTop: number,
    bottom: readonly [number, number, number],
    top: readonly [number, number, number],
  ): void {
    const base = this.vertexCount;
    this.push(x0, yBottom, z0, 0, 0, 1, bottom[0], bottom[1], bottom[2]);
    this.push(x1, yBottom, z1, 0, 0, 1, bottom[0], bottom[1], bottom[2]);
    this.push(x1, yTop, z1, 0, 0, 1, top[0], top[1], top[2]);
    this.push(x0, yTop, z0, 0, 0, 1, top[0], top[1], top[2]);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Arbitrary quad with a colour per corner. Used for the sky dome. */
  quadColored(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    ca: readonly [number, number, number],
    cb: readonly [number, number, number],
    cc: readonly [number, number, number],
    cd: readonly [number, number, number],
  ): void {
    const base = this.vertexCount;
    const pts = [a, b, c, d];
    const cols = [ca, cb, cc, cd];
    for (let i = 0; i < 4; i++) {
      const p = pts[i]!;
      const col = cols[i]!;
      this.push(p[0]!, p[1]!, p[2]!, 0, 1, 0, col[0]!, col[1]!, col[2]!);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Vertical tube: a round shaft, open top and bottom.
   *
   * `tube` below points along a ground axis, which is a thing you fly through.
   * This one you drop down, and it needs its own builder rather than a rotation
   * because the whole mesh is authored axis-aligned.
   */
  shaft(
    cx: number,
    cz: number,
    yBase: number,
    yTop: number,
    radius: number,
    thickness: number,
    segments: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const outer = radius + thickness;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const at = (ang: number, rad: number, y: number): [number, number, number] => [
        cx + Math.cos(ang) * rad,
        y,
        cz + Math.sin(ang) * rad,
      ];
      const shade = (f: number): [number, number, number] => [r * f, g * f, b * f];
      // Outer skin, inner skin, and a rim at each end so the wall has thickness
      // from every angle rather than vanishing when seen edge-on.
      this.quadColored(
        at(a0, outer, yBase), at(a1, outer, yBase), at(a1, outer, yTop), at(a0, outer, yTop),
        shade(1), shade(1), shade(1), shade(1),
      );
      this.quadColored(
        at(a0, radius, yTop), at(a1, radius, yTop), at(a1, radius, yBase), at(a0, radius, yBase),
        shade(0.55), shade(0.55), shade(0.55), shade(0.55),
      );
      for (const [y, f] of [[yBase, 0.7], [yTop, 0.9]] as [number, number][]) {
        this.quadColored(
          at(a0, radius, y), at(a1, radius, y), at(a1, outer, y), at(a0, outer, y),
          shade(f), shade(f), shade(f), shade(f),
        );
      }
    }
  }

  /**
   * Horizontal tube, open down the bore. `along` is the render axis it points
   * down. Built as an outer skin, an inner skin with the normals reversed, and
   * a ring at each end, so it reads as a solid wall from any side.
   */
  tube(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    thickness: number,
    halfLength: number,
    along: 'x' | 'z',
    segments: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const outer = radius + thickness;
    const at = (ang: number, rad: number, off: number): [number, number, number] =>
      along === 'z'
        ? [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, cz + off]
        : [cx + off, cy + Math.sin(ang) * rad, cz + Math.cos(ang) * rad];

    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const shade = (f: number): [number, number, number] => [r * f, g * f, b * f];
      // Outer skin, inner skin, and the two end faces.
      this.quadColored(
        at(a0, outer, -halfLength), at(a1, outer, -halfLength),
        at(a1, outer, halfLength), at(a0, outer, halfLength),
        shade(1), shade(1), shade(1), shade(1),
      );
      this.quadColored(
        at(a0, radius, halfLength), at(a1, radius, halfLength),
        at(a1, radius, -halfLength), at(a0, radius, -halfLength),
        shade(0.55), shade(0.55), shade(0.55), shade(0.55),
      );
      for (const [off, f] of [[-halfLength, 0.8], [halfLength, 0.8]] as [number, number][]) {
        this.quadColored(
          at(a0, radius, off), at(a1, radius, off),
          at(a1, outer, off), at(a0, outer, off),
          shade(f), shade(f), shade(f), shade(f),
        );
      }
    }
  }

  build(): MeshData {
    return {
      vertices: Float32Array.from(this.verts),
      indices: Uint32Array.from(this.idx),
    };
  }
}

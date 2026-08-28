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

  build(): MeshData {
    return {
      vertices: Float32Array.from(this.verts),
      indices: Uint32Array.from(this.idx),
    };
  }
}

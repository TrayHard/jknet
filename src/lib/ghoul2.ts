/** Ghoul2 v6 reader. Offsets and packed weights follow OpenJK mdx_format.h.
 * Animation matrices deform bind-space vertices directly, unlike glTF joints.
 */
import { Matrix4, Quaternion, Vector3 } from "three";

class Binary {
  view: DataView;
  constructor(public buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }
  range(at: number, size: number) {
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      size < 0 ||
      at + size > this.buffer.byteLength
    )
      throw new Error("Truncated Ghoul2 resource");
  }
  int(at: number) {
    this.range(at, 4);
    return this.view.getInt32(at, true);
  }
  uint(at: number) {
    this.range(at, 4);
    return this.view.getUint32(at, true);
  }
  float(at: number) {
    this.range(at, 4);
    const n = this.view.getFloat32(at, true);
    if (!Number.isFinite(n)) throw new Error("Invalid model coordinate");
    return n;
  }
  str(at: number, count = 64) {
    this.range(at, count);
    return new TextDecoder()
      .decode(new Uint8Array(this.buffer, at, count))
      .split("\0")[0]
      .toLowerCase();
  }
  count(at: number, max: number) {
    const n = this.int(at);
    if (n < 0 || n > max)
      throw new Error("Ghoul2 resource exceeds preview limits");
    return n;
  }
}

export interface Surface {
  name: string;
  shader: string;
  flags: number;
  parent: number;
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array;
  indices: Uint32Array;
  bones: Uint16Array;
  weights: Float32Array;
}
export interface GhoulMesh {
  animation: string;
  boneCount: number;
  surfaces: Surface[];
}
export function readGlm(buffer: ArrayBuffer): GhoulMesh {
  const r = new Binary(buffer);
  if (r.str(0, 4) !== "2lgm" || r.int(4) !== 6)
    throw new Error("Unsupported Ghoul2 model version");
  const count = r.count(152, 4096),
    boneCount = r.count(140, 1024),
    lod = r.int(148);
  r.range(0, r.int(160));
  const surfaces: Surface[] = [];
  let totalVertices = 0;
  for (let i = 0; i < count; i++) {
    const h = 164 + r.int(164 + i * 4),
      at = lod + 4 + r.int(lod + 4 + i * 4);
    const n = r.count(at + 12, 100000),
      tri = r.count(at + 20, 200000),
      refs = r.count(at + 28, 32);
    totalVertices += n;
    if (totalVertices > 500000) throw new Error("Model has too many vertices");
    const v = at + r.int(at + 16),
      t = at + r.int(at + 24),
      b = at + r.int(at + 32);
    r.range(v, n * 40);
    r.range(t, tri * 12);
    r.range(b, refs * 4);
    const s: Surface = {
      name: r.str(h),
      flags: r.int(h + 64),
      shader: r.str(h + 68),
      parent: r.int(h + 136),
      positions: new Float32Array(n * 3),
      normals: new Float32Array(n * 3),
      uv: new Float32Array(n * 2),
      indices: new Uint32Array(tri * 3),
      bones: new Uint16Array(n * 4),
      weights: new Float32Array(n * 4),
    };
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < 3; k++) {
        s.normals[j * 3 + k] = r.float(v + j * 32 + k * 4);
        s.positions[j * 3 + k] = r.float(v + j * 32 + 12 + k * 4);
      }
      s.uv[j * 2] = r.float(v + n * 32 + j * 8);
      s.uv[j * 2 + 1] = 1 - r.float(v + n * 32 + j * 8 + 4);
      const packed = r.uint(v + j * 32 + 24),
        weights = (packed >>> 30) + 1;
      let sum = 0;
      for (let k = 0; k < weights; k++) {
        const ref = (packed >>> (k * 5)) & 31;
        if (ref >= refs) throw new Error("Invalid bone reference");
        const bone = r.int(b + ref * 4);
        if (bone < 0 || bone >= boneCount)
          throw new Error("Invalid bone index");
        const weight =
          k === weights - 1
            ? 1 - sum
            : (r.view.getUint8(v + j * 32 + 28 + k) |
                ((packed >>> (12 + k * 2)) & 0x300)) /
              1023;
        if (weight < -0.001) throw new Error("Invalid vertex weights");
        s.bones[j * 4 + k] = bone;
        s.weights[j * 4 + k] = Math.max(0, weight);
        sum += weight;
      }
    }
    for (let j = 0; j < tri * 3; j++) {
      const index = r.int(t + j * 4);
      if (index < 0 || index >= n) throw new Error("Invalid triangle index");
      s.indices[j] = index;
    }
    // Ghoul2 front faces are clockwise (OpenJK GL_Cull uses GL_FRONT).
    // Three.js expects counter-clockwise triangles.
    for (let j = 0; j < s.indices.length; j += 3)
      [s.indices[j + 1], s.indices[j + 2]] = [
        s.indices[j + 2],
        s.indices[j + 1],
      ];
    surfaces.push(s);
  }
  return { animation: r.str(72), boneCount, surfaces };
}

export interface Clip {
  name: string;
  first: number;
  count: number;
  fps: number;
  loop: number;
}

/** OpenJK OldToNewRemapTable (tr_ghoul2.cpp:3842), JK2 humanoid -> JKA. */
const OLD_HUMANOID_BONES = [
  0,1,2,3,4,5,6,6,7,8,9,10,10,11,12,13,14,15,16,17,18,19,20,21,
  22,23,24,25,26,27,28,29,29,34,35,35,30,31,31,32,33,33,32,33,33,34,
  35,35,36,37,38,39,40,41,42,42,43,44,44,43,44,44,45,46,46,45,46,46,
  47,48,48,52,
] as const;

export function matchSkeleton(mesh: GhoulMesh, animation: GhoulAnimation) {
  if (mesh.boneCount === 72 && animation.count === 53 && mesh.animation.includes("_humanoid")) {
    for (const surface of mesh.surfaces)
      for (let i = 0; i < surface.bones.length; i++)
        surface.bones[i] = OLD_HUMANOID_BONES[surface.bones[i]];
    mesh.boneCount = 53;
  }
  if (animation.count < mesh.boneCount) throw new Error("Skeleton does not match model");
}
export function readClips(text: string): Clip[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const p = line.trim().split(/\s+/);
    if (p.length < 5 || !/^(BOTH|TORSO|LEGS)_/.test(p[0])) return [];
    const [first, count, loop, fps] = p.slice(1, 5).map(Number);
    return [first, count, loop, fps].every(Number.isFinite) &&
      first >= 0 &&
      count > 0 &&
      fps !== 0
      ? [{ name: p[0], first, count, loop, fps }]
      : [];
  });
}

export class GhoulAnimation {
  private r: Binary;
  readonly count: number;
  readonly frames: number;
  private parents: number[] = [];
  private matrices: Matrix4[];
  constructor(buffer: ArrayBuffer) {
    this.r = new Binary(buffer);
    const r = this.r;
    if (r.str(0, 4) !== "2lga" || r.int(4) !== 6)
      throw new Error("Unsupported Ghoul2 animation version");
    this.count = r.count(84, 1024);
    this.frames = r.count(76, 1000000);
    r.range(r.int(80), this.count * this.frames * 3);
    for (let i = 0; i < this.count; i++) {
      const at = 100 + r.int(100 + i * 4),
        parent = r.int(at + 68);
      if (parent < -1 || parent >= this.count || parent === i)
        throw new Error("Invalid skeleton hierarchy");
      this.parents.push(parent);
    }
    this.matrices = this.parents.map(() => new Matrix4());
    for (let i = 0; i < this.count; i++) {
      let at = i,
        depth = 0;
      while (at >= 0) {
        if (++depth > this.count) throw new Error("Cyclic skeleton hierarchy");
        at = this.parents[at];
      }
    }
  }
  pose(frame: number): Matrix4[] {
    const r = this.r,
      start = Math.min(this.frames - 1, Math.max(0, Math.floor(frame))),
      end = Math.min(start + 1, this.frames - 1),
      frac = frame - Math.floor(frame);
    const local = (f: number, bone: number) => {
      const at = r.int(80) + (f * this.count + bone) * 3;
      const index =
          r.view.getUint8(at) |
          (r.view.getUint8(at + 1) << 8) |
          (r.view.getUint8(at + 2) << 16),
        p = r.int(88) + index * 14;
      r.range(p, 14);
      const q = (i: number) => r.view.getUint16(p + i * 2, true) / 16383 - 2;
      const pos = new Vector3(
        ...([4, 5, 6].map(
          (i) => r.view.getUint16(p + i * 2, true) / 64 - 512,
        ) as [number, number, number]),
      );
      return { pos, rot: new Quaternion(q(1), q(2), q(3), q(0)).normalize() };
    };
    const ready = new Set<number>();
    const evaluate = (i: number) => {
      if (ready.has(i)) return;
      if (this.parents[i] >= 0) evaluate(this.parents[i]);
      const a = local(start, i),
        b = local(end, i);
      const matrix = this.matrices[i].compose(
        a.pos.lerp(b.pos, frac),
        a.rot.slerp(b.rot, frac),
        new Vector3(1, 1, 1),
      );
      if (this.parents[i] >= 0)
        matrix.premultiply(this.matrices[this.parents[i]]);
      ready.add(i);
    };
    for (let i = 0; i < this.count; i++) evaluate(i);
    return this.matrices;
  }
}

export function deform(
  surface: Surface,
  matrices: Matrix4[],
  positions: Float32Array,
  normals: Float32Array,
) {
  const p = new Vector3(),
    n = new Vector3();
  positions.fill(0);
  normals.fill(0);
  for (let i = 0; i < positions.length / 3; i++)
    for (let w = 0; w < 4; w++) {
      const weight = surface.weights[i * 4 + w];
      if (!weight) continue;
      const matrix = matrices[surface.bones[i * 4 + w]];
      if (!matrix) throw new Error("Skeleton does not match model");
      p.fromArray(surface.positions, i * 3).applyMatrix4(matrix);
      n.fromArray(surface.normals, i * 3).transformDirection(matrix);
      positions[i * 3] += p.x * weight;
      positions[i * 3 + 1] += p.y * weight;
      positions[i * 3 + 2] += p.z * weight;
      normals[i * 3] += n.x * weight;
      normals[i * 3 + 1] += n.y * weight;
      normals[i * 3 + 2] += n.z * weight;
    }
}

/** Native attachment axes from G2_ProcessSurfaceBolt2, before GetBoltMatrix's world-axis swap. */
export function surfaceBolt(positions: Float32Array, target = new Matrix4()): Matrix4 {
  if (positions.length < 9) throw new Error("Attachment tag is missing its triangle");
  const a = new Vector3().fromArray(positions),
    b = new Vector3().fromArray(positions, 3),
    origin = new Vector3().fromArray(positions, 6);
  const long = b.sub(a).normalize(), short = a.sub(origin).normalize();
  const normal = new Vector3().crossVectors(long, short).normalize().negate();
  long.addScaledVector(short, -long.dot(short)).normalize();
  return target.makeBasis(short, long, normal).setPosition(origin);
}

/** Quake text blocks with nested shader stages; comments never become tokens. */
export function blocks(text: string): Map<string, string> {
  const tokens =
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .match(/"[^"\r\n]*"|[{}]|[^\s{}]+/g) ?? [];
  const result = new Map<string, string>();
  for (let i = 0; i < tokens.length - 1; i++)
    if (tokens[i + 1] === "{") {
      const name = tokens[i].replace(/"/g, "").toLowerCase();
      i += 2;
      let depth = 1;
      const body: string[] = [];
      while (i < tokens.length && depth) {
        const token = tokens[i++];
        if (token === "{") depth++;
        if (token === "}") depth--;
        if (depth) body.push(token);
      }
      i--;
      result.set(name, body.join(" "));
    }
  return result;
}

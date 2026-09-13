import type { GhoulMesh, Surface } from "./ghoul2";

/** Static first-frame MD3 preview; layout follows OpenJK qfiles.h. */
export function readMd3(buffer: ArrayBuffer): GhoulMesh {
  const view = new DataView(buffer);
  const range = (at: number, size: number, end = buffer.byteLength) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at + size > end)
      throw new Error("Truncated MD3 model");
  };
  const int = (at: number) => { range(at, 4); return view.getInt32(at, true); };
  const count = (at: number, max: number) => {
    const n = int(at);
    if (n < 0 || n > max) throw new Error("MD3 model exceeds preview limits");
    return n;
  };
  const str = (at: number, n: number) => {
    range(at, n);
    return new TextDecoder().decode(new Uint8Array(buffer, at, n)).split("\0")[0].toLowerCase();
  };
  range(0, 108);
  if (str(0, 4) !== "idp3" || int(4) !== 15) throw new Error("Unsupported MD3 model version");
  const end = int(104), frames = count(76, 4096), total = count(84, 256);
  range(0, end);
  if (end < 108 || frames < 1) throw new Error("Empty MD3 model");
  let at = int(100), vertices = 0;
  range(at, 0, end);
  if (at < 108) throw new Error("Invalid MD3 surface offset");
  const surfaces: Surface[] = [];
  for (let i = 0; i < total; i++) {
    range(at, 108, end);
    if (str(at, 4) !== "idp3") throw new Error("Invalid MD3 surface");
    const next = at + int(at + 104), n = count(at + 80, 100_000), triangles = count(at + 84, 200_000);
    const shaders = count(at + 76, 256), surfaceFrames = count(at + 72, 4096);
    if (next <= at + 107 || next > end || surfaceFrames !== frames) throw new Error("Invalid MD3 surface size");
    vertices += n;
    if (vertices > 500_000) throw new Error("MD3 model has too many vertices");
    const offset = (field: number, bytes: number) => {
      const pos = at + int(at + field);
      if (pos < at + 108) throw new Error("Invalid MD3 surface offset");
      range(pos, bytes, next);
      return pos;
    };
    const tri = offset(88, triangles * 12), shader = offset(92, shaders * 68);
    const uv = offset(96, n * 8), xyz = offset(100, n * surfaceFrames * 8);
    const surface: Surface = {
      name: str(at + 4, 64), shader: shaders ? str(shader, 64) : "", flags: 0, parent: -1,
      positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), uv: new Float32Array(n * 2),
      indices: new Uint32Array(triangles * 3), bones: new Uint16Array(n * 4), weights: new Float32Array(n * 4),
    };
    for (let v = 0; v < n; v++) {
      for (let axis = 0; axis < 3; axis++) surface.positions[v * 3 + axis] = view.getInt16(xyz + v * 8 + axis * 2, true) / 64;
      const packed = view.getUint16(xyz + v * 8 + 6, true);
      const latitude = (packed >> 8) * Math.PI * 2 / 256, longitude = (packed & 255) * Math.PI * 2 / 256;
      surface.normals.set([Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude) * Math.sin(longitude), Math.cos(longitude)], v * 3);
      const u = view.getFloat32(uv + v * 8, true), w = view.getFloat32(uv + v * 8 + 4, true);
      if (!Number.isFinite(u) || !Number.isFinite(w)) throw new Error("Invalid MD3 texture coordinate");
      surface.uv.set([u, 1 - w], v * 2);
    }
    for (let t = 0; t < triangles * 3; t++) {
      const vertex = int(tri + t * 4);
      if (vertex < 0 || vertex >= n) throw new Error("Invalid MD3 triangle index");
      surface.indices[t] = vertex;
    }
    for (let t = 0; t < surface.indices.length; t += 3)
      [surface.indices[t + 1], surface.indices[t + 2]] = [surface.indices[t + 2], surface.indices[t + 1]];
    surfaces.push(surface);
    at = next;
  }
  return { animation: "", boneCount: 0, surfaces };
}

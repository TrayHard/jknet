/** Raven BSP v1, shared by Jedi Academy and Jedi Outcast.
 * Layout: OpenJK qfiles.h. Coordinates rotate from game Z-up to viewer Y-up.
 * This reader is pure data processing so it can run in a cancellable worker.
 */
export interface MapShader { name: string; flags: number }
export interface MapBatch {
  shader: number; lightmap: number; positions: Float32Array; normals: Float32Array;
  uv: Float32Array; lightUv: Float32Array; colors: Float32Array; indices: Uint32Array;
  clusters: Int32Array;
}
export interface MapSpawn { position: number[]; yaw: number; pitch: number }
export interface BspMap {
  shaders: MapShader[]; batches: MapBatch[]; lightmaps: Uint8Array;
  spawns: MapSpawn[]; title: string; bounds: number[];
  planes: Float32Array; nodes: Int32Array; leafClusters: Int32Array;
  visibility: Uint8Array; clusterBytes: number; clusterCount: number;
}
type Geometry = Omit<MapBatch, "shader" | "lightmap" | "clusters">;
const MAX_VERTICES = 3_000_000;
const MAX_INDICES = 12_000_000;
const MAX_LIGHTMAPS = 512;

function fail(): never { throw new Error("Invalid BSP map data"); }
function limited(): never { throw new Error("Map exceeds preview limits"); }
function range(at: number, count: number, length: number) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(count) || at < 0 || count < 0 || at + count > length) fail();
}
function vec(value: string | undefined): number[] {
  const parts = (value ?? "0 0 0").trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every(n => Number.isFinite(n) && Math.abs(n) < 1e7) ? parts : [0, 0, 0];
}
const rotate = ([x, y, z]: number[]) => [x, z, -y];
export function mapEntities(text: string): Record<string, string>[] {
  const tokens = text.replace(/\/\/[^\n]*/g, "").match(/"(?:[^"\\]|\\.)*"|[{}]|[^\s{}]+/g) ?? [];
  const entries: Record<string, string>[] = [];
  let entry: Record<string, string> | null = null;
  const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/\\"/g, '"');
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "{") entry = Object.create(null) as Record<string, string>;
    else if (tokens[i] === "}") { if (entry) entries.push(entry); entry = null; }
    else if (entry && i + 1 < tokens.length && tokens[i + 1] !== "}") entry[unquote(tokens[i]).toLowerCase()] = unquote(tokens[++i]);
  }
  return entries;
}

export function readBsp(buffer: ArrayBuffer): BspMap {
  if (buffer.byteLength > 128 * 1024 * 1024) limited();
  range(0, 152, buffer.byteLength);
  const view = new DataView(buffer);
  const int = (at: number) => view.getInt32(at, true);
  const float = (at: number) => {
    const value = view.getFloat32(at, true);
    if (!Number.isFinite(value) || Math.abs(value) > 1e8) fail();
    return value;
  };
  const string = (at: number, count: number) => new TextDecoder().decode(new Uint8Array(buffer, at, count)).split("\0")[0];
  if (string(0, 4) !== "RBSP" || int(4) !== 1) throw new Error("Unsupported BSP map format");
  const lumps = Array.from({ length: 18 }, (_, i) => {
    const at = int(8 + i * 8), length = int(12 + i * 8);
    range(at, length, buffer.byteLength);
    if (length && at < 152) fail();
    return { at, length };
  });
  const occupied = lumps.filter(lump => lump.length).sort((a, b) => a.at - b.at);
  for (let i = 1; i < occupied.length; i++) if (occupied[i].at < occupied[i - 1].at + occupied[i - 1].length) fail();
  const count = (id: number, stride: number, max: number) => {
    const value = lumps[id].length / stride;
    if (!Number.isInteger(value)) fail();
    if (value > max) limited();
    return value;
  };
  const vertexCount = count(10, 80, 1_500_000), indexCount = count(11, 4, MAX_INDICES);
  const surfaceCount = count(13, 148, 150_000), modelCount = count(7, 40, 4096);
  const shaderCount = count(1, 72, 8192), lightmapCount = count(14, 128 * 128 * 3, MAX_LIGHTMAPS);
  const planeCount = count(2, 16, 500_000), nodeCount = count(3, 36, 250_000);
  const leafCount = count(4, 48, 250_000), leafSurfaceCount = count(5, 4, 2_000_000);
  if (!vertexCount || !surfaceCount || !modelCount || !shaderCount) fail();
  if (lumps[0].length > 2 * 1024 * 1024 || lumps[16].length > 16 * 1024 * 1024) limited();
  const entities = mapEntities(string(lumps[0].at, lumps[0].length));
  const world = entities.find(e => e.classname === "worldspawn");
  const shaders = Array.from({ length: shaderCount }, (_, i) => ({
    name: string(lumps[1].at + i * 72, 64).replace(/\\/g, "/").toLowerCase(), flags: int(lumps[1].at + i * 72 + 64),
  }));
  const planes = new Float32Array(planeCount * 4), nodes = new Int32Array(nodeCount * 3), leafClusters = new Int32Array(leafCount);
  for (let i = 0; i < planes.length; i++) planes[i] = float(lumps[2].at + i * 4);
  for (let i = 0; i < nodeCount; i++) {
    const at = lumps[3].at + i * 36;
    range(int(at), 1, planeCount);
    nodes[i * 3] = int(at);
    for (let j = 1; j <= 2; j++) {
      const child = int(at + j * 4);
      range(child < 0 ? -child - 1 : child, 1, child < 0 ? leafCount : nodeCount);
      nodes[i * 3 + j] = child;
    }
  }
  // Reject cycles/deep trees before camera movement ever traverses them.
  const state = new Uint8Array(nodeCount), stack = nodeCount ? [[0, 0, 0]] : [];
  while (stack.length) {
    const [node, depth, done] = stack.pop()!;
    if (done) { state[node] = 2; continue; }
    if (state[node] === 1 || depth > 128) fail();
    if (state[node] === 2) continue;
    state[node] = 1; stack.push([node, depth, 1]);
    for (const child of [nodes[node * 3 + 1], nodes[node * 3 + 2]]) if (child >= 0) stack.push([child, depth + 1, 0]);
  }
  let clusterCount = 0, clusterBytes = 0, visibility = new Uint8Array(0);
  if (lumps[16].length) {
    if (lumps[16].length < 8) fail();
    clusterCount = int(lumps[16].at); clusterBytes = int(lumps[16].at + 4);
    if (clusterCount < 0 || clusterCount > 100_000 || clusterBytes < Math.ceil(clusterCount / 8)) fail();
    range(8, clusterCount * clusterBytes, lumps[16].length);
    visibility = new Uint8Array(buffer.slice(lumps[16].at + 8, lumps[16].at + 8 + clusterCount * clusterBytes));
  }
  const clusters = Array.from({ length: surfaceCount }, () => new Set<number>());
  let leafReferences = 0;
  for (let i = 0; i < leafCount; i++) {
    const at = lumps[4].at + i * 48, cluster = int(at), first = int(at + 32), total = int(at + 36);
    if (cluster < -1 || (clusterCount && cluster >= clusterCount)) fail();
    leafClusters[i] = cluster;
    range(first, total, leafSurfaceCount);
    leafReferences += total;
    if (leafReferences > 8_000_000) limited();
    for (let j = 0; j < total; j++) {
      const surface = int(lumps[5].at + (first + j) * 4);
      range(surface, 1, surfaceCount);
      if (cluster >= 0) clusters[surface].add(cluster);
    }
  }
  const owners = new Int32Array(surfaceCount).fill(-1), offsets: number[][] = [];
  for (let i = 0; i < modelCount; i++) {
    const at = lumps[7].at + i * 40, first = int(at + 24), total = int(at + 28);
    range(first, total, surfaceCount);
    offsets.push(rotate(vec(entities.find(e => e.model === `*${i}`)?.origin)));
    for (let j = first; j < first + total; j++) { if (owners[j] !== -1) fail(); owners[j] = i; }
  }
  const bounds = [float(lumps[7].at), float(lumps[7].at + 8), -float(lumps[7].at + 16),
    float(lumps[7].at + 12), float(lumps[7].at + 20), -float(lumps[7].at + 4)];
  if (bounds.slice(0, 3).some((min, i) => min > bounds[i + 3])) fail();
  const spawns = entities.filter(e => /^info_player_(?:deathmatch|start|duel|intermission|siege)/.test(e.classname ?? ""))
    .sort((a, b) => Number(a.classname === "info_player_intermission") - Number(b.classname === "info_player_intermission"))
    .slice(0, 256).map(entity => {
      const position = rotate(vec(entity.origin)); position[1] += 26;
      const angles = vec(entity.angles), angle = Number(entity.angle ?? angles[1]);
      return { position, yaw: ((Number.isFinite(angle) && angle >= 0 ? angle : 0) - 90) * Math.PI / 180,
        pitch: -angles[0] * Math.PI / 180 };
    });
  let vertexBudget = MAX_VERTICES, indexBudget = MAX_INDICES;
  const reserve = (vertices: number, indices: number) => {
    if (vertices > vertexBudget || indices > indexBudget) limited();
    vertexBudget -= vertices; indexBudget -= indices;
  };
  const geometry = (vertices: number, indices: number): Geometry => ({
    positions: new Float32Array(vertices * 3), normals: new Float32Array(vertices * 3),
    uv: new Float32Array(vertices * 2), lightUv: new Float32Array(vertices * 2),
    colors: new Float32Array(vertices * 3), indices: new Uint32Array(indices),
  });
  const vertex = (target: Geometry, to: number, from: number, weight: number, offset: number[], lit: boolean) => {
    const at = lumps[10].at + from * 80;
    const p = [float(at), float(at + 8), -float(at + 4)], n = [float(at + 52), float(at + 60), -float(at + 56)];
    const rgb = [view.getUint8(at + 64), view.getUint8(at + 65), view.getUint8(at + 66)];
    const maximum = Math.max(255, ...rgb.map(v => v * 4));
    for (let j = 0; j < 3; j++) {
      target.positions[to * 3 + j] += (p[j] + offset[j]) * weight;
      target.normals[to * 3 + j] += n[j] * weight;
      target.colors[to * 3 + j] += rgb[j] * 4 / maximum * weight;
    }
    for (let j = 0; j < 2; j++) {
      target.uv[to * 2 + j] += float(at + 12 + j * 4) * weight;
      // Vertex-lit surfaces may carry uninitialised, unused lightmap coordinates.
      if (lit) target.lightUv[to * 2 + j] += float(at + 20 + j * 4) * weight;
    }
  };
  const groups = new Map<string, { shader: number; lightmap: number; parts: Geometry[]; clusters: Set<number> }>();
  for (let i = 0; i < surfaceCount; i++) {
    const at = lumps[13].at + i * 148, shader = int(at), type = int(at + 8);
    range(shader, 1, shaderCount);
    if (type < 1 || type > 4) fail();
    if (owners[i] < 0 || type === 4 || (shaders[shader].flags & (0x200000 | 0x2000))) continue;
    const first = int(at + 12), total = int(at + 16), firstIndex = int(at + 20), totalIndices = int(at + 24);
    range(first, total, vertexCount); range(firstIndex, totalIndices, indexCount);
    const lightmap = int(at + 36);
    if (lightmap >= lightmapCount) fail();
    const offset = offsets[owners[i]];
    let part: Geometry;
    if (type === 2) {
      const width = int(at + 140), height = int(at + 144);
      if (width < 3 || height < 3 || width > 33 || height > 33 || !(width % 2) || !(height % 2) || width * height !== total) fail();
      const steps = 4, columns = (width - 1) / 2 * steps + 1, rows = (height - 1) / 2 * steps + 1;
      reserve(columns * rows, (columns - 1) * (rows - 1) * 6);
      part = geometry(columns * rows, (columns - 1) * (rows - 1) * 6);
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const bx = Math.min(Math.floor(x / steps), (width - 3) / 2), by = Math.min(Math.floor(y / steps), (height - 3) / 2);
        const u = x / steps - bx, v = y / steps - by;
        const bu = [(1 - u) ** 2, 2 * u * (1 - u), u * u], bv = [(1 - v) ** 2, 2 * v * (1 - v), v * v];
        for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) vertex(part, y * columns + x, first + (by * 2 + yy) * width + bx * 2 + xx, bu[xx] * bv[yy], offset, lightmap >= 0);
      }
      let index = 0;
      for (let y = 0; y < rows - 1; y++) for (let x = 0; x < columns - 1; x++) {
        const a = y * columns + x, b = a + 1, c = a + columns, d = c + 1;
        part.indices.set([a, c, b, b, c, d], index); index += 6;
      }
    } else {
      if (totalIndices % 3) fail();
      reserve(total, totalIndices); part = geometry(total, totalIndices);
      for (let j = 0; j < total; j++) vertex(part, j, first + j, 1, offset, lightmap >= 0);
      for (let j = 0; j < totalIndices; j++) {
        const index = int(lumps[11].at + (firstIndex + j) * 4);
        range(index, 1, total); part.indices[j] = index;
      }
    }
    // Respect authored normals rather than relying on the source winding convention.
    for (let j = 0; j < part.indices.length; j += 3) {
      const a = part.indices[j] * 3, b = part.indices[j + 1] * 3, c = part.indices[j + 2] * 3, p = part.positions, n = part.normals;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      if ((uy * vz - uz * vy) * n[a] + (uz * vx - ux * vz) * n[a + 1] + (ux * vy - uy * vx) * n[a + 2] < 0)
        [part.indices[j + 1], part.indices[j + 2]] = [part.indices[j + 2], part.indices[j + 1]];
    }
    if (!part.indices.length) continue;
    const cell = [0, 1, 2].map(axis => Math.floor(part.positions[axis] / 1024)).join(":");
    const key = `${shader}:${lightmap}:${owners[i] ? "inline" : cell}`;
    let group = groups.get(key);
    if (!group) { group = { shader, lightmap, parts: [], clusters: new Set() }; groups.set(key, group); }
    group.parts.push(part);
    if (owners[i]) group.clusters.add(-1);
    else for (const cluster of clusters[i]) group.clusters.add(cluster);
  }
  const batches: MapBatch[] = [];
  for (const group of groups.values()) {
    const total = group.parts.reduce((sum, part) => sum + part.positions.length / 3, 0);
    const indices = group.parts.reduce((sum, part) => sum + part.indices.length, 0);
    const merged = geometry(total, indices);
    let vertexAt = 0, indexAt = 0;
    for (const part of group.parts) {
      for (const key of ["positions", "normals", "uv", "lightUv", "colors"] as const)
        merged[key].set(part[key], vertexAt * (key === "uv" || key === "lightUv" ? 2 : 3));
      for (const index of part.indices) merged.indices[indexAt++] = index + vertexAt;
      vertexAt += part.positions.length / 3;
    }
    batches.push({ shader: group.shader, lightmap: group.lightmap, ...merged, clusters: Int32Array.from(group.clusters) });
  }
  if (!batches.length) throw new Error("Map contains no visible geometry");
  return { shaders, batches, lightmaps: new Uint8Array(buffer.slice(lumps[14].at, lumps[14].at + lumps[14].length)),
    spawns, bounds, title: world?.message ?? "", planes, nodes, leafClusters, visibility, clusterBytes, clusterCount };
}

/** Camera leaf in native game coordinates; outside/PVS-free maps draw normally. */
export function mapCluster(map: BspMap, position: { x: number; y: number; z: number }): number {
  if (!map.nodes.length || !map.visibility.length) return -1;
  let node = 0;
  for (let depth = 0; depth <= 128; depth++) {
    if (node < 0) return map.leafClusters[-node - 1] ?? -1;
    const plane = map.nodes[node * 3] * 4;
    const distance = position.x * map.planes[plane] - position.z * map.planes[plane + 1] + position.y * map.planes[plane + 2] - map.planes[plane + 3];
    node = map.nodes[node * 3 + (distance >= 0 ? 1 : 2)];
  }
  return -1;
}
export function mapBatchVisible(map: BspMap, batch: MapBatch, cluster: number) {
  if (cluster < 0 || !batch.clusters.length || !map.visibility.length) return true;
  return batch.clusters.some(other => other < 0 || other === cluster || (map.visibility[cluster * map.clusterBytes + (other >> 3)] & (1 << (other & 7))) !== 0);
}

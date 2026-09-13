import * as THREE from "three";
import { blocks } from "./ghoul2";
import { mapBatchVisible, mapCluster, type BspMap } from "./bsp";
import type { PreviewAsset } from "./ipc";

export type MapLoad = (names: string[]) => Promise<PreviewAsset[]>;
interface MaterialSpec {
  image: string | null; sky: string | null; skip: boolean; vertex: boolean;
  alphaTest: number; opacity: number; blend: "normal" | "add" | "filter" | null;
  doubleSided: boolean; color: number[] | null; scale: number[]; polygonOffset: boolean;
}
const extensions = [".tga", ".jpg", ".png", ".jpeg"];
const clean = (name: string) => name.replace(/\\/g, "/").replace(/^"|"$/g, "").toLowerCase();
const safe = (name: string) => !!name && !name.startsWith("/") && !name.includes("..") && !/[\x00-\x1f:$*]/.test(name);
const imageBase = (name: string) => clean(name).replace(/\.(?:tga|jpg|png|jpeg)$/i, "");

/** Only the base layer is needed for navigation; game scripts are never run. */
export function mapMaterial(body: string, name: string, flags: number): MaterialSpec {
  const stages = [...body.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]);
  const stageImage = (stage: string) => stage.match(/\b(?:map|clampmap)\s+(\S+)/i)?.[1]
    ?? stage.match(/\b(?:animmap|oneshotanimmap)\s+\S+\s+(\S+)/i)?.[1];
  const imageStage = stages.find(stage => {
    const path = stageImage(stage);
    return path && (safe(clean(path)) || path.toLowerCase() === "$whiteimage");
  });
  const path = imageStage ? stageImage(imageStage) : undefined;
  const white = path?.toLowerCase() === "$whiteimage";
  const videoPoster = /\bvideomap\s/i.test(body) ? body.match(/\bqer_editorimage\s+(\S+)/i)?.[1] : undefined;
  const base = white ? "" : imageBase(path ?? videoPoster ?? name);
  const sky = body.match(/\bskyparms\s+(\S+)/i)?.[1];
  const hasLightmap = /\bmap\s+\$lightmap/i.test(body);
  const stage = imageStage ?? stages[0] ?? "";
  const alpha = stage.match(/\balphagen\s+const\s+([\d.]+)/i);
  const color = stage.match(/\brgbgen\s+const\s+\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/i);
  const blend = !hasLightmap && /\bblendfunc\s+(?:add|gl_one\s+gl_one)/i.test(stage) ? "add"
    : !hasLightmap && /\bblendfunc\s+(?:filter|gl_dst_color\s+gl_zero)/i.test(stage) ? "filter"
    : /\bblendfunc\s+(?:blend|gl_src_alpha\s+gl_one_minus_src_alpha)/i.test(stage) ? "normal" : null;
  const scale = stage.match(/\btcmod\s+scale\s+([-\d.]+)\s+([-\d.]+)/i);
  return {
    image: safe(base) ? base : null, sky: sky && sky !== "-" && safe(clean(sky)) ? clean(sky) : null,
    skip: !!(flags & (0x200000 | 0x2000)) || /\bsurfaceparm\s+(?:nodraw|sky|fog)\b/i.test(body),
    vertex: /\brgbgen\s+(?:vertex|exactvertex|lightingdiffuse)/i.test(stage),
    alphaTest: /\balphafunc\s+ge128/i.test(stage) ? 0.5 : /\balphafunc\s+gt0/i.test(stage) ? 0.01 : 0,
    opacity: alpha ? Math.min(1, Math.max(0, Number(alpha[1]))) : 1,
    blend, doubleSided: /\bcull\s+(?:none|disable|twosided)/i.test(body),
    color: color ? color.slice(1).map(value => Math.min(1, Math.max(0, Number(value)))) : white ? [1, 1, 1] : null,
    scale: scale ? scale.slice(1).map(Number) : [1, 1],
    polygonOffset: /\bpolygonoffset\b/i.test(body),
  };
}

export function parseMapInWorker(buffer: ArrayBuffer, signal: AbortSignal): Promise<BspMap> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./bsp.worker.ts", import.meta.url), { type: "module" });
    const stop = () => { worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { stop(); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => { stop(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.map); };
    worker.onerror = event => { stop(); reject(new Error(event.message)); };
    worker.postMessage(buffer, [buffer]);
  });
}

export async function loadMapWorld(name: string, load: MapLoad, signal: AbortSignal) {
  const [files, shaderFiles] = await Promise.all([load([name]), load(["@shaders"])]);
  signal.throwIfAborted();
  const file = files.find(asset => asset.name === name);
  if (!file?.path) throw new Error("Map resource is missing");
  const response = await fetch(file.path, { signal });
  if (!response.ok) throw new Error("Map resource is missing");
  const map = await parseMapInWorker(await response.arrayBuffer(), signal);
  const shaders = blocks(shaderFiles.map(asset => (asset.text ?? "").replace(/\\/g, "/")).join("\n"));
  const specs = map.shaders.map(shader => mapMaterial(shaders.get(shader.name) ?? "", shader.name, shader.flags));
  const used = new Set(map.batches.map(batch => batch.shader));
  const names = new Set<string>();
  for (const index of used) if (!specs[index].skip && specs[index].image) names.add(specs[index].image!);
  const sky = specs.find(spec => spec.sky)?.sky;
  // Native +X/-X/+Z/-Z/-Y/+Y become the viewer's cube faces.
  const skyNames = sky ? ["rt", "lf", "up", "dn", "ft", "bk"].map(side => `${sky}_${side}`) : [];
  skyNames.forEach(name => names.add(name));
  const assets: PreviewAsset[] = [];
  const wanted = [...names].flatMap(name => extensions.map(ext => name + ext));
  for (let i = 0; i < wanted.length; i += 128) {
    signal.throwIfAborted(); assets.push(...await load(wanted.slice(i, i + 128)));
  }
  signal.throwIfAborted();
  const paths = new Map(assets.filter(asset => asset.path).map(asset => [asset.name, asset.path!]));
  const imagePath = (base: string | null) => base ? extensions.map(ext => paths.get(base + ext)).find(Boolean) : undefined;
  const textures = new Map<string, THREE.Texture>(), bitmaps: ImageBitmap[] = [];
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [], lightmaps = new Map<number, THREE.DataTexture>();
  const uniquePaths = [...new Set([...names].map(imagePath).filter((path): path is string => !!path))];
  // The full map shares a decoded texture budget instead of uploading every image at its source size.
  const side = Math.min(1024, Math.max(32, 2 ** Math.floor(Math.log2(Math.sqrt(128 * 1024 * 1024 / Math.max(16 / 3, uniquePaths.length * 16 / 3))))));
  const dispose = () => {
    geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose()); lightmaps.forEach(texture => texture.dispose());
    bitmaps.forEach(bitmap => bitmap.close());
  };
  try {
    let next = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, uniquePaths.length) }, async () => {
      while (next < uniquePaths.length) {
        const path = uniquePaths[next++]; signal.throwIfAborted();
        let bitmap: ImageBitmap | undefined;
        try {
        const result = await fetch(path, { signal });
        if (!result.ok) continue;
        bitmap = await createImageBitmap(await result.blob());
        if (bitmap.width > side || bitmap.height > side) {
          const ratio = side / Math.max(bitmap.width, bitmap.height);
          const resized = await createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * ratio)), resizeHeight: Math.max(1, Math.round(bitmap.height * ratio)) });
          bitmap.close(); bitmap = resized;
        }
        if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
        bitmaps.push(bitmap);
        const texture = new THREE.Texture(bitmap);
        texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
        textures.set(path, texture);
        } catch (error) {
          bitmap?.close();
          if (signal.aborted) throw error;
          // One corrupt image leaves its material neutral, not the whole map blank.
        }
      }
    }));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    signal.throwIfAborted();
    const lightmap = (index: number) => {
      if (index < 0) return null;
      let texture = lightmaps.get(index);
      if (texture) return texture;
      const rgba = new Uint8Array(128 * 128 * 4), start = index * 128 * 128 * 3;
      for (let i = 0; i < 128 * 128; i++) {
        const r = map.lightmaps[start + i * 3] * 4, g = map.lightmaps[start + i * 3 + 1] * 4, b = map.lightmaps[start + i * 3 + 2] * 4;
        const scale = 255 / Math.max(255, r, g, b);
        rgba.set([r * scale, g * scale, b * scale, 255], i * 4);
      }
      texture = new THREE.DataTexture(rgba, 128, 128);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.channel = 1; texture.needsUpdate = true;
      lightmaps.set(index, texture); return texture;
    };
    const group = new THREE.Group(), materialCache = new Map<string, THREE.MeshBasicMaterial>();
    const meshes: { mesh: THREE.Mesh; batch: BspMap["batches"][number] }[] = [];
    let missing = 0;
    for (const index of used) if (!specs[index].skip && specs[index].image && !textures.has(imagePath(specs[index].image) ?? "")) missing++;
    for (const batch of map.batches) {
      const spec = specs[batch.shader]; if (spec.skip) continue;
      const key = `${batch.shader}:${batch.lightmap}`;
      let material = materialCache.get(key);
      if (!material) {
        const image = textures.get(imagePath(spec.image) ?? "");
        material = new THREE.MeshBasicMaterial({
          map: image ?? null, lightMap: lightmap(batch.lightmap), lightMapIntensity: 1,
          vertexColors: batch.lightmap < 0 && (spec.vertex || batch.lightmap === -3),
          side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
          transparent: spec.blend !== null || spec.opacity < 1,
          depthWrite: spec.blend === null && spec.opacity === 1,
          alphaTest: spec.alphaTest, opacity: spec.opacity,
          blending: spec.blend === "add" ? THREE.AdditiveBlending : spec.blend === "filter" ? THREE.MultiplyBlending : THREE.NormalBlending,
          premultipliedAlpha: spec.blend === "filter",
          polygonOffset: spec.polygonOffset, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
          color: spec.color ? new THREE.Color(...spec.color as [number, number, number]) : image ? 0xffffff : 0x8b8990,
        });
        materials.push(material); materialCache.set(key, material);
      }
      const geometry = new THREE.BufferGeometry(); geometries.push(geometry);
      geometry.setAttribute("position", new THREE.BufferAttribute(batch.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(batch.normals, 3));
      if (spec.scale[0] !== 1 || spec.scale[1] !== 1) for (let i = 0; i < batch.uv.length; i++) batch.uv[i] *= spec.scale[i % 2];
      geometry.setAttribute("uv", new THREE.BufferAttribute(batch.uv, 2));
      geometry.setAttribute("uv1", new THREE.BufferAttribute(batch.lightUv, 2));
      geometry.setAttribute("color", new THREE.BufferAttribute(batch.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(batch.indices, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material); group.add(mesh); meshes.push({ mesh, batch });
    }
    // Some maps spawn players high above the floor and let gravity place them.
    // Put the inspection camera at eye height above the first solid surface too.
    const ground = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const floors = meshes.filter(({ mesh }) => !(mesh.material as THREE.MeshBasicMaterial).transparent).map(({ mesh }) => mesh);
    for (const spawn of map.spawns) {
      ground.ray.origin.fromArray(spawn.position);
      const hit = ground.intersectObjects(floors, false).find(hit => (hit.face?.normal.y ?? 0) > 0.5);
      if (hit && hit.distance > 64) spawn.position[1] = hit.point.y + 26;
    }
    let background: THREE.CubeTexture | null = null;
    const skyImages = skyNames.map(name => textures.get(imagePath(name) ?? "")?.image);
    if (skyImages.length === 6 && skyImages.every(Boolean)) {
      background = new THREE.CubeTexture(skyImages); background.colorSpace = THREE.SRGBColorSpace; background.needsUpdate = true;
    }
    let oldCluster = -2;
    return {
      map, group, background, missing,
      update: (position: THREE.Vector3) => {
        const cluster = mapCluster(map, position);
        if (cluster === oldCluster) return;
        oldCluster = cluster;
        for (const { mesh, batch } of meshes) mesh.visible = mapBatchVisible(map, batch, cluster);
      },
      dispose: () => { background?.dispose(); dispose(); },
    };
  } catch (error) { dispose(); throw error; }
}

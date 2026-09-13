import {
  blocks,
  GhoulAnimation,
  readClips,
  readGlm,
  matchSkeleton,
  type Clip,
  type GhoulMesh,
} from "./ghoul2";
import type { PreviewAsset } from "./ipc";
import { readMd3 } from "./md3";

export type PreviewRequest = { kind: "character" | "hilt" | "model"; value: string; skins?: string[]; saber?: boolean };
type Load = (names: string[]) => Promise<PreviewAsset[]>;
export interface ModelMaterial {
  path: string | null;
  tint: boolean;
  maskedTint: boolean;
  transparent: boolean;
  doubleSided: boolean;
}
export interface ModelScene {
  mesh: GhoulMesh;
  animation: GhoulAnimation | null;
  clips: Clip[];
  skins: Map<string, string>;
  materials: Map<string, ModelMaterial>;
  blades: { tag: string; length: number; radius: number }[];
}
const stripExt = (name: string) => name.replace(/\.(tga|jpg|jpeg|png)$/i, "");
// Exporters use both Windows and engine separators inside otherwise valid models.
const resourceName = (name: string) => name.replace(/\\/g, "/").toLowerCase();
const textOf = (assets: PreviewAsset[]) =>
  assets.map((a) => (a.text ?? "").replace(/\\/g, "/")).join("\n");
async function binary(asset: PreviewAsset | undefined) {
  if (!asset?.path) throw new Error("Model resource is missing");
  const response = await fetch(asset.path);
  if (!response.ok) throw new Error("Cannot read model resource");
  return response.arrayBuffer();
}

export async function loadModelScene(
  request: PreviewRequest,
  load: Load,
): Promise<ModelScene> {
  let model: string,
    skinFiles: string[] = [];
  const blades: ModelScene["blades"] = [];
  if (request.kind === "model") {
    model = request.value.toLowerCase();
    skinFiles = request.skins ?? [];
  } else if (request.kind === "character") {
    const slash = request.value.indexOf("/");
    const name = slash < 0 ? request.value : request.value.slice(0, slash),
      skin = slash < 0 ? "default" : request.value.slice(slash + 1);
    model = `models/players/${name}/model.glm`;
    skinFiles = skin.includes("|")
      ? skin.split("|").map((p) => `models/players/${name}/${p}.skin`)
      : [`models/players/${name}/model_${skin}.skin`];
  } else {
    const sabers = blocks(textOf(await load(["@sabers"]))),
      saber = sabers.get(request.value.toLowerCase());
    const match = saber?.match(/\bsaberModel\s+"?([^"\s]+)/i);
    if (!match) throw new Error("Saber model is missing");
    model = match[1].toLowerCase();
    const skin = saber?.match(/\bcustomSkin\s+"?([^"\s]+)/i);
    if (skin) skinFiles = [skin[1].toLowerCase()];
    const parameter = (name: string, fallback: number) => {
      const n = Number(
        saber?.match(new RegExp(`\\b${name}\\s+"?([\\d.]+)`, "i"))?.[1] ??
          fallback,
      );
      return Number.isFinite(n) ? n : fallback;
    };
    for (let i = 0; i < Math.min(8, parameter("numBlades", 1)); i++)
      blades.push({
        tag: `*blade${i + 1}`,
        length: Math.min(
          200,
          parameter(`saberLength${i + 1}`, parameter("saberLength", 40)),
        ),
        radius: Math.min(
          10,
          parameter(`saberRadius${i + 1}`, parameter("saberRadius", 3)),
        ),
      });
  }
  model = resourceName(model);
  skinFiles = skinFiles.map(resourceName);
  const files = await load([model, ...skinFiles, "@shaders"]);
  const bytes = await binary(files.find((a) => a.name === model.toLowerCase()));
  const mesh = model.endsWith(".md3") ? readMd3(bytes) : readGlm(bytes);
  if (request.saber) for (const tag of mesh.surfaces.filter(surface => /^\*blade\d+$/.test(surface.name)))
    blades.push({ tag: tag.name, length: 40, radius: 3 });
  mesh.animation = resourceName(mesh.animation);
  for (const surface of mesh.surfaces) surface.shader = resourceName(surface.shader);
  const skins = new Map<string, string>();
  for (const name of skinFiles) {
    const file = files.find((a) => a.name === name.toLowerCase());
    if (!file) throw new Error(`Missing skin: ${name}`);
    for (const line of (file.text ?? "")
      .replace(/\/\/[^\n]*/g, "")
      .split(/\r?\n/)) {
      const pair = line.split(",").map((s) => resourceName(s.trim()));
      if (pair.length === 2) {
        if (pair[0].endsWith("_off") && pair[1] === "*off") continue;
        skins.set(pair[0].replace(/_off$/, ""), pair[1]);
      }
    }
  }
  let animation: GhoulAnimation | null = null,
    clips: Clip[] = [];
  if (mesh.animation && mesh.animation !== "*default") {
    const gla = `${mesh.animation}.gla`,
      cfg = `${mesh.animation.slice(0, mesh.animation.lastIndexOf("/"))}/animation.cfg`;
    const resources = await load([gla, cfg]);
    animation = new GhoulAnimation(
      await binary(resources.find((a) => a.name === gla)),
    );
    matchSkeleton(mesh, animation);
    clips = readClips(resources.find((a) => a.name === cfg)?.text ?? "").filter(
      (c) => c.first + c.count <= animation!.frames,
    );
  }
  const shaders = blocks(
    textOf(files.filter((a) => a.name.endsWith(".shader"))),
  );
  const materialNames = [
    ...new Set(
      mesh.surfaces.map(
        (s) => skins.get(s.name.replace(/_off$/, "")) ?? s.shader,
      ),
    ),
  ].filter((n) => n && n !== "*off");
  const mapNames = new Map(
    materialNames.map((name) => {
      const body = shaders.get(stripExt(name)) ?? "";
      const base = stripExt(name).toLowerCase();
      const maps = [...body.matchAll(/\b(?:map|clampmap)\s+"?([^"\s{}]+)/gi)]
        .map(match => stripExt(match[1]).toLowerCase())
        .filter(texture => !texture.startsWith("$") && !texture.startsWith("*"));
      // Prefer the object's base layer to glow/environment passes. Lightmaps
      // are supplied by the world renderer, not standalone model textures.
      const candidates = [...new Set([...maps.filter(texture => texture === base), ...maps, base])];
      return [name, { body, candidates }];
    }),
  );
  const wanted = [
    ...new Set(
      [...mapNames.values()].flatMap((m) =>
        m.candidates.flatMap(texture => [".jpg", ".png", ".tga", ".jpeg"].map(ext => texture + ext)),
      ),
    ),
  ];
  const textures: PreviewAsset[] = [];
  for (let i = 0; i < wanted.length; i += 128)
    textures.push(...(await load(wanted.slice(i, i + 128))));
  const materials = new Map<string, ModelMaterial>();
  for (const [name, { body, candidates }] of mapNames) {
    const image = candidates.flatMap(texture => [".tga", ".jpg", ".png", ".jpeg"]
      .map((ext) => textures.find((a) => a.name === texture + ext)))
      .find(Boolean);
    const tint = /lightingDiffuseEntity|rgbGen\s+entity/i.test(body);
    materials.set(name, {
      path: image?.path ?? null,
      tint,
      maskedTint: tint && /GL_SRC_ALPHA\s+GL_ONE_MINUS_SRC_ALPHA/i.test(body),
      transparent:
        !tint && /alphaFunc|blendFunc\s+(?:blend|GL_SRC_ALPHA)/i.test(body),
      doubleSided: /cull\s+(?:twosided|disable|none)/i.test(body),
    });
  }
  return { mesh, animation, clips, skins, materials, blades };
}

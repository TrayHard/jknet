import * as THREE from "three";
import { deform } from "./ghoul2";
import type { ModelScene } from "./modelScene";
import { SABER_BLADE_RGB, type CharColor } from "./ipc";

/** One model in native coordinates; its parent owns orientation and attachment. */
export function previewObject(data: ModelScene, lit: boolean) {
    const group = new THREE.Group();
    const loader = new THREE.TextureLoader(),
      textures: THREE.Texture[] = [],
      materials: THREE.MeshLambertMaterial[] = [];
    let disposed = false;
    const pending: Promise<unknown>[] = [];
    const surfaces = data.mesh.surfaces.flatMap((surface) => {
      const skin = data.skins.get(surface.name.replace(/_off$/, ""));
      if (
        (surface.flags & 1 && !skin) ||
        surface.flags & 2 ||
        skin === "*off" ||
        surface.name.startsWith("*")
      )
        return [];
      const descriptor = data.materials.get(skin ?? surface.shader);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(surface.positions.slice(), 3).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(surface.normals.slice(), 3).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      geometry.setAttribute("uv", new THREE.BufferAttribute(surface.uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
      const material = new THREE.MeshLambertMaterial({
        side: descriptor?.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: descriptor?.transparent ? 0.5 : 0,
      });
      const color = new THREE.Color(1, 1, 1);
      if (descriptor?.maskedTint) {
        material.onBeforeCompile = (shader) => {
          shader.uniforms.previewTint = { value: color };
          shader.fragmentShader =
            "uniform vec3 previewTint;\n" +
            shader.fragmentShader.replace(
              "#include <map_fragment>",
              "#include <map_fragment>\n#ifdef USE_MAP\ndiffuseColor.rgb *= mix(previewTint, vec3(1.0), sampledDiffuseColor.a);\ndiffuseColor.a = 1.0;\n#endif",
            );
        };
      }
      if (descriptor?.path) {
        let resolve!: (v?: unknown) => void, reject!: (e: unknown) => void;
        pending.push(new Promise((a, b) => { resolve = a; reject = b; }));
        const texture = loader.load(
          descriptor.path,
          (loaded) => {
            if (disposed) loaded.dispose();
            resolve();
          },
          undefined,
          (error) => {
            reject(error);
          },
        );
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        textures.push(texture);
        material.map = texture;
      }
      materials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      group.add(mesh);
      return [{ surface, geometry, material, descriptor, color }];
    });
    const bladeMeshes: THREE.Mesh<
      THREE.CylinderGeometry,
      THREE.MeshBasicMaterial
    >[] = [];
    if (lit) for (const blade of data.blades) {
      const tag =
        data.mesh.surfaces.find((s) => s.name === blade.tag) ??
        data.mesh.surfaces.find((s) => s.name === "*flash");
      if (!tag || tag.positions.length < 9) continue;
      const p = [0, 1, 2].map((i) =>
        new THREE.Vector3().fromArray(tag.positions, i * 3),
      );
      // G2API_GetBoltMatrix applies the multiplayer 90-degree axis swap.
      // Its negative Y is therefore the tag's negative shortest side.
      const direction = p[2].clone().sub(p[0]).normalize();
      const origin = p[2];
      for (const [radius, opacity] of [
        [0.13, 1],
        [0.34, 0.65],
        [0.65, 0.18],
      ] as const) {
        const geometry = new THREE.CylinderGeometry(
          blade.radius * radius,
          blade.radius * radius,
          blade.length,
          12,
        );
        const material = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: opacity < 1,
          opacity,
          depthWrite: opacity === 1,
          blending: opacity < 1 ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(origin).addScaledVector(direction, blade.length / 2);
        mesh.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          direction,
        );
        group.add(mesh);
        bladeMeshes.push(mesh);
      }
    }

    return {
      group,
      ready: Promise.all(pending),
      pose(matrices: THREE.Matrix4[]) {
        for (const s of surfaces) {
          deform(
            s.surface,
            matrices,
            s.geometry.getAttribute("position").array as Float32Array,
            s.geometry.getAttribute("normal").array as Float32Array,
          );
          s.geometry.getAttribute("position").needsUpdate =
            s.geometry.getAttribute("normal").needsUpdate = true;
          s.geometry.computeBoundingBox();
        }

      },
      color(tint?: CharColor | null, bladeColor?: number | null) {
      for (const s of surfaces)
        if (s.descriptor?.tint) {
          const c = tint;
          s.color.setRGB(
            (c?.red ?? 255) / 255,
            (c?.green ?? 255) / 255,
            (c?.blue ?? 255) / 255,
          );
          if (!s.descriptor.maskedTint) s.material.color.copy(s.color);
        }
      const rgb =
        SABER_BLADE_RGB[bladeColor ?? 4] ?? SABER_BLADE_RGB[4];
      bladeMeshes.forEach((mesh) => {
        if (mesh.material.opacity < 1) mesh.material.color.set(rgb);
      });

      },
      dispose() {
        disposed = true;
        surfaces.forEach(s => s.geometry.dispose());
        bladeMeshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        materials.forEach(m => m.dispose());
        textures.forEach(t => t.dispose());
      },
    };
}

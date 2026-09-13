import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { useModelPreview } from "../lib/queries";
import { deform, surfaceBolt } from "../lib/ghoul2";
import { previewObject } from "../lib/previewObject";
import { animationLabels, previewAnimations, previewFrame, type PreviewAction } from "../lib/previewAnimations";
import { saberModeOf, type SaberMode } from "../lib/sabers";
import type { ModelPreviewProps } from "./ModelPreview";
import { Button, Select } from "./ui";
import { useErrorText } from "../i18n/errors";

export function ModelPreview({ clientId, source, kind, value, skins, saber, tint, bladeColor, sabers, heldWeapon, thumbnail = false,
  height = 360, className = "" }: ModelPreviewProps) {
  const { t } = useTranslation("common");
  const errorText = useErrorText();
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!thumbnail);
  const model = useModelPreview(clientId, { kind, value, skins, saber }, visible, source);
  const hasHands = kind === "character" || (kind === "model" && !!model.data?.mesh.surfaces.some(surface => surface.name === "*r_hand"));
  const first = useModelPreview(clientId, { kind: "hilt", value: hasHands ? sabers?.saber1 ?? "" : "" }, visible, source);
  const second = useModelPreview(clientId, { kind: "hilt", value: hasHands && sabers?.saber2 !== "none" ? sabers?.saber2 ?? "" : "" }, visible, source);
  const weapon = useModelPreview(clientId, heldWeapon?.request ?? { kind: "model", value: "" }, visible && hasHands, heldWeapon?.source);
  const mode: SaberMode = sabers && saberModeOf(sabers, []) === "duals" ? "duals"
    : ((heldWeapon ? weapon.data : first.data)?.blades.length ?? 0) > 1 ? "staff" : "single";
  const gun = !!heldWeapon && !heldWeapon.saber;
  // Match the retail ready poses for pistols, carried explosives, and rifles.
  const weaponName = heldWeapon?.request.value ?? "";
  const weaponPose = gun ? /pistol|bryar/i.test(weaponName) ? "TORSO_WEAPONREADY2"
    : /thermal|tripmine|detpack/i.test(weaponName) ? "TORSO_WEAPONREADY10" : "TORSO_WEAPONREADY3" : undefined;
  const choices = previewAnimations(model.data?.clips ?? [], mode, weaponPose);
  const [action, setAction] = useState<PreviewAction>(heldWeapon ? "stand" : "walk");
  const selected = choices.find(c => c.id === action) ?? choices[0];
  const [playing, setPlaying] = useState(true);
  const [renderError, setRenderError] = useState<unknown>(null);
  const [snapshot, setSnapshot] = useState("");
  const resetCamera = useRef<() => void>(() => undefined);
  const settings = useRef({ playing, selected, tint, bladeColor, sabers });
  settings.current = { playing, selected, tint, bladeColor, sabers };

  useEffect(() => {
    if (!thumbnail || !host.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "100px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [thumbnail]);

  useEffect(() => {
    const node = host.current, data = model.data;
    if (!node || !data || (hasHands && heldWeapon && weapon.isPending) || (hasHands && sabers?.saber1 && first.isPending) || (hasHands && sabers?.saber2 && sabers.saber2 !== "none" && second.isPending)) return;
    setRenderError(null);
    setSnapshot("");
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch (error) { setRenderError(error); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, thumbnail ? 1.5 : 2));
    node.appendChild(renderer.domElement);
    const scene = new THREE.Scene(), rotation = new THREE.Group(), centered = new THREE.Group(), group = new THREE.Group();
    scene.add(rotation); rotation.add(centered); centered.add(group);
    if (gun) rotation.rotation.y = -Math.PI / 5;
    group.rotation.x = -Math.PI / 2;
    // Retail hilts point along native Z. Roll the close-up onto the horizontal axis.
    if (kind === "hilt") centered.rotation.z = Math.PI / 2;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(2, 4, 5); scene.add(light);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = !thumbnail;
    controls.rotateSpeed = 0.8;
    if (kind !== "model") controls.minPolarAngle = controls.maxPolarAngle = Math.PI / 2;
    controls.screenSpacePanning = true;
    const body = previewObject(data, false);
    group.add(body.group);
    const attachments = (heldWeapon ? [weapon.data] : [first.data, second.data]).flatMap((hilt, hand) => {
      if (!hasHands || !hilt) return [];
      const tag = data.mesh.surfaces.find(s => s.name === (hand === 0 ? "*r_hand" : "*l_hand"));
      if (!tag) return [];
      const object = previewObject(hilt, true);
      object.group.matrixAutoUpdate = false;
      group.add(object.group);
      return [{ object, tag, hand, positions: new Float32Array(tag.positions.length), normals: new Float32Array(tag.normals.length) }];
    });
    const objects = [body, ...attachments.map(a => a.object)];
    let elapsed = 0, oldClip = "", last = performance.now(), frame = 0, disposed = false, released = false;
    const pose = () => {
      const setting = settings.current, chosen = setting.selected;
      if (oldClip !== chosen?.clip.name) { elapsed = 0; oldClip = chosen?.clip.name ?? ""; }
      if (data.animation) {
        const matrices = data.animation.pose(chosen ? previewFrame(chosen.clip, thumbnail ? 0.3 : elapsed, chosen.id) : 0);
        body.pose(matrices);
        for (const a of attachments) {
          deform(a.tag, matrices, a.positions, a.normals);
          surfaceBolt(a.positions, a.object.group.matrix);
          a.object.group.matrixWorldNeedsUpdate = true;
        }
      }
      body.color(setting.tint, setting.bladeColor);
      for (const a of attachments) a.object.color(null, (a.hand === 0 ? setting.sabers?.color1 : setting.sabers?.color2) ?? setting.bladeColor);
    };
    let framing: THREE.Box3 | undefined, framingClip = "";
    const fit = () => {
      const angle = rotation.rotation.y;
      rotation.rotation.y = 0;
      rotation.updateMatrixWorld(true);
      centered.position.set(0, 0, 0);
      centered.updateMatrixWorld(true);
      // Fit the whole action, including jumps and extended arms during a kata.
      // Reuse that envelope so the camera stays still while the character moves.
      if (!framing || framingClip !== oldClip) {
        framing = new THREE.Box3().setFromObject(centered);
        framingClip = oldClip;
        const chosen = settings.current.selected, savedElapsed = elapsed;
        if (!thumbnail && chosen && data.animation) {
          for (let i = 0; i <= 16; i++) {
            elapsed = i / 16 * (chosen.clip.count - 1) / Math.abs(chosen.clip.fps);
            pose();
            centered.updateMatrixWorld(true);
            framing.union(new THREE.Box3().setFromObject(centered));
          }
          elapsed = savedElapsed;
          pose();
        }
      }
      const bounds = framing;
      if (bounds.isEmpty()) { rotation.rotation.y = angle; return; }
      const center = bounds.getCenter(new THREE.Vector3()), extent = bounds.getSize(new THREE.Vector3());
      centered.position.sub(center);
      const orbitBounds = kind === "model" || !!heldWeapon;
      const width = orbitBounds ? Math.hypot(extent.x, extent.z) : extent.x;
      const depth = orbitBounds ? width : extent.z;
      const distance = Math.max(extent.y / 2, width / 2 / camera.aspect) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) + depth / 2;
      camera.position.set(0, 0, Math.max(2, distance * 1.18));
      controls.target.set(0, 0, 0); controls.update();
      rotation.rotation.y = angle;
    };
    const release = () => {
      if (released) return;
      released = true;
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
    resetCamera.current = () => { pose(); fit(); };
    const resize = new ResizeObserver(() => {
      if (released) return;
      const rect = node.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height);
      camera.aspect = rect.width / Math.max(1, rect.height); camera.updateProjectionMatrix();
      fit();
    });
    resize.observe(node);
    const draw = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000); last = now;
      if (!document.hidden) {
        if (settings.current.playing) elapsed += delta;
        try {
          const before = oldClip;
          pose();
          if (before !== oldClip) fit();
          // Rotate around the hilt's length to keep the close-up horizontal.
          if (settings.current.playing) {
            if (kind === "hilt") body.group.rotation.z += delta * 0.55;
            else if (kind === "model" && !data.clips.length) rotation.rotation.y += delta * 0.55;
          }
          controls.update(); renderer.render(scene, camera);
        } catch (error) { setRenderError(error); return; }
      }
      frame = requestAnimationFrame(draw);
    };
    try { pose(); fit(); } catch (error) { setRenderError(error); }
    void Promise.all(objects.map(o => o.ready)).then(() => {
      if (disposed) return;
      pose(); fit();
      if (thumbnail) {
        const rect = node.getBoundingClientRect();
        renderer.setSize(rect.width, rect.height);
        camera.aspect = rect.width / Math.max(1, rect.height); camera.updateProjectionMatrix(); fit();
        renderer.render(scene, camera);
        setSnapshot(renderer.domElement.toDataURL());
        resize.disconnect(); release();
      }
    }).catch(error => { if (!disposed) setRenderError(error); });
    if (!thumbnail) frame = requestAnimationFrame(draw);
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); controls.dispose();
      objects.forEach(o => o.dispose()); release(); resetCamera.current = () => undefined;
    };
  }, [model.data, first.data, second.data, weapon.data, weapon.isPending, !!heldWeapon, gun, first.isPending, second.isPending, hasHands, kind, thumbnail, thumbnail ? tint?.red : null,
    thumbnail ? tint?.green : null, thumbnail ? tint?.blue : null, thumbnail ? sabers?.color1 : null, thumbnail ? sabers?.color2 : null]);

  const failure = model.error ?? first.error ?? second.error ?? weapon.error ?? renderError;
  const loading = model.isPending || (hasHands && !!heldWeapon && weapon.isPending) || (hasHands && !!sabers?.saber1 && first.isPending) || (hasHands && !!sabers?.saber2 && sabers.saber2 !== "none" && second.isPending);
  return (
    <section className={`rounded-md border border-line bg-input overflow-hidden ${className}`} aria-label={t("modelPreview.title")}>
      <div ref={host} style={{ height }} className="relative w-full touch-none">
        {snapshot ? <img src={snapshot} alt={t("modelPreview.title")} className="size-full object-contain" /> : null}
      </div>
      {loading && !thumbnail ? <p role="status" className="p-12 text-body-sm text-fg-muted">{t("modelPreview.loading")}</p> : null}
      {failure ? <p role="alert" title={errorText(failure)} className="p-8 text-body-xs text-fg-danger">{thumbnail ? t("modelPreview.unavailable") : t("modelPreview.failed", { reason: errorText(failure) })}</p> : null}
      {!thumbnail ? <div className="flex items-center flex-wrap gap-8 p-8">
        <Button type="button" size="sm" variant="ghost" onClick={() => setPlaying(v => !v)}>{t(playing ? "modelPreview.pause" : "modelPreview.play")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => resetCamera.current()}>{t("modelPreview.reset")}</Button>
        {kind !== "hilt" && selected && choices.length > 1 ? <Select ariaLabel={t("modelPreview.animation")} value={selected.id}
          options={choices.map(c => ({ value: c.id, label: t(animationLabels[c.id]) }))}
          onChange={v => setAction(v as PreviewAction)} className="max-w-280" /> : null}
        <span className="text-body-xs text-fg-muted">{t("modelPreview.mouse")}</span>
      </div> : null}
    </section>
  );
}

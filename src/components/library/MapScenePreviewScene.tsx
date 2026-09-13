import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Maximize, Minimize } from "lucide-react";
import * as THREE from "three";
import { filePreviewIpc } from "../../lib/ipc";
import { loadMapWorld } from "../../lib/mapScene";
import { useErrorText } from "../../i18n/errors";
import { Button, Select } from "../ui";
import type { MapScenePreviewProps } from "./MapScenePreview";

const mapErrors = {
  "Invalid BSP map data": "mapPreview.invalid",
  "Unsupported BSP map format": "mapPreview.unsupported",
  "Map exceeds preview limits": "mapPreview.tooLarge",
  "Map contains no visible geometry": "mapPreview.empty",
  "Map resource is missing": "mapPreview.missing",
} as const;

export function MapScenePreviewScene({ source, name }: MapScenePreviewProps) {
  const { t } = useTranslation("library"), { t: common } = useTranslation("common");
  const errorText = useErrorText();
  const container = useRef<HTMLElement>(null), fullscreenButton = useRef<HTMLButtonElement>(null);
  const host = useRef<HTMLDivElement>(null), travel = useRef<(index: number) => void>(() => {});
  const [fullscreen, setFullscreen] = useState(false), [fullscreenError, setFullscreenError] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState<unknown>(null), [retry, setRetry] = useState(0);
  const [spawns, setSpawns] = useState(0), [viewpoint, setViewpoint] = useState(-1), [missing, setMissing] = useState(0);

  useEffect(() => {
    const node = container.current;
    const changed = () => {
      const active = document.fullscreenElement === node;
      setFullscreen(active);
      if (active) host.current?.focus();
      else fullscreenButton.current?.focus();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (node && document.fullscreenElement === node) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const toggleFullscreen = async () => {
    setFullscreenError(false);
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch { setFullscreenError(true); }
  };

  useEffect(() => {
    const node = host.current; if (!node) return;
    const controller = new AbortController(), signal = controller.signal;
    setLoading(true); setError(null); setSpawns(0); setMissing(0);
    let world: Awaited<ReturnType<typeof loadMapWorld>> | undefined;
    let renderer: THREE.WebGLRenderer | undefined, resize: ResizeObserver | undefined, frame = 0;
    const cleanup: (() => void)[] = [];
    const run = async () => {
      world = await loadMapWorld(name, names => filePreviewIpc.assets(source, names), signal);
      if (signal.aborted) { world.dispose(); return; }
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      const canvas = renderer.domElement;
      node.appendChild(canvas);
      const scene = new THREE.Scene(); scene.add(world.group);
      scene.background = world.background ?? new THREE.Color(0x202630);
      const minimum = new THREE.Vector3().fromArray(world.map.bounds), maximum = new THREE.Vector3().fromArray(world.map.bounds, 3);
      const center = minimum.clone().add(maximum).multiplyScalar(0.5), extent = maximum.clone().sub(minimum);
      const camera = new THREE.PerspectiveCamera(75, 1, 1, Math.max(10_000, extent.length() * 3));
      camera.rotation.order = "YXZ";
      const forward = new THREE.Vector3(), right = new THREE.Vector3(), movement = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0), keys = new Set<string>();
      let dirty = true, last = performance.now(), pointer: { id: number; x: number; y: number; pan: boolean } | null = null;
      const moveKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
      travel.current = index => {
        const spawn = world!.map.spawns[index];
        if (spawn) { camera.position.fromArray(spawn.position); camera.rotation.set(spawn.pitch, spawn.yaw, 0, "YXZ"); }
        else {
          const distance = Math.max(160, extent.length() * 0.8);
          camera.position.copy(center).add(new THREE.Vector3(distance * 0.7, distance * 0.8, distance * 0.7));
          camera.lookAt(center);
        }
        dirty = true;
      };
      const start = world.map.spawns.length ? 0 : -1;
      setSpawns(world.map.spawns.length); setViewpoint(start); travel.current(start); setMissing(world.missing);
      resize = new ResizeObserver(() => {
        if (!renderer) return;
        const rect = node.getBoundingClientRect();
        renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height));
        camera.aspect = rect.width / Math.max(1, rect.height); camera.updateProjectionMatrix(); dirty = true;
      });
      resize.observe(node);
      const down = (event: PointerEvent) => {
        if (event.button !== 0 && event.button !== 2) return;
        event.preventDefault(); node.focus(); node.setPointerCapture(event.pointerId);
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button === 2 };
      };
      const move = (event: PointerEvent) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        const x = event.clientX - pointer.x, y = event.clientY - pointer.y;
        pointer.x = event.clientX; pointer.y = event.clientY;
        if (pointer.pan) {
          camera.getWorldDirection(forward); right.crossVectors(forward, up).normalize();
          camera.position.addScaledVector(right, -x).addScaledVector(up, y);
        } else {
          camera.rotation.y -= x * 0.004;
          camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - y * 0.004, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        }
        dirty = true;
      };
      const release = () => { pointer = null; };
      const wheel = (event: WheelEvent) => {
        event.preventDefault(); node.focus(); camera.getWorldDirection(forward);
        const delta = THREE.MathUtils.clamp(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 200 : 1), -300, 300);
        camera.position.addScaledVector(forward, -delta * (event.shiftKey ? 3 : 0.8)); dirty = true;
      };
      const keyDown = (event: KeyboardEvent) => {
        if (!moveKeys.has(event.code)) return;
        event.preventDefault(); event.stopPropagation(); keys.add(event.code);
      };
      const keyUp = (event: KeyboardEvent) => { keys.delete(event.code); };
      const blur = () => { keys.clear(); pointer = null; };
      node.addEventListener("pointerdown", down); node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", release); node.addEventListener("pointercancel", release); node.addEventListener("lostpointercapture", release);
      node.addEventListener("wheel", wheel, { passive: false });
      node.addEventListener("keydown", keyDown); node.addEventListener("keyup", keyUp); node.addEventListener("blur", blur);
      window.addEventListener("blur", blur);
      cleanup.push(() => {
        node.removeEventListener("pointerdown", down); node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", release); node.removeEventListener("pointercancel", release); node.removeEventListener("lostpointercapture", release);
        node.removeEventListener("wheel", wheel); node.removeEventListener("keydown", keyDown); node.removeEventListener("keyup", keyUp);
        node.removeEventListener("blur", blur); window.removeEventListener("blur", blur);
      });
      const draw = (now: number) => {
        const delta = Math.min(0.05, (now - last) / 1000); last = now;
        if (!document.hidden && renderer && world) {
          camera.getWorldDirection(forward); right.crossVectors(forward, up).normalize(); movement.set(0, 0, 0);
          const key = (...codes: string[]) => codes.some(code => keys.has(code));
          if (key("KeyW", "ArrowUp")) movement.add(forward);
          if (key("KeyS", "ArrowDown")) movement.sub(forward);
          if (key("KeyD", "ArrowRight")) movement.add(right);
          if (key("KeyA", "ArrowLeft")) movement.sub(right);
          if (key("KeyE")) movement.add(up);
          if (key("KeyQ")) movement.sub(up);
          if (movement.lengthSq()) {
            camera.position.addScaledVector(movement.normalize(), delta * (key("ShiftLeft", "ShiftRight") ? 1200 : 350)); dirty = true;
          }
          if (dirty) {
            world.update(camera.position); renderer.render(scene, camera); dirty = false;
          }
        }
        frame = requestAnimationFrame(draw);
      };
      setLoading(false); frame = requestAnimationFrame(draw);
    };
    void run().catch(error => { if (!signal.aborted) { setError(error); setLoading(false); } });
    return () => {
      controller.abort(); cancelAnimationFrame(frame); resize?.disconnect(); cleanup.forEach(fn => fn());
      travel.current = () => {}; world?.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
    };
  }, [source.previewId, source.archive, name, retry]);

  const errorKey = error instanceof Error ? mapErrors[error.message as keyof typeof mapErrors] : undefined;
  const reason = errorKey ? t(errorKey) : errorText(error);
  return <section ref={container} className={`flex flex-col gap-8 min-h-0 ${fullscreen ? "w-screen h-screen bg-surface p-16" : "h-full"}`} aria-label={t("mapPreview.title")}
    onKeyDown={event => {
      // The surrounding dialog also contains controls hidden by the fullscreen top layer.
      if (!fullscreen || event.key !== "Tab" || event.defaultPrevented) return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'))
        .filter(node => node.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      event.stopPropagation();
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div ref={host} tabIndex={0} aria-label={t("mapPreview.viewport")} aria-describedby="map-navigation-hint" onContextMenu={event => event.preventDefault()}
      className="relative flex-1 min-h-160 rounded-md border border-line bg-input overflow-hidden touch-none cursor-grab focus-visible:outline-2 focus-visible:outline-fg-accent">
      {loading ? <p role="status" className="absolute inset-0 flex items-center justify-center p-16 text-body-sm text-fg-muted">{t("mapPreview.loading")}</p> : null}
      {error ? <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-12 p-16">
        <p className="text-body-sm text-fg-danger">{reason}</p><Button onClick={() => setRetry(value => value + 1)}>{common("actions.tryAgain")}</Button>
      </div> : null}
    </div>
    {!loading && !error ? <div className="flex flex-wrap items-center gap-8 shrink-0">
      <Select ariaLabel={t("mapPreview.viewpoint")} value={String(viewpoint)}
        options={[{ value: "-1", label: t("mapPreview.overview") }, ...Array.from({ length: spawns }, (_, index) => ({ value: String(index), label: t("mapPreview.spawn", { number: index + 1 }) }))]}
        onChange={value => { setViewpoint(Number(value)); travel.current(Number(value)); }} className="flex-1 min-w-160" />
      <Button size="sm" variant="ghost" onClick={() => travel.current(viewpoint)}>{common("modelPreview.reset")}</Button>
      <Button size="sm" variant="ghost" icon={fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        onClick={event => { fullscreenButton.current = event.currentTarget; void toggleFullscreen(); }}>{t(fullscreen ? "mapPreview.exitFullscreen" : "mapPreview.fullscreen")}</Button>
    </div> : null}
    <p id="map-navigation-hint" className="text-body-xs text-fg-muted shrink-0">{t("mapPreview.controls")}</p>
    {missing ? <p role="status" className="text-body-xs text-fg-muted shrink-0">{t("mapPreview.missingTextures", { count: missing })}</p> : null}
    {fullscreenError ? <p role="alert" className="text-body-xs text-fg-danger shrink-0">{t("mapPreview.fullscreenFailed")}</p> : null}
  </section>;
}

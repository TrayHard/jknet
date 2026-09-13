import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { FilePreviewSource } from "../../lib/ipc";

const Scene = lazy(() => import("./MapScenePreviewScene").then(module => ({ default: module.MapScenePreviewScene })));
export interface MapScenePreviewProps { source: FilePreviewSource; name: string }
export function MapScenePreview(props: MapScenePreviewProps) {
  const { t } = useTranslation("library");
  return <Suspense fallback={<p role="status" className="text-body-sm text-fg-muted p-12">{t("preview.loading")}</p>}><Scene {...props} /></Suspense>;
}

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { CharColor, FilePreviewSource } from "../lib/ipc";
import type { PreviewRequest } from "../lib/modelScene";
import type { SaberValues } from "../lib/sabers";

const Scene = lazy(() =>
  import("./ModelPreviewScene").then((module) => ({
    default: module.ModelPreview,
  })),
);

/** Shared entry point; the renderer is downloaded only when a preview is shown. */
export type ModelPreviewProps = PreviewRequest & {
    clientId: string;
    source?: FilePreviewSource;
    heldWeapon?: { request: PreviewRequest; source: FilePreviewSource; saber: boolean };
    tint?: CharColor | null;
    bladeColor?: number | null;
    height?: number | string;
    className?: string;
    sabers?: SaberValues;
    thumbnail?: boolean;
};

export function ModelPreview(props: ModelPreviewProps) {
  const { t } = useTranslation("common");
  return (
    <Suspense
      fallback={
        <p role="status" className="p-12 text-body-sm text-fg-muted">
          {t("modelPreview.loading")}
        </p>
      }
    >
      <Scene {...props} />
    </Suspense>
  );
}

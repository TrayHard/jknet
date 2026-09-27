/**
 * The web build's stand-in for `src/components/library/FilePreviewDialog.tsx`,
 * the preview of a file of a pk3 (models, maps, text): see `LAUNCHER_ONLY` in
 * `web/vite.config.ts`. **Contents** and **Preview** need the launcher.
 */
export const PREVIEW_KINDS = ["all"] as const;

export function FilePreviewDialog(): null {
  return null;
}

export function ReadyFilePreviewDialog(): null {
  return null;
}

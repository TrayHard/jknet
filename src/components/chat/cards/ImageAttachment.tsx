import { FileImage, ImageDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../../i18n/useFormat";
import { Button } from "../../ui";
import type { AttachmentProps } from "./index";
import { DownloadBar, FileFrame } from "./FileCard";
import { ImageLightbox } from "./ImageLightbox";
import { useChatFile } from "./useChatFile";

/** The largest box a picture takes in the thread. */
const MAX_WIDTH = 300;
const MAX_HEIGHT = 240;

/**
 * --- slice: chat cards ---
 *
 * A picture of a message: a screenshot from the Media screen, a picture from
 * the clipboard or any image file.
 *
 * A picture no larger than the setting (10 MiB unless changed) comes down as
 * soon as it is shown; a larger one waits for **Show picture**. The box has
 * the picture's own proportions from the start, when the sender's launcher
 * gave its size, so the thread does not jump when it arrives. A click opens
 * it whole in the lightbox, with **Save** and **Add to Media**.
 */
export function ImageAttachment({ file, message }: AttachmentProps) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const state = useChatFile(file, message, true);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);

  if (state.status === "gone" || broken) {
    return (
      <>
        <FileFrame file={file} state={broken ? { ...state, status: "gone" } : state} />
        {state.dialog}
      </>
    );
  }

  const width = file.meta?.width ?? null;
  const height = file.meta?.height ?? null;
  const box =
    width !== null && height !== null && width > 0 && height > 0
      ? (() => {
          const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
          return { width: Math.round(width * scale), height: Math.round(height * scale) };
        })()
      : { width: MAX_WIDTH, height: 168 };
  const label = file.meta?.origin === "media" ? t("files.image.screenshot") : t("files.class.image");

  return (
    <>
      <div className="flex max-w-full flex-col gap-4" style={{ width: box.width }}>
        {state.url !== null ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t("files.image.open", { name: file.name })}
            title={file.name}
            className="block max-w-full overflow-hidden rounded-lg border border-line bg-elevated cursor-zoom-in"
            style={{ width: box.width, height: box.height }}
          >
            <img
              src={state.url}
              alt={file.name}
              decoding="async"
              onError={() => setBroken(true)}
              className="size-full object-cover"
            />
          </button>
        ) : (
          <div
            className="flex max-w-full flex-col items-center justify-center gap-8 rounded-lg border border-line bg-elevated p-12 text-center"
            style={{ width: box.width, height: box.height }}
          >
            <FileImage size={20} aria-hidden="true" className="text-fg-muted" />
            {state.status === "downloading" ? (
              <div className="w-full max-w-200">
                <DownloadBar state={state} />
              </div>
            ) : (
              <Button size="sm" icon={<ImageDown size={14} />} onClick={state.fetch}>
                {t("files.image.show", { size: format.bytes(file.size) })}
              </Button>
            )}
          </div>
        )}
        <span className="flex min-w-0 items-center gap-6 text-mono-xs text-fg-muted">
          <span className="min-w-0 truncate [unicode-bidi:isolate]" title={file.name}>
            {file.name}
          </span>
          <span className="shrink-0">
            {label} · {format.bytes(file.size)}
          </span>
        </span>
        {state.error !== null ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {state.error}
          </p>
        ) : null}
      </div>
      {open && state.url !== null ? (
        <ImageLightbox file={file} message={message} url={state.url} state={state} onClose={() => setOpen(false)} />
      ) : null}
      {state.dialog}
    </>
  );
}

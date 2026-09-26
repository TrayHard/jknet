import { FileVideo, Play } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../../i18n/useFormat";
import { Button } from "../../ui";
import type { AttachmentProps } from "./index";
import { DownloadBar, FileFrame } from "./FileCard";
import { useChatFile } from "./useChatFile";

/** The box of a video in the thread: 16:9 at the width of a card. */
const WIDTH = 300;
const HEIGHT = 169;

/**
 * --- slice: chat cards ---
 *
 * A video of a message, usually one the Media screen made out of a demo.
 *
 * Videos never come down by themselves: **Play** fetches the file, and it
 * plays in place with the webview's own controls once it is here. The
 * length comes from what the sender's launcher said about it.
 */
export function VideoAttachment({ file, message }: AttachmentProps) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const state = useChatFile(file, message);
  const [wanted, setWanted] = useState(false);
  const [broken, setBroken] = useState(false);

  // A **Play** pressed before the file was here plays it once it lands.
  const ready = state.url !== null;

  if (state.status === "gone" || broken) {
    return (
      <>
        <FileFrame file={file} state={broken ? { ...state, status: "gone" } : state} />
        {state.dialog}
      </>
    );
  }

  const duration = file.meta?.durationMs ?? null;
  const origin = file.meta?.origin === "media" ? t("files.video.fromMedia") : t("files.class.video");
  const subtitle = [origin, duration !== null ? format.elapsed(Math.round(duration / 1000)) : null, format.bytes(file.size)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex max-w-full flex-col gap-4" style={{ width: WIDTH }}>
      <div
        className="flex max-w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-app"
        style={{ width: WIDTH, height: HEIGHT }}
      >
        {ready && wanted && state.url !== null ? (
          <video
            src={state.url}
            controls
            autoPlay
            preload="metadata"
            onError={() => setBroken(true)}
            className="size-full"
            aria-label={file.name}
          />
        ) : state.status === "downloading" ? (
          <div className="w-full max-w-220 px-12">
            <DownloadBar state={state} />
          </div>
        ) : (
          <Button
            variant="primary"
            icon={<Play size={16} />}
            aria-label={t("files.video.playName", { name: file.name })}
            onClick={() => {
              setWanted(true);
              if (!ready) state.fetch();
            }}
          >
            {t("files.video.play")}
          </Button>
        )}
      </div>
      <span className="flex min-w-0 items-center gap-6 text-mono-xs text-fg-muted">
        <FileVideo size={12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate [unicode-bidi:isolate]" title={file.name}>
          {file.name}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-8 text-body-sm text-fg-muted">
        {subtitle}
        <button
          type="button"
          onClick={state.save}
          disabled={state.saving}
          className="text-fg-accent cursor-pointer select-none hover:underline disabled:cursor-default disabled:text-fg-disabled"
        >
          {t("files.save")}
        </button>
      </span>
      {state.error !== null ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {state.error}
        </p>
      ) : state.savedTo !== null ? (
        <p role="status" className="text-body-sm text-fg-success [overflow-wrap:anywhere]">
          {t("files.saved", { path: state.savedTo })}
        </p>
      ) : null}
      {state.dialog}
    </div>
  );
}

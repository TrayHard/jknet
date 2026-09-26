import {
  Download,
  FileArchive,
  FileCode,
  FileImage,
  FilePen,
  FileQuestion,
  FileVideo,
  FileX,
  Film,
  Save,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { fileExtension } from "../../../lib/chat/cardDrafts";
import { useActiveGame } from "../../../lib/game";
import type { ChatCardConfig, ChatFileClass } from "../../../lib/ipc";
import { useScanChatCommands } from "../../../lib/queries";
import { Button } from "../../ui";
import type { AttachmentProps } from "./index";
import { CardShell, CardStatus } from "./CardShell";
import { ConfigApplyDialog } from "./ConfigApplyDialog";
import { useChatFile, type ChatFileState } from "./useChatFile";
import { useChatNames } from "../useChatText";

export const FILE_ICONS: Record<ChatFileClass, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  demo: Film,
  config: FileCode,
  archive: FileArchive,
  executable: ShieldAlert,
  other: FileQuestion,
};

/**
 * --- slice: chat cards ---
 *
 * Any file of a message: an archive, a program, a config, a file of a kind
 * the launcher does not show.
 *
 * The kind is the service's word, decided from the bytes, not from the name:
 * a program named `shot.png` is still a program, and the card says so with
 * the danger mark, the final extension and whose word the player is taking.
 * **Save** goes through the core's save dialog, which asks once more for a
 * program or an archive with programs inside; nothing here opens a file. A
 * config opens in the config editor instead, as a new document. A file whose
 * 90 days are over, or that the service lost, says it is unavailable.
 */
export function FileCard({ file, message }: AttachmentProps) {
  const state = useChatFile(file, message);
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const extension = fileExtension(file.name);
  const danger = file.danger || file.class === "executable";
  const gone = state.status === "gone";

  return (
    <>
      <FileFrame
        file={file}
        state={state}
        tone={danger ? "danger" : "default"}
        extra={
          danger && !gone ? (
            <p className="flex items-start gap-6 text-body-sm text-fg-danger">
              <ShieldAlert size={14} aria-hidden="true" className="mt-2 shrink-0" />
              <span>
                {extension === ""
                  ? t("files.danger", { name: names.personName(message.senderId) })
                  : t("files.dangerExt", { ext: extension, name: names.personName(message.senderId) })}
              </span>
            </p>
          ) : null
        }
        actions={file.class === "config" ? <OpenConfigButton state={state} name={file.name} /> : null}
      />
      {state.dialog}
    </>
  );
}

/**
 * The frame of a file: the mark of its kind, the name, the kind and the
 * size, the download bar, and **Save** with whatever the kind adds.
 */
export function FileFrame({
  file,
  state,
  tone = "default",
  extra,
  actions,
  subtitle,
}: {
  file: AttachmentProps["file"];
  state: ChatFileState;
  tone?: "default" | "danger";
  extra?: ReactNode;
  actions?: ReactNode;
  subtitle?: string;
}) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const Icon = FILE_ICONS[file.class] ?? FileQuestion;
  const gone = state.status === "gone";

  return (
    <CardShell
      label={t("cards.label", { kind: t(`files.class.${file.class}`), title: file.name })}
      tone={gone ? "default" : tone}
      icon={gone ? <FileX size={16} /> : <Icon size={16} />}
      title={file.name}
      titleText={file.name}
      subtitle={subtitle ?? `${t(`files.class.${file.class}`)} · ${format.bytes(file.size)}`}
      actions={
        gone ? null : (
          <>
            {actions}
            <Button
              size="sm"
              variant={actions ? "ghost" : "secondary"}
              icon={<Save size={14} />}
              disabled={state.saving || state.status === "downloading"}
              onClick={state.save}
            >
              {state.saving ? t("files.saving") : t("files.save")}
            </Button>
          </>
        )
      }
      status={
        gone ? (
          <CardStatus>{t("files.gone")}</CardStatus>
        ) : state.error !== null ? (
          <CardStatus tone="danger">{state.error}</CardStatus>
        ) : state.savedTo !== null ? (
          <CardStatus tone="success">{t("files.saved", { path: state.savedTo })}</CardStatus>
        ) : null
      }
    >
      {extra}
      {state.status === "downloading" ? <DownloadBar state={state} /> : null}
    </CardShell>
  );
}

/** The bar of a download in progress, with the bytes in words. */
export function DownloadBar({ state }: { state: ChatFileState }) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const ratio = state.total > 0 ? Math.min(1, state.received / state.total) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div
        role="progressbar"
        aria-label={t("files.downloadingLabel")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        className="h-4 overflow-hidden rounded-full bg-elevated"
      >
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="text-mono-xs text-fg-muted">
        {t("files.downloading", { received: format.bytes(state.received), total: format.bytes(state.total) })}
      </span>
    </div>
  );
}

/**
 * **Open in the editor** of a `.cfg` file: the file comes down, its text is
 * read out of the cache and scanned, and the config editor opens on it as a
 * new document, the way a config card opens.
 */
function OpenConfigButton({ state, name }: { state: ChatFileState; name: string }) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const game = useActiveGame();
  const scan = useScanChatCommands();
  const [config, setConfig] = useState<ChatCardConfig | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const open = () => {
    setFailure(null);
    setSaved(null);
    if (state.url === null) {
      state.fetch();
      return;
    }
    void fetch(state.url)
      .then((response) => {
        if (!response.ok) throw new Error(`the cached copy answered ${response.status}`);
        return response.text();
      })
      .then((text) =>
        scan.mutate(text, {
          onSuccess: (dangers) =>
            setConfig({
              document: { id: "", name, game, text, sourceClient: null, sourceFile: null },
              dangers,
              skipped: [],
            }),
        }),
      )
      .catch((error: unknown) => setFailure(errorText(error)));
  };

  return (
    <>
      <Button
        size="sm"
        variant="primary"
        icon={state.url === null ? <Download size={14} /> : <FilePen size={14} />}
        disabled={state.status === "downloading" || scan.isPending}
        onClick={open}
      >
        {state.url === null ? t("files.download") : t("cards.config.open")}
      </Button>
      {failure !== null || scan.error ? (
        <CardStatus tone="danger">{failure ?? errorText(scan.error)}</CardStatus>
      ) : saved !== null ? (
        <CardStatus tone="success">{t("apply.config.saved", { name: saved })}</CardStatus>
      ) : null}
      {config !== null ? (
        <ConfigApplyDialog
          config={config}
          onClose={() => setConfig(null)}
          onSaved={(document) => {
            setConfig(null);
            setSaved(document.name);
          }}
        />
      ) : null}
    </>
  );
}

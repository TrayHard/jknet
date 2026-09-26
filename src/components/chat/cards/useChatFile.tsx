import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { chatFileUrl, type ChatFileRef, type ChatMessage } from "../../../lib/ipc";
import {
  useChatDownload,
  useChatDownloadEnd,
  useChatFileLocal,
  useFetchChatFile,
  useSaveChatFile,
  useSettings,
} from "../../../lib/queries";
import { Layer } from "../Layer";
import { chatRefusal, CONFIRM_DANGER } from "../refusal";
import { SaveDangerDialog } from "../SaveDangerDialog";
import { useChatNames } from "../useChatText";

/** Pictures up to this many MiB download by themselves while the setting is absent. */
const AUTO_DOWNLOAD_MB = 10;

export interface ChatFileState {
  /** Where the bytes are: `cached`, on their way, still on the service, or gone for good. */
  status: "cached" | "downloading" | "remote" | "gone" | "unknown";
  /** The cached copy as a URL for an `<img>` or a `<video>`, once cached. */
  url: string | null;
  /** Bytes received so far while `downloading`. */
  received: number;
  total: number;
  /** Asks the core to fetch the file. */
  fetch: () => void;
  /** **Save**: the core's save dialog, with the danger question when the core asks it. */
  save: () => void;
  saving: boolean;
  /** Where the last save put the file. */
  savedTo: string | null;
  /** The last failure of a fetch, a download or a save, in words. */
  error: string | null;
  /** The danger question while it is open. Render it. */
  dialog: ReactNode;
}

/**
 * --- slice: chat cards ---
 *
 * Everything a file of a message needs from the core: where its bytes are,
 * how far a download has got, fetching it, and saving it.
 *
 * A save goes through the core's save dialog. For a program, or an archive
 * with programs inside, the core first refuses with `confirm_danger` and the
 * list of what it found; the hook turns that into **Save anyway?** and asks
 * again confirmed. Nothing here ever opens a downloaded file.
 *
 * `auto` fetches a picture no larger than the setting as soon as it is shown.
 */
export function useChatFile(file: ChatFileRef, message: ChatMessage, auto = false): ChatFileState {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const names = useChatNames();
  const settings = useSettings().data;
  const limitMb = settings?.chatAutoDownloadMb ?? AUTO_DOWNLOAD_MB;
  const wantsAuto = auto && limitMb > 0 && file.size <= limitMb * 1024 * 1024;
  const local = useChatFileLocal(file.id, wantsAuto);
  const progress = useChatDownload(file.id);
  const end = useChatDownloadEnd(file.id);
  const fetchFile = useFetchChatFile();
  const saveFile = useSaveChatFile();
  const [danger, setDanger] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  const { mutate: fetchMutate } = fetchFile;
  const { mutate: saveMutate } = saveFile;
  const fetch = useCallback(() => fetchMutate(file.id), [fetchMutate, file.id]);

  const runSave = useCallback(
    (confirmed: boolean) =>
      saveMutate(
        { fileId: file.id, confirmed },
        {
          onSuccess: (path) => {
            setDanger(null);
            if (path !== null) setSavedTo(path);
          },
          onError: (error) => {
            const refusal = chatRefusal(error);
            if (!confirmed && refusal?.code === CONFIRM_DANGER) setDanger(refusal.message);
          },
        },
      ),
    [saveMutate, file.id],
  );
  const save = useCallback(() => {
    setSavedTo(null);
    runSave(false);
  }, [runSave]);

  const data = local.data;
  const status: ChatFileState["status"] =
    progress !== undefined ? "downloading" : (data?.status ?? (local.isError ? "remote" : "unknown"));
  const url = status === "cached" && data?.path ? chatFileUrl(data.path) : null;

  const saveError = saveFile.error && chatRefusal(saveFile.error)?.code !== CONFIRM_DANGER ? saveFile.error : null;
  const failure = fetchFile.error ?? saveError ?? null;
  // The last download of this file ended without it and nothing new was asked since.
  const downloadFailed = status === "remote" && end?.status === "remote" && !fetchFile.isPending;

  const dialog =
    danger === null ? null : (
      <Layer>
        <SaveDangerDialog
          file={file}
          senderName={names.personName(message.senderId)}
          reasons={danger}
          pending={saveFile.isPending}
          onCancel={() => setDanger(null)}
          onConfirm={() => runSave(true)}
        />
      </Layer>
    );

  return {
    status,
    url,
    received: progress?.received ?? 0,
    total: progress?.total ?? file.size,
    fetch,
    save,
    saving: saveFile.isPending,
    savedTo,
    error: failure ? errorText(failure) : downloadFailed ? t("files.downloadFailed") : null,
    dialog,
  };
}

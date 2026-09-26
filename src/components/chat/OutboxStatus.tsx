import { AlertCircle, Clock, Paperclip, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { ChatOutboxEntry } from "../../lib/ipc";
import { useDiscardChatMessage, useRetryChatMessage } from "../../lib/queries";
import { Button } from "../ui";
import { MessageText } from "./MessageText";

/**
 * --- slice: chat ---
 *
 * A message of mine the core has not delivered yet, after the thread: the
 * text as I wrote it and where it is — **Sending…**, or **Not sent** with the
 * reason, **Retry** and **Discard**.
 *
 * The outbox lives in the core's memory, so these survive switching threads
 * and windows but not a restart of the launcher.
 */
export function OutboxStatus({ entries }: { entries: ChatOutboxEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-4 px-16 pt-10">
      {entries.map((entry) => (
        <OutboxItem key={entry.clientId} entry={entry} />
      ))}
    </div>
  );
}

function OutboxItem({ entry }: { entry: ChatOutboxEntry }) {
  const { t } = useTranslation("chat");
  const retry = useRetryChatMessage();
  const discard = useDiscardChatMessage();
  const failed = entry.status === "failed";

  return (
    <div className="flex max-w-[min(480px,85%)] flex-col items-end gap-4">
      {entry.body.trim() !== "" ? (
        <div
          className={cn(
            "max-w-full rounded-lg bg-accent-subtle px-10 py-6 text-fg",
            failed ? "ring-1 ring-inset ring-line-danger" : "opacity-70",
          )}
        >
          <MessageText body={entry.body} large={false} />
        </div>
      ) : null}
      {entry.attachments.length > 0 || entry.cards.length > 0 ? (
        <span className="inline-flex items-center gap-4 text-mono-xs text-fg-muted">
          <Paperclip size={12} />
          {t("outbox.attachments", { count: entry.attachments.length + entry.cards.length })}
        </span>
      ) : null}
      {failed ? (
        <div className="flex flex-wrap items-center justify-end gap-6">
          <span className="inline-flex items-center gap-4 text-mono-xs text-fg-danger">
            <AlertCircle size={12} />
            {entry.error ? t("outbox.failedWhy", { reason: reasonText(t, entry.error) }) : t("outbox.failed")}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={12} />}
            disabled={retry.isPending}
            onClick={() => retry.mutate(entry.clientId)}
          >
            {t("outbox.retry")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={12} />}
            disabled={discard.isPending}
            onClick={() => discard.mutate(entry.clientId)}
          >
            {t("outbox.discard")}
          </Button>
        </div>
      ) : (
        <span className="inline-flex items-center gap-4 text-mono-xs text-fg-muted">
          <Clock size={12} />
          {entry.status === "uploading" ? t("outbox.uploading") : t("outbox.sending")}
        </span>
      )}
    </div>
  );
}

/** A key computed at runtime cannot be one of the typed literals. */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

/**
 * The reason of a failed send in words: a reason code of the service when the
 * catalog has one, else the core's own line as it came.
 */
function reasonText(t: unknown, reason: string): string {
  const loose = t as LooseT;
  const key = `outbox.reasons.${reason.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;
  return loose(key, { defaultValue: reason });
}

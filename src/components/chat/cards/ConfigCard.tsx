import { Copy, FileCode, FilePen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { lineCount, previewLines } from "../../../lib/chat/cardDrafts";
import type { ChatCardConfig } from "../../../lib/ipc";
import { useChatCardToConfig, useChatCommandScan } from "../../../lib/queries";
import { Button } from "../../ui";
import { DangerList } from "../DangerList";
import { CardShell, CardStatus } from "./CardShell";
import { ConfigApplyDialog } from "./ConfigApplyDialog";
import { copyText, useFlash } from "./useCardActions";
import type { CardViewProps } from "./withFields";

/** Lines of the text the card shows. */
const PREVIEW_LINES = 4;

/**
 * --- slice: chat cards ---
 *
 * A config: its name, its first lines and the commands of it the player
 * should read first. **Open in the editor** opens the text as a new
 * document of the config editor with those lines marked; nothing is saved
 * until the player saves it there.
 */
export function ConfigCardView({ card, fields }: CardViewProps<"config">) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const format = useFormat();
  const scan = useChatCommandScan(fields.text);
  const toConfig = useChatCardToConfig();
  const [config, setConfig] = useState<ChatCardConfig | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, flashCopied] = useFlash();
  const preview = previewLines(fields.text, PREVIEW_LINES);
  const size = new TextEncoder().encode(fields.text).length;

  return (
    <>
      <CardShell
        label={t("cards.label", { kind: t("cards.kinds.config"), title: fields.name })}
        icon={<FileCode size={16} />}
        title={fields.name}
        titleText={fields.name}
        subtitle={t("cards.config.lines", { count: lineCount(fields.text), size: format.bytes(size) })}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<FilePen size={14} />}
              disabled={toConfig.isPending}
              onClick={() => {
                setSaved(null);
                toConfig.mutate({ card }, { onSuccess: setConfig });
              }}
            >
              {t("cards.config.open")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={14} />}
              onClick={() => void copyText(fields.text).then((ok) => ok && flashCopied())}
            >
              {copied ? t("cards.copied") : t("cards.config.copy")}
            </Button>
          </>
        }
        status={
          toConfig.error ? (
            <CardStatus tone="danger">{errorText(toConfig.error)}</CardStatus>
          ) : saved !== null ? (
            <CardStatus tone="success">{t("apply.config.saved", { name: saved })}</CardStatus>
          ) : null
        }
      >
        {preview.length > 0 ? (
          <pre className="max-h-96 overflow-hidden rounded-md border border-line-subtle bg-input px-8 py-6 text-mono-xs text-fg-secondary whitespace-pre-wrap [overflow-wrap:anywhere] [unicode-bidi:isolate]">
            {preview.join("\n")}
          </pre>
        ) : null}
        <DangerList dangers={scan.data ?? []} compact />
      </CardShell>
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

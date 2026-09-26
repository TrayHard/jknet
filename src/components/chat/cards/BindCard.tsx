import { Copy, FilePlus2, Keyboard } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { bindLines, cardTitle } from "../../../lib/chat/cardDrafts";
import type { ChatCardConfig } from "../../../lib/ipc";
import { useChatCardToConfig, useChatCommandScan } from "../../../lib/queries";
import { Button } from "../../ui";
import { DangerList } from "../DangerList";
import { CardShell, CardStatus } from "./CardShell";
import { ConfigApplyDialog } from "./ConfigApplyDialog";
import { copyText, useFlash } from "./useCardActions";
import type { CardViewProps } from "./withFields";

/** Binds a card shows before «and N more». */
const SHOWN = 6;

/**
 * --- slice: chat cards ---
 *
 * Key binds: each key and the command it runs.
 *
 * A bind is a command the game runs on a key press, so the card lists the
 * dangerous ones the core's scan finds — a key that quits the game, rebinds
 * other keys, runs a config nobody can see — before anything else.
 * **Add to a config** opens the binds as a new document of the config editor
 * (`chat_card_to_config`), with those lines marked; **Copy** puts the bind
 * lines on the clipboard for a console.
 */
export function BindCardView({ card, fields }: CardViewProps<"bind">) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const lines = useMemo(() => bindLines(fields.binds), [fields.binds]);
  const scan = useChatCommandScan(lines);
  const toConfig = useChatCardToConfig();
  const [config, setConfig] = useState<ChatCardConfig | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, flashCopied] = useFlash();
  const title = cardTitle({ type: "bind", fields });
  const rest = fields.binds.length - SHOWN;

  return (
    <>
      <CardShell
        label={t("cards.label", { kind: t("cards.kinds.bind"), title })}
        icon={<Keyboard size={16} />}
        title={t("cards.bind.title", { count: fields.binds.length })}
        subtitle={t("cards.kinds.bind")}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<FilePlus2 size={14} />}
              disabled={toConfig.isPending}
              onClick={() => {
                setSaved(null);
                toConfig.mutate({ card }, { onSuccess: setConfig });
              }}
            >
              {t("cards.bind.apply")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={14} />}
              onClick={() => void copyText(lines).then((ok) => ok && flashCopied())}
            >
              {copied ? t("cards.copied") : t("cards.bind.copy")}
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
        <ul className="flex flex-col gap-4">
          {fields.binds.slice(0, SHOWN).map((bind, index) => (
            <li key={`${index}-${bind.key}`} className="flex min-w-0 items-baseline gap-8">
              <kbd className="shrink-0 rounded-xs border border-line-strong bg-elevated px-6 text-mono-xs text-fg">
                {bind.key}
              </kbd>
              <code className="min-w-0 text-mono-xs text-fg-secondary [overflow-wrap:anywhere] [unicode-bidi:isolate]">
                {bind.command === "" ? t("cards.bind.unbind") : bind.command}
              </code>
            </li>
          ))}
        </ul>
        {rest > 0 ? <p className="text-body-sm text-fg-muted">{t("cards.more", { count: rest })}</p> : null}
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

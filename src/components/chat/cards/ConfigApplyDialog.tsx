import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { dangerPath, dangerReasonKey } from "../../../lib/chat/dangers";
import type { ChatCardConfig, ChatCommandDanger, ConfigDocument } from "../../../lib/ipc";
import { useConfigActions, useScanChatCommands } from "../../../lib/queries";
import { ConfigCodeEditor } from "../../ConfigCodeEditor";
import { Button, Dialog, Input } from "../../ui";
import { ConfirmApplyDialog } from "../ConfirmApplyDialog";
import { DangerList } from "../DangerList";
import { Layer } from "../Layer";

interface ConfigApplyDialogProps {
  /** What `chat_card_to_config` answered, or a config file read into the same shape. */
  config: ChatCardConfig;
  onClose: () => void;
  onSaved: (document: ConfigDocument) => void;
}

/**
 * --- slice: chat cards ---
 *
 * A bind or a config from a chat, opened in the config editor of the Configs
 * screen as a new document.
 *
 * The lines the core's scan named are marked in the gutter and listed above
 * the editor. Nothing reaches a game from here: **Save to Configs** keeps
 * the document on the Configs screen, where the player turns it on for a
 * client. The save scans the text again as the player left it and, when a
 * dangerous line is still there, asks once more.
 */
export function ConfigApplyDialog({ config, onClose, onSaved }: ConfigApplyDialogProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const actions = useConfigActions();
  const scan = useScanChatCommands();
  const [draft, setDraft] = useState<ConfigDocument>(config.document);
  const [confirming, setConfirming] = useState<ChatCommandDanger[] | null>(null);

  const marks = useMemo(
    () =>
      config.dangers
        .filter((danger) => danger.reason !== "too_complex")
        .map((danger) => ({
          line: danger.line,
          message: `${dangerPath(danger)}: ${t(`dangers.reasons.${dangerReasonKey(danger.reason)}`)}`,
        })),
    [config.dangers, t],
  );

  const save = () =>
    actions.save.mutate(draft, {
      onSuccess: (saved) => {
        setConfirming(null);
        onSaved(saved);
      },
    });

  const onSave = () => {
    actions.save.reset();
    scan.mutate(draft.text, {
      onSuccess: (dangers) => (dangers.length > 0 ? setConfirming(dangers) : save()),
    });
  };

  const busy = actions.save.isPending || scan.isPending;
  const failure = scan.error ?? (confirming === null ? actions.save.error : null);

  return (
    <Layer>
      <Dialog
        wide
        title={t("apply.config.title")}
        body={t("apply.config.body")}
        onClose={() => {
          if (!busy) onClose();
        }}
        actions={
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {tCommon("actions.cancel")}
            </Button>
            <Button variant="primary" disabled={busy || draft.name.trim() === ""} onClick={onSave}>
              {t("apply.config.save")}
            </Button>
          </>
        }
      >
        <div className="flex max-h-[62vh] flex-col gap-12 overflow-y-auto pt-12 pr-4">
          <label className="flex flex-col gap-6 text-body-sm text-fg-secondary">
            {t("apply.config.name")}
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <DangerList dangers={config.dangers} />
          {config.skipped.length > 0 ? (
            <p className="rounded-md border border-line-warm bg-warm-subtle px-10 py-8 text-body-sm text-fg-warm">
              {t("apply.config.skipped", { keys: config.skipped.join(", ") })}
            </p>
          ) : null}
          <ConfigCodeEditor
            value={draft.text}
            onChange={(text) => setDraft((current) => ({ ...current, text }))}
            height={280}
            ariaLabel={t("apply.config.editor")}
            marks={marks}
          />
          {failure ? (
            <p role="alert" className="text-body-sm text-fg-danger">
              {errorText(failure)}
            </p>
          ) : null}
        </div>
      </Dialog>
      {confirming !== null ? (
        <ConfirmApplyDialog
          title={t("safety.apply.title", { name: draft.name })}
          body={t("safety.apply.body")}
          dangers={confirming}
          confirmLabel={t("safety.apply.confirm")}
          pending={actions.save.isPending}
          error={actions.save.error ? errorText(actions.save.error) : null}
          onCancel={() => setConfirming(null)}
          onConfirm={save}
        />
      ) : null}
    </Layer>
  );
}

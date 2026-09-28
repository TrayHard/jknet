import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useErrorText } from "../../../i18n/errors";
import type { ServerConfigDocument } from "../../../lib/ipc";
import { useServerConfigActions } from "../../../lib/queries";
import { ServerConfigEditor } from "../../server-configs/ServerConfigEditor";
import { Button, Dialog } from "../../ui";
import { Layer } from "../Layer";

/** Receiving only saves an independent document. It never starts a server. */
export function ServerConfigApplyDialog({ document, onClose, onSaved }: {
  document: ServerConfigDocument;
  onClose: () => void;
  onSaved: (document: ServerConfigDocument) => void;
}) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const { t: tClients } = useTranslation("clients");
  const { t: tServer } = useTranslation("serverConfigs");
  const errorText = useErrorText();
  const actions = useServerConfigActions();
  const [draft, setDraft] = useState({ ...document, id: "" });
  const [baseline] = useState(() => JSON.stringify({ ...document, id: "" }));
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = JSON.stringify(draft) !== baseline;
  // A chat dialog can sit above an already dirty library editor. Its discard
  // prompt must not overwrite the surrounding window's unsaved guard.
  const requestClose = () => {
    if (actions.save.isPending) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  return <Layer><Dialog wide="preview" title={t("serverConfig.receiveTitle")} body={t("serverConfig.receiveHint")}
    onClose={requestClose} actions={<>
      <Button variant="ghost" onClick={requestClose} disabled={actions.save.isPending}>{tCommon("actions.cancel")}</Button>
      <Button variant="primary" disabled={!draft.name.trim() || actions.save.isPending}
        onClick={() => actions.save.mutate(draft, { onSuccess: onSaved })}>{t("serverConfig.save")}</Button>
    </>}>
    <div className="max-h-[65vh] overflow-y-auto flex flex-col gap-12 py-12">
      <fieldset disabled={actions.save.isPending} className="min-w-0">
        <ServerConfigEditor draft={draft} onChange={next => { if (!actions.save.isPending) setDraft(next); }} />
      </fieldset>
      {actions.save.error ? <p role="alert" className="text-body-sm text-fg-danger">{errorText(actions.save.error)}</p> : null}
    </div>
  </Dialog>
    {confirmClose ? <Dialog variant="danger" title={tClients("clientWindow.profiles.unsaved.title")} body={tServer("unsaved")}
      onClose={() => setConfirmClose(false)} actions={<>
        <Button variant="ghost" onClick={() => setConfirmClose(false)}>{tClients("clientWindow.profiles.unsaved.keep")}</Button>
        <Button variant="danger" onClick={onClose}>{tClients("clientWindow.profiles.unsaved.discard")}</Button>
      </>} /> : null}
  </Layer>;
}

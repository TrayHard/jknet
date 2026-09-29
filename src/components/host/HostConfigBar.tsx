import { FilePen, Save } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useErrorText } from "../../i18n/errors";
import { hostConfigCompatible, hostConfigText, hostModId } from "../../lib/hostConfig";
import type { Game, HostClientOption, ServerConfigDocument } from "../../lib/ipc";
import { useServerConfigActions } from "../../lib/queries";
import { MOD_CATALOG } from "../../lib/serverConfigCatalog";
import { Button, Dialog, Input, Select } from "../ui";
import type { HostForm } from "./hostModel";

export function HostConfigBar({ game, documents, client, form, onChange, onSelecting, problem, loading, scoreCvar }: {
  game: Game;
  documents: ServerConfigDocument[];
  client: HostClientOption | undefined;
  form: HostForm;
  onChange: (update: (form: HostForm) => HostForm) => void;
  onSelecting: (pending: boolean) => void;
  problem: string | null;
  loading: boolean;
  scoreCvar: string | null;
}) {
  const { t } = useTranslation("host");
  const navigate = useNavigate();
  const actions = useServerConfigActions();
  const errorText = useErrorText();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [selectionError, setSelectionError] = useState<unknown>(null);
  const selected = documents.find((document) => document.id === form.settings.serverConfigId);
  const modId = hostModId(client);
  const modName = (id: string) => MOD_CATALOG.find((mod) => mod.id === id)?.name ?? id;
  return <section className="flex flex-col gap-6" aria-label={t("setup.config.label")}>
    <div className="flex flex-wrap items-end gap-8">
      <label className="flex min-w-180 flex-1 flex-col gap-6 text-label-xs text-fg-muted">
        {t("setup.config.label")}
        <Select
          ariaLabel={t("setup.config.label")}
          value={form.settings.serverConfigId ?? ""}
          disabled={loading || actions.check.isPending}
          options={[
            { value: "", label: t("setup.config.none") },
            ...documents.map((document) => ({
              value: document.id,
              label: `${document.name} · ${modName(document.modId)}`,
              disabled: !hostConfigCompatible(document, client),
              hint: hostConfigCompatible(document, client) ? undefined : t("setup.config.needsMod", { mod: modName(document.modId) }),
            })),
            ...(form.settings.serverConfigId && !selected ? [{ value: form.settings.serverConfigId, label: t("setup.config.missing"), disabled: true }] : []),
          ]}
          onChange={(id) => {
            setSelectionError(null);
            if (!id) { onChange((current) => ({ ...current, settings: { ...current.settings, serverConfigId: null } })); return; }
            const document = documents.find((entry) => entry.id === id);
            if (!document) return;
            const clientId = form.settings.clientId;
            onSelecting(true);
            onChange((current) => ({ ...current, settings: { ...current.settings, serverConfigId: id } }));
            actions.check.mutate(document, {
              onSuccess: (checked) => onChange((current) => current.settings.clientId !== clientId || current.settings.serverConfigId !== id ? current : ({
                ...current, settings: { ...current.settings, ...checked.settings, serverConfigId: id },
              })),
              onError: setSelectionError,
              onSettled: () => onSelecting(false),
            });
          }}
        />
      </label>
      <Button variant="ghost" icon={<FilePen size={16} />} onClick={() => navigate(`/configs?scope=server${selected ? `&id=${encodeURIComponent(selected.id)}` : ""}`)}>
        {t("setup.config.manage")}
      </Button>
      <Button variant="ghost" icon={<Save size={16} />} disabled={!client || !modId || actions.check.isPending} onClick={() => {
        setName(selected?.name ?? form.settings.serverName);
        actions.save.reset();
        setSaving(true);
      }}>{t("setup.config.saveAs")}</Button>
    </div>
    {problem || selectionError ? <p role="alert" className="text-body-sm text-fg-danger">{problem ?? errorText(selectionError)}</p> : null}
    {saving ? <Dialog title={t("setup.config.saveAs")} body={t("setup.config.saveHint")} onClose={() => { if (!actions.save.isPending) setSaving(false); }} actions={<>
      <Button variant="ghost" disabled={actions.save.isPending} onClick={() => setSaving(false)}>{t("setup.config.cancel")}</Button>
      <Button variant="primary" disabled={!name.trim() || !modId || actions.save.isPending} onClick={() => {
        if (!modId) return;
        actions.save.mutate({ id: "", name, game, modId, text: hostConfigText(form.settings, scoreCvar, selected?.text) }, {
          onSuccess: (document) => {
            setSaving(false);
            onChange((current) => ({ ...current, settings: { ...current.settings, serverConfigId: document.id } }));
          },
        });
      }}>{t("setup.config.save")}</Button>
    </>}>
      <Input aria-label={t("setup.config.name")} value={name} onChange={(event) => setName(event.target.value)} />
      {actions.save.error ? <p role="alert" className="mt-8 text-body-sm text-fg-danger">{errorText(actions.save.error)}</p> : null}
    </Dialog> : null}
  </section>;
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useClients,
  useConfigs,
  useConfigActions,
  useClientConfigFiles,
  useConfigConflicts,
  useClientConfigContext,
} from "../lib/queries";
import { clientsOfGame, useActiveGame } from "../lib/game";
import type { ConfigDocument, ConfigLayer } from "../lib/ipc";
import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, Input, Select, Dialog } from "../components/ui";
import { useUnsavedGuard } from "../components/client/UnsavedGuard";
import { BindEditor } from "../components/BindEditor";
import { ConfigStudio } from "../components/ConfigStudio";
import { FileText, RefreshCw, Share2, Trash2 } from "lucide-react";
import { useErrorText } from "../i18n/errors";
import { configCommands, type BindSource } from "../lib/quakeConfig";
// --- slice: chat cards ---
import { configCard, fitsConfigCard } from "../lib/chat/cardDrafts";
import { useShareDialog } from "../components/chat/ShareToChatDialog";

export function ConfigsPage() {
  const { t } = useTranslation("common"),
    errorText = useErrorText(),
    guard = useUnsavedGuard();
  const { t: tChat } = useTranslation("chat"),
    share = useShareDialog();
  const book = useConfigs(),
    actions = useConfigActions(),
    clients = useClients(),
    game = useActiveGame();
  const [clientId, setClientId] = useState(""),
    [draft, setDraft] = useState<ConfigDocument | null>(null),
    [baseline, setBaseline] = useState("");
  const [tab, setTab] = useState("editor"),
    [selected, setSelected] = useState<string[]>([]),
    [mergeOpen, setMergeOpen] = useState(false),
    [mergeName, setMergeName] = useState(""),
    [choices, setChoices] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false),
    [removing, setRemoving] = useState<string | null>(null);
  const gameClients = clientsOfGame(clients.data, game),
    client = gameClients.find((c) => c.id === clientId) ?? gameClients[0];
  const files = useClientConfigFiles(client?.id ?? ""),
    context = useClientConfigContext(client?.id ?? ""),
    conflicts = useConfigConflicts(selected);
  const documents = (book.data?.documents ?? []).filter((d) => d.game === game),
    layers = book.data?.clients[client?.id ?? ""] ?? [];
  const defaultSource = book.data?.defaults?.[client?.id ?? ""] ?? "";
  const bindSources: BindSource[] = (context.data?.sources ?? []).map(file => ({ text: file.text, source: file.path, kind: "inherited" }));
  const defaultDocument = documents.find(doc => `document:${doc.id}` === defaultSource);
  const defaultFile = files.data?.find(file => `file:${file.path}` === defaultSource);
  const addDocument = (doc: ConfigDocument, kind: BindSource["kind"]) => bindSources.push({ text: doc.id === draft?.id ? draft.text : doc.text, source: doc.name || t("configStudio.currentConfig"), kind: doc.id === draft?.id ? "edited" : kind });
  if (defaultDocument) addDocument(defaultDocument, "inherited");
  if (defaultFile) bindSources.push({ text: defaultFile.text, source: defaultFile.path, kind: "inherited" });
  const orderedLayers = [...layers].filter(layer => layer.enabled && `document:${layer.configId}` !== defaultSource).sort((a, b) => a.priority - b.priority);
  for (const layer of orderedLayers) {
    const doc = documents.find(doc => doc.id === layer.configId);
    if (doc) addDocument(doc, "layer");
  }
  const draftAssigned = !!draft?.id && (defaultDocument?.id === draft.id || orderedLayers.some(layer => layer.configId === draft.id));
  if (draft && !draftAssigned) bindSources.push({ text: draft.text, source: draft.name || t("configStudio.currentConfig"), kind: "edited" });
  const missingDefault = !!defaultSource && !defaultDocument && !defaultFile;
  const unresolved = [...(context.data?.unresolved ?? []), ...bindSources.filter(source => source.kind !== "inherited" || source.source === defaultFile?.path || source.source === defaultDocument?.name).flatMap(source => configCommands(source.text).filter(command => /^(exec|vstr)\s/i.test(command)))];
  const dirty = !!draft && JSON.stringify(draft) !== baseline;
  useEffect(() => {
    guard.setDirty(dirty);
    return () => guard.setDirty(false);
  }, [guard, dirty]);
  useEffect(() => {
    setDraft(null);
    setSelected([]);
    setMergeOpen(false);
  }, [game]);
  const edit = (document: ConfigDocument) =>
    guard.ask(() => {
      setDraft({ ...document });
      setBaseline(JSON.stringify(document));
    });
  const setLayers = (next: ConfigLayer[]) => {
    if (client) actions.layers.mutate({ clientId: client.id, layers: next });
  };
  const failure =
    book.error ??
    actions.save.error ??
    actions.layers.error ??
    actions.defaultConfig.error ??
    context.error ??
    actions.merge.error ??
    actions.remove.error ??
    files.error ??
    conflicts.error;
  return (
    <Page>
      <PageHeader title={t("configs.title")} subtitle={t("configs.subtitle")} />
      <div className="flex flex-wrap gap-8 mb-20">
        <Button
          onClick={() =>
            edit({
              id: "",
              name: "",
              text: "",
              game,
              sourceClient: null,
              sourceFile: null,
            })
          }
        >
          {t("configs.create")}
        </Button>
        <Button
          variant="secondary"
          disabled={!client}
          onClick={() => {
            setImportOpen(true);
            void files.refetch();
          }}
        >
          {t("configs.import")}
        </Button>
        <Button
          variant="secondary"
          disabled={selected.length < 2}
          onClick={() => {
            setChoices({});
            setMergeName("");
            setMergeOpen(true);
          }}
        >
          {t("configs.merge")}
        </Button>
      </div>
      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {errorText(failure)}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-20">
        <section
          aria-label={t("configs.clientSettings")}
          className="rounded-lg border border-line bg-surface p-16"
        >
          <div className="flex flex-wrap items-end gap-16">
            <div className="flex min-w-0 flex-1 basis-180 flex-col gap-8">
              <span className="text-body-sm text-fg-secondary">{t("configs.client")}</span>
              <Select
                ariaLabel={t("configs.client")}
                value={client?.id ?? ""}
                options={gameClients.map((c) => ({ value: c.id, label: c.name }))}
                onChange={setClientId}
              />
            </div>
            <div className="flex min-w-0 flex-[2] basis-300 flex-col gap-8">
              <span className="text-body-sm text-fg-secondary">{t("configs.defaultConfig")}</span>
              <Select
                ariaLabel={t("configs.defaultConfig")}
                value={defaultSource}
                disabled={!client || actions.defaultConfig.isPending || files.isLoading || book.isLoading}
                options={[
                  { value: "", label: t("configs.clientDefault") },
                  ...documents.map(doc => ({ value: `document:${doc.id}`, label: doc.name })),
                  ...(files.data ?? []).map(file => ({ value: `file:${file.path}`, label: file.path })),
                  ...(missingDefault ? [{ value: defaultSource, label: t("configs.missingDefault"), disabled: true }] : []),
                ]}
                onChange={source => { if (client) actions.defaultConfig.mutate({ clientId: client.id, source: source || null }); }}
              />
            </div>
            <Button
              variant="secondary"
              icon={<RefreshCw size={14} />}
              disabled={!client || context.isFetching || files.isFetching}
              onClick={() => { void context.refetch(); void files.refetch(); }}
            >
              {t("configs.refreshDefaults")}
            </Button>
          </div>
          <details className="mt-12 text-body-xs text-fg-muted">
            <summary className="w-fit cursor-pointer hover:text-fg-secondary">
              {t("configs.applicationOrder")}
            </summary>
            <div className="mt-8 flex flex-col gap-4">
              <p>{t("configs.defaultHint")}</p>
              <p>{t("configs.priorityHint")}</p>
            </div>
          </details>
        </section>
        {documents.length > 0 ? (
        <section aria-label={t("configs.savedConfigs")} className="min-w-0">
          <div className="mb-12 flex items-center gap-8">
            <h2 className="text-heading-sm text-fg">{t("configs.savedConfigs")}</h2>
            <Badge>{documents.length}</Badge>
          </div>
          <div className="flex max-h-224 flex-col gap-8 overflow-y-auto">
          {documents.map((document) => {
            const layer = layers.find((l) => l.configId === document.id);
            return (
              <div
                key={document.id}
                className={`flex flex-wrap items-center gap-12 rounded-md border p-12 ${draft?.id === document.id ? "border-line-accent bg-accent-subtle" : "border-line bg-surface"}`}
              >
                <div className="flex min-w-0 flex-1 basis-200 items-center gap-12">
                  <input
                    type="checkbox"
                    aria-label={t("configs.selectMerge", {
                      name: document.name,
                    })}
                    checked={selected.includes(document.id)}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, document.id]
                          : ids.filter((id) => id !== document.id),
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-current={draft?.id === document.id ? "true" : undefined}
                    className="min-w-0 flex-1 break-words text-left text-body-md text-fg hover:text-fg-accent"
                    onClick={() => edit(document)}
                  >
                    {document.name}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-16">
                  <label className="text-body-sm text-fg-secondary flex items-center gap-8">
                    <input
                      type="checkbox"
                      checked={defaultSource === `document:${document.id}` || (layer?.enabled ?? false)}
                      disabled={!client || actions.layers.isPending || defaultSource === `document:${document.id}`}
                      onChange={(e) =>
                        setLayers([
                          ...layers.filter((l) => l.configId !== document.id),
                          {
                            configId: document.id,
                            enabled: e.target.checked,
                            priority: layer?.priority ?? 0,
                          },
                        ])
                      }
                    />
                    {t(defaultSource === `document:${document.id}` ? "configs.defaultConfig" : "configs.enabled")}
                  </label>
                  <label className="text-body-xs text-fg-muted flex items-center gap-8">
                    {t("configs.priority")}
                    <Input
                      type="number"
                      className="w-72"
                      defaultValue={layer?.priority ?? 0}
                      key={`${client?.id}-${layer?.priority}`}
                      disabled={!client || actions.layers.isPending || defaultSource === `document:${document.id}`}
                      onBlur={(e) => {
                        const priority = Number(e.target.value);
                        if (
                          Number.isInteger(priority) &&
                          priority !== (layer?.priority ?? 0)
                        )
                          setLayers([
                            ...layers.filter((l) => l.configId !== document.id),
                            {
                              configId: document.id,
                              enabled: layer?.enabled ?? false,
                              priority,
                            },
                          ]);
                      }}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-4"
                    aria-label={t("configs.remove")}
                    title={t("configs.remove")}
                    icon={<Trash2 size={14} />}
                    onClick={() => setRemoving(document.id)}
                  />
                </div>
              </div>
            );
          })}
          </div>
        </section>
        ) : !draft && !book.isLoading ? (
          <section className="flex min-h-180 flex-col items-center justify-center gap-12 rounded-lg border border-dashed border-line bg-surface px-24 py-32 text-center">
            <FileText size={28} className="text-fg-muted" aria-hidden="true" />
            <h2 className="text-heading-md text-fg">{t("configs.emptyTitle")}</h2>
            <p className="max-w-560 text-body-md text-fg-secondary">{t("configs.empty")}</p>
          </section>
        ) : null}
        {draft ? (
          <section className="min-w-0 flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
            <label className="text-body-sm text-fg-secondary">
              {t("configs.name")}
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <div className="flex gap-8">
              {(["editor", "binds"] as const).map((value) => (
                <Button
                  type="button"
                  key={value}
                  variant={tab === value ? "primary" : "ghost"}
                  onClick={() => setTab(value)}
                >
                  {t(`configs.${value}`)}
                </Button>
              ))}
            </div>
            {tab === "editor" ? (
              <ConfigStudio
                value={draft.text}
                onChange={(text) => setDraft({ ...draft, text })}
              />
            ) : (
              <BindEditor
                key={`${client?.id}-${draft.id}-${defaultSource}`}
                text={draft.text}
                onChange={(text) => setDraft({ ...draft, text })}
                clientId={client?.id ?? ""}
                configs={documents}
                sources={bindSources}
                loading={context.isLoading || files.isLoading}
                unavailable={!!context.error || !!files.error || missingDefault || !client}
                unresolved={unresolved}
                previewOnly={!draftAssigned}
              />
            )}
            {draft.sourceFile ? (
              <p className="text-body-xs text-fg-muted">
                {t("configs.importSource", { source: draft.sourceFile })}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-8 border-t border-line pt-12">
              {/* --- slice: chat cards --- the config as it stands in the
                  editor, saved or not, as a config card. */}
              {share.available ? (
                <Button
                  variant="ghost"
                  icon={<Share2 size={14} />}
                  disabled={!draft.text.trim() || !fitsConfigCard(draft.text)}
                  title={fitsConfigCard(draft.text) ? undefined : tChat("pickers.config.tooLarge")}
                  onClick={() => share.open({ kind: "card", card: configCard({ name: draft.name, text: draft.text }) })}
                >
                  {tChat("share.action")}
                </Button>
              ) : null}
              <Button
                disabled={!draft.name.trim() || actions.save.isPending}
                onClick={() =>
                  actions.save.mutate(draft, {
                    onSuccess: (doc) => {
                      setDraft(doc);
                      setBaseline(JSON.stringify(doc));
                      guard.setDirty(false);
                    },
                  })
                }
              >
                {t("configs.save")}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
      {importOpen ? (
        <Dialog
          wide
          title={t("configs.import")}
          body={t("configs.importHint")}
          onClose={() => setImportOpen(false)}
          actions={
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              {t("configs.close")}
            </Button>
          }
        >
          <div className="flex flex-col gap-8">
            {files.data?.map((file) => (
              <Button
                key={file.path}
                variant="secondary"
                onClick={() => {
                  setImportOpen(false);
                  edit({
                    id: "",
                    name: file.path,
                    text: file.text,
                    game,
                    sourceClient: client?.id ?? null,
                    sourceFile: file.path,
                  });
                }}
              >
                {file.path}
              </Button>
            ))}
          </div>
          {!files.data?.length ? (
            <p className="text-body-sm text-fg-muted">{t("configs.noFiles")}</p>
          ) : null}
        </Dialog>
      ) : null}
      {mergeOpen ? (
        <Dialog
          wide
          title={t("configs.merge")}
          body={t("configs.mergeHint")}
          onClose={() => setMergeOpen(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setMergeOpen(false)}>
                {t("configs.close")}
              </Button>
              <Button
                disabled={
                  !mergeName.trim() ||
                  conflicts.isFetching ||
                  actions.merge.isPending ||
                  (conflicts.data ?? []).some((c) => !choices[c.key])
                }
                onClick={() =>
                  actions.merge.mutate(
                    { ids: selected, choices, name: mergeName },
                    {
                      onSuccess: (doc) => {
                        setMergeOpen(false);
                        edit(doc);
                      },
                    },
                  )
                }
              >
                {t("configs.mergeSave")}
              </Button>
            </>
          }
        >
          <Input
            aria-label={t("configs.name")}
            value={mergeName}
            onChange={(e) => setMergeName(e.target.value)}
          />
          <div className="flex flex-col gap-12 mt-12">
            {conflicts.data?.map((conflict) => (
              <div
                key={conflict.key}
                className="p-12 rounded-md border border-line-danger bg-input"
              >
                <p className="text-mono-sm text-fg">{conflict.key}</p>
                {conflict.values.map((v) => (
                  <label
                    key={v.configId}
                    className="flex gap-8 text-body-sm text-fg-secondary p-8"
                  >
                    <input
                      type="radio"
                      name={conflict.key}
                      checked={choices[conflict.key] === v.configId}
                      onChange={() =>
                        setChoices((c) => ({
                          ...c,
                          [conflict.key]: v.configId,
                        }))
                      }
                    />
                    <span className="break-all">
                      {v.configName}: <code>{v.value}</code>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          {!conflicts.data?.length ? (
            <p className="text-body-sm text-fg-muted">
              {t("configs.noConflicts")}
            </p>
          ) : null}
        </Dialog>
      ) : null}
      {removing ? (
        <Dialog
          title={t("configs.remove")}
          body={t("configs.removeHint")}
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                {t("configs.close")}
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  actions.remove.mutate(removing, {
                    onSuccess: () => {
                      if (draft?.id === removing) {
                        setDraft(null);
                        guard.setDirty(false);
                      }
                      setSelected((ids) => ids.filter((id) => id !== removing));
                      setRemoving(null);
                    },
                  })
                }
              >
                {t("configs.remove")}
              </Button>
            </>
          }
        />
      ) : null}
      {share.dialog}
    </Page>
  );
}

import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  FilePlus2,
  FolderInput,
  FolderOpen,
  LogIn,
  PackagePlus,
  Play,
  Plus,
  Save,
  ServerCog,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ConfigCodeEditor } from "../components/ConfigCodeEditor";
import { EngineLogo } from "../components/EngineLogo";
import { Page, PageHeader } from "../components/PageHeader";
import { ConnectDialog } from "../components/servers/ConnectDialog";
import { Tabs } from "../components/servers/Tabs";
import { useToasts } from "../components/ToastsProvider";
import { Badge, Button, Dialog, EmptyState, Input, Select, Toggle } from "../components/ui";
import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
import { useActiveGame, useGameNames } from "../lib/game";
import {
  type Game,
  type ServerEngineView,
  type ServerFile,
  type ServerInstanceView,
  type ServerMod,
  type UpdateServerInstanceInput,
  serverInstancesIpc,
} from "../lib/ipc";
import {
  useCompleteJkhubListing,
  useJkhubListing,
  useServerEngines,
  useServerInstanceActions,
  useServerInstanceFiles,
  useServerInstances,
  useServerMods,
} from "../lib/queries";
import { filterServerModCards } from "../lib/serverModSearch";
import { serverInstanceConnectTarget } from "../lib/serverInstanceConnect";

type PageTab = "instances" | "engines" | "mods";
type DetailTab = "settings" | "config" | "files" | "console";

/** Dedicated servers are persistent installations, not throwaway launch profiles. */
export function ServerInstancesPage() {
  const { t } = useTranslation("serverInstances");
  const activeGame = useActiveGame();
  const instancesQuery = useServerInstances();
  const enginesQuery = useServerEngines();
  const modsQuery = useServerMods();
  const actions = useServerInstanceActions();
  const [tab, setTab] = useState<PageTab>("instances");
  const [createOpen, setCreateOpen] = useState(false);
  const [addModOpen, setAddModOpen] = useState(false);
  const instances = (instancesQuery.data ?? []).filter((item) => item.game === activeGame);
  const engines = (enginesQuery.data ?? []).filter((item) => item.game === activeGame && item.canHost);
  const mods = (modsQuery.data ?? []).filter((item) => item.game === activeGame);

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={tab === "instances" ? (
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
            {t("actions.create")}
          </Button>
        ) : tab === "mods" ? (
          <Button variant="primary" icon={<PackagePlus size={16} />} onClick={() => setAddModOpen(true)}>
            {t("actions.addMod")}
          </Button>
        ) : null}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "instances", label: t("tabs.instances"), count: instances.length },
          { id: "engines", label: t("tabs.engines"), count: engines.length },
          { id: "mods", label: t("tabs.mods"), count: mods.length },
        ]}
      />

      <div className="pt-20">
        {tab === "instances" ? (
          <InstancesTab instances={instances} engines={engines} mods={mods} />
        ) : tab === "engines" ? (
          <EnginesTab engines={engines} />
        ) : (
          <ModsTab mods={mods} />
        )}
      </div>

      {createOpen ? (
        <CreateServerDialog
          game={activeGame}
          engines={engines}
          mods={mods}
          busy={actions.create.isPending}
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => {
            await actions.create.mutateAsync(input);
            setCreateOpen(false);
          }}
        />
      ) : null}
      {addModOpen ? (
        <AddModDialog game={activeGame} onClose={() => setAddModOpen(false)} />
      ) : null}
    </Page>
  );
}

function InstancesTab({
  instances,
  engines,
  mods,
}: {
  instances: ServerInstanceView[];
  engines: ServerEngineView[];
  mods: ServerMod[];
}) {
  const { t } = useTranslation("serverInstances");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = instances.find((item) => item.id === selectedId) ?? null;

  if (instances.length === 0) {
    return (
      <EmptyState
        icon={<ServerCog size={28} />}
        title={t("instances.emptyTitle")}
        text={t("instances.emptyBody")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-16">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-12">
        {instances.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            engine={engines.find((item) => item.engineId === server.engineId) ?? null}
            mod={mods.find((item) => item.id === server.modId) ?? null}
            expanded={server.id === selectedId}
            onToggle={() => setSelectedId(server.id === selectedId ? null : server.id)}
          />
        ))}
      </div>
      {selected ? <ServerDetails server={selected} engines={engines} mods={mods} /> : null}
    </div>
  );
}

function ServerCard({
  server,
  engine,
  mod,
  expanded,
  onToggle,
}: {
  server: ServerInstanceView;
  engine: ServerEngineView | null;
  mod: ServerMod | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const actions = useServerInstanceActions();
  const [connectOpen, setConnectOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const running = server.status.state === "running";
  const busy = actions.start.isPending || actions.stop.isPending;
  const fail = (error: unknown) => show(`server:${server.id}:error`, {
    variant: "error",
    title: t("feedback.actionFailed"),
    text: errorText(error),
  });

  return (
    <article className={`flex flex-col gap-14 rounded-lg border p-16 bg-surface ${expanded ? "border-line-accent" : "border-line"}`}>
      <button type="button" onClick={onToggle} className="flex items-start gap-12 text-left cursor-pointer">
        <EngineLogo engineId={server.engineId} name={engine?.name ?? server.engineId} size={44} />
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-8">
            <span className="text-body-lg-medium text-fg truncate">{server.name}</span>
            <Badge tone={running ? "success" : "neutral"}>
              {t(running ? "instances.running" : "instances.stopped")}
            </Badge>
          </span>
          <span className="block mt-4 text-body-sm text-fg-secondary truncate">
            {engine?.name ?? server.engineId} · {mod?.name ?? t("instances.noMod")}
          </span>
          <span className="block mt-2 text-mono-xs text-fg-muted">
            {t("instances.port", { port: server.port })}
          </span>
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-8">
        {running ? (
          <>
            <Button size="sm" variant="primary" icon={<LogIn size={14} />} onClick={() => setConnectOpen(true)}>
              {t("actions.connect")}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} icon={<Square size={14} />} onClick={() => void actions.stop.mutateAsync(server.id).catch(fail)}>
              {t("actions.stop")}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" disabled={busy || engine?.installed == null} icon={<Play size={14} />} onClick={() => void actions.start.mutateAsync(server.id).catch(fail)}>
            {t("actions.start")}
          </Button>
        )}
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void actions.openFolder.mutateAsync(server.id).catch(fail)}>
          {t("actions.openFolder")}
        </Button>
        <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => setCloneOpen(true)}>
          {t("actions.clone")}
        </Button>
        <Button size="sm" variant="ghost" icon={<Settings2 size={14} />} onClick={onToggle}>
          {t("actions.manage")}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Trash2 size={14} />} disabled={running} onClick={() => setDeleteOpen(true)} aria-label={t("actions.delete")} />
      </div>
      {!running && engine?.installed == null ? (
        <p className="text-body-xs text-fg-warm">{t("instances.engineRequired")}</p>
      ) : null}

      {connectOpen && running ? (
        <ConnectDialog
          server={serverInstanceConnectTarget(server)}
          onClose={() => setConnectOpen(false)}
        />
      ) : null}
      {cloneOpen ? (
        <NameDialog
          title={t("clone.title")}
          body={t("clone.body")}
          initial={`${server.name} ${t("clone.copySuffix")}`}
          confirm={t("actions.clone")}
          busy={actions.clone.isPending}
          onClose={() => setCloneOpen(false)}
          onConfirm={async (name) => {
            await actions.clone.mutateAsync({ serverId: server.id, name });
            setCloneOpen(false);
          }}
        />
      ) : null}
      {deleteOpen ? (
        <Dialog
          title={t("deleteInstance.title")}
          body={t("deleteInstance.body", { name: server.name })}
          variant="danger"
          onClose={() => setDeleteOpen(false)}
          actions={<>
            <Button onClick={() => setDeleteOpen(false)}>{t("actions.cancel")}</Button>
            <Button variant="danger" disabled={actions.remove.isPending} onClick={() => void actions.remove.mutateAsync(server.id).then(() => setDeleteOpen(false)).catch(fail)}>
              {t("actions.delete")}
            </Button>
          </>}
        />
      ) : null}
    </article>
  );
}

function ServerDetails({ server, engines, mods }: { server: ServerInstanceView; engines: ServerEngineView[]; mods: ServerMod[] }) {
  const { t } = useTranslation("serverInstances");
  const [tab, setTab] = useState<DetailTab>("settings");
  return (
    <section className="rounded-lg border border-line bg-surface overflow-hidden">
      <div className="flex flex-wrap items-center gap-12 px-16 pt-16">
        <div className="flex-1 min-w-0">
          <h2 className="text-display-md text-fg truncate">{server.name}</h2>
          <p className="text-body-sm text-fg-secondary">{t("details.subtitle")}</p>
        </div>
      </div>
      <Tabs
        className="mt-12 px-8"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "settings", label: t("details.tabs.settings") },
          { id: "config", label: t("details.tabs.config") },
          { id: "files", label: t("details.tabs.files"), count: server.templateFiles.length },
          { id: "console", label: t("details.tabs.console") },
        ]}
      />
      <div className="p-16">
        {tab === "settings" ? <ServerSettings server={server} engines={engines} mods={mods} onEditConfig={() => setTab("config")} /> : null}
        {tab === "config" ? <ServerStartupConfig server={server} /> : null}
        {tab === "files" ? <ServerFiles server={server} /> : null}
        {tab === "console" ? <ServerConsole server={server} /> : null}
      </div>
    </section>
  );
}

function ServerSettings({ server, engines, mods, onEditConfig }: { server: ServerInstanceView; engines: ServerEngineView[]; mods: ServerMod[]; onEditConfig: () => void }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const actions = useServerInstanceActions();
  const [draft, setDraft] = useState<UpdateServerInstanceInput>(() => serverDraft(server));
  useEffect(() => setDraft(serverDraft(server)), [server]);
  const running = server.status.state === "running";
  const save = async () => {
    try {
      await actions.update.mutateAsync({ serverId: server.id, input: draft });
      show(`server:${server.id}:saved`, { variant: "success", title: t("feedback.saved") });
    } catch (error) {
      show(`server:${server.id}:error`, { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) });
    }
  };

  return (
    <div className="grid grid-cols-2 gap-16 @max-[760px]/page:grid-cols-1">
      <Field label={t("fields.name")}><Input value={draft.name} disabled={running} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label={t("fields.port")}><Input type="number" min={1} max={65535} value={draft.port} disabled={running} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></Field>
      <Field label={t("fields.engine")}>
        <Select value={draft.engineId} disabled={running} ariaLabel={t("fields.engine")} onChange={(engineId) => setDraft({ ...draft, engineId })} options={engines.map((engine) => ({ value: engine.engineId, label: engine.name, hint: engine.installed ? engine.installed.version : t("engines.notInstalled") }))} />
      </Field>
      <Field label={t("fields.mod")}>
        <Select value={draft.modId ?? ""} disabled={running} ariaLabel={t("fields.mod")} onChange={(value) => setDraft({ ...draft, modId: value || null })} options={[{ value: "", label: t("instances.noMod") }, ...mods.map((mod) => ({ value: mod.id, label: mod.name, hint: mod.folder }))]} />
      </Field>
      <div className="flex flex-col gap-6">
        <span className="text-label-xs text-fg-muted">{t("fields.startupConfig")}</span>
        <div className="flex gap-8">
          <Input className="flex-1" value={draft.startupConfig} disabled={running} onChange={(event) => setDraft({ ...draft, startupConfig: event.target.value })} />
          <Button icon={<FileCode2 size={16} />} onClick={onEditConfig}>{t("actions.editConfig")}</Button>
        </div>
      </div>
      <label className="flex items-center gap-10 self-end h-36 text-body-sm text-fg-secondary">
        <Toggle checked={draft.public} disabled={running} label={t("fields.public")} onChange={(value) => setDraft({ ...draft, public: value })} />
        {t("fields.public")}
      </label>
      <Field label={t("fields.engineArgs")}><Input value={draft.engineArgs} disabled={running} onChange={(event) => setDraft({ ...draft, engineArgs: event.target.value })} placeholder={t("fields.engineArgsPlaceholder")} /></Field>
      <Field label={t("fields.modArgs")}><Input value={draft.modArgs} disabled={running} onChange={(event) => setDraft({ ...draft, modArgs: event.target.value })} placeholder={t("fields.modArgsPlaceholder")} /></Field>
      <div className="col-span-2 @max-[760px]/page:col-span-1 flex justify-end">
        <Button variant="primary" icon={<Save size={16} />} disabled={running || actions.update.isPending || !draft.name.trim()} onClick={() => void save()}>{t("actions.save")}</Button>
      </div>
    </div>
  );
}

function ServerStartupConfig({ server }: { server: ServerInstanceView }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const actions = useServerInstanceActions();
  const path = `home/${server.modFolder ?? "base"}/${server.startupConfig}`;
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const running = server.status.state === "running";

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void serverInstancesIpc.readText(server.id, path).then((value) => {
      if (!active) return;
      setText(value);
      setSavedText(value);
    }).catch((error) => {
      if (active) setLoadError(error);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [path, server.id]);

  const save = async () => {
    try {
      await actions.saveText.mutateAsync({ serverId: server.id, path, text, template: true });
      setSavedText(text);
      show(`server:${server.id}:config:saved`, { variant: "success", title: t("feedback.configSaved") });
    } catch (error) {
      show(`server:${server.id}:config:error`, { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) });
    }
  };

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-start gap-12">
        <div className="flex-1 min-w-240">
          <h3 className="text-body-lg-medium text-fg">{t("config.title")}</h3>
          <p className="mt-3 text-body-sm text-fg-secondary">{t("config.description")}</p>
          <p className="mt-5 text-mono-xs text-fg-muted break-all">{path}</p>
        </div>
        <Button
          variant="primary"
          icon={<Save size={16} />}
          disabled={running || loading || loadError !== null || text === savedText || actions.saveText.isPending}
          onClick={() => void save()}
        >
          {t("actions.saveConfig")}
        </Button>
      </div>
      {running ? <p className="rounded-md border border-line bg-elevated px-12 py-9 text-body-sm text-fg-secondary">{t("config.runningHint")}</p> : null}
      {loading ? <p className="py-32 text-center text-body-sm text-fg-muted">{t("config.loading")}</p> : null}
      {loadError !== null ? <p className="rounded-md border border-status-error px-12 py-9 text-body-sm text-status-error">{errorText(loadError)}</p> : null}
      {!loading && loadError === null ? (
        <ConfigCodeEditor value={text} onChange={setText} height={520} ariaLabel={t("config.editorLabel")} completions={[]} />
      ) : null}
      <p className="text-body-xs text-fg-muted">{t("config.otherFilesHint")}</p>
    </div>
  );
}

function ServerFiles({ server }: { server: ServerInstanceView }) {
  const { t } = useTranslation("serverInstances");
  const format = useFormat();
  const errorText = useErrorText();
  const { show } = useToasts();
  const filesQuery = useServerInstanceFiles(server.id);
  const actions = useServerInstanceActions();
  const [editor, setEditor] = useState<{ path: string; text: string; template: boolean } | null>(null);
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const running = server.status.state === "running";
  const destination = `home/${server.modFolder ?? "base"}`;
  const fail = (error: unknown) => show(`server:${server.id}:files:error`, { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) });
  const importPaths = async (directory: boolean) => {
    const picked = await open({ directory, multiple: !directory, title: t(directory ? "files.pickFolder" : "files.pickFiles") });
    const paths = typeof picked === "string" ? [picked] : picked ?? [];
    if (paths.length > 0) await actions.addFiles.mutateAsync({ serverId: server.id, destination, sourcePaths: paths });
  };
  const edit = async (file: ServerFile) => {
    try {
      const text = await serverInstancesIpc.readText(server.id, file.path);
      setEditor({ path: file.path, text, template: file.template });
    } catch (error) { fail(error); }
  };

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        <Button size="sm" disabled={running} icon={<FolderInput size={14} />} onClick={() => void importPaths(false).catch(fail)}>{t("files.importFiles")}</Button>
        <Button size="sm" disabled={running} icon={<FolderInput size={14} />} onClick={() => void importPaths(true).catch(fail)}>{t("files.importFolder")}</Button>
        <Button size="sm" disabled={running} variant="ghost" icon={<FilePlus2 size={14} />} onClick={() => setEditor({ path: `${destination}/server.cfg`, text: "", template: true })}>{t("files.newConfig")}</Button>
        <span className="ml-auto text-body-xs text-fg-muted">{t("files.cloneHint")}</span>
      </div>
      {(filesQuery.data ?? []).length === 0 ? (
        <EmptyState icon={<FileCode2 size={28} />} title={t("files.emptyTitle")} text={t("files.emptyBody")} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-left">
            <thead className="bg-elevated text-label-xs text-fg-muted">
              <tr><th className="px-12 py-8">{t("files.path")}</th><th className="px-12 py-8">{t("files.size")}</th><th className="px-12 py-8">{t("files.copyOnClone")}</th><th className="w-120" /></tr>
            </thead>
            <tbody>
              {(filesQuery.data ?? []).map((file) => (
                <tr key={file.path} className="border-t border-line-subtle text-body-sm">
                  <td className="px-12 py-9 font-mono text-fg break-all">{file.path}</td>
                  <td className="px-12 py-9 text-fg-secondary whitespace-nowrap">{format.bytes(file.size)}</td>
                  <td className="px-12 py-9"><Toggle checked={file.template} disabled={running || actions.setTemplate.isPending} label={t("files.copyFile", { file: file.path })} onChange={(template) => void actions.setTemplate.mutateAsync({ serverId: server.id, path: file.path, template }).catch(fail)} /></td>
                  <td className="px-8 py-6"><div className="flex justify-end gap-2">
                    {isEditable(file.path) ? <Button size="sm" variant="ghost" disabled={running} onClick={() => void edit(file)}>{t("actions.edit")}</Button> : null}
                    <Button size="sm" variant="ghost" disabled={running} icon={<Trash2 size={14} />} aria-label={t("actions.delete")} onClick={() => setDeletePath(file.path)} />
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editor ? <FileEditorDialog serverId={server.id} value={editor} onClose={() => setEditor(null)} /> : null}
      {deletePath ? (
        <Dialog title={t("deleteFile.title")} body={t("deleteFile.body", { path: deletePath })} variant="danger" onClose={() => setDeletePath(null)} actions={<>
          <Button onClick={() => setDeletePath(null)}>{t("actions.cancel")}</Button>
          <Button variant="danger" disabled={actions.deleteFile.isPending} onClick={() => void actions.deleteFile.mutateAsync({ serverId: server.id, path: deletePath }).then(() => setDeletePath(null)).catch(fail)}>{t("actions.delete")}</Button>
        </>} />
      ) : null}
    </div>
  );
}

function FileEditorDialog({ serverId, value, onClose }: { serverId: string; value: { path: string; text: string; template: boolean }; onClose: () => void }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const actions = useServerInstanceActions();
  const [draft, setDraft] = useState(value);
  const save = async () => {
    try {
      await actions.saveText.mutateAsync({ serverId, ...draft });
      onClose();
    } catch (error) {
      show(`server:${serverId}:editor:error`, { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) });
    }
  };
  return (
    <Dialog wide title={t("editor.title")} onClose={onClose} actions={<>
      <Button onClick={onClose}>{t("actions.cancel")}</Button>
      <Button variant="primary" icon={<Save size={16} />} disabled={!draft.path.trim() || actions.saveText.isPending} onClick={() => void save()}>{t("actions.save")}</Button>
    </>}>
      <div className="flex flex-col gap-12">
        <Field label={t("files.path")}><Input value={draft.path} onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></Field>
        <label className="flex items-center gap-10 text-body-sm text-fg-secondary"><Toggle checked={draft.template} label={t("files.copyOnClone")} onChange={(template) => setDraft({ ...draft, template })} />{t("editor.copyHint")}</label>
        <ConfigCodeEditor value={draft.text} onChange={(text) => setDraft({ ...draft, text })} height={420} ariaLabel={t("editor.text")} completions={[]} />
      </div>
    </Dialog>
  );
}

function ServerConsole({ server }: { server: ServerInstanceView }) {
  const { t } = useTranslation("serverInstances");
  const lines = server.status.logTail;
  return (
    <div className="rounded-md border border-line bg-[#080b10] min-h-240 max-h-480 overflow-auto p-12 font-mono text-body-xs text-fg-secondary whitespace-pre-wrap">
      {lines.length > 0 ? lines.join("\n") : t("console.empty")}
    </div>
  );
}

function EnginesTab({ engines }: { engines: ServerEngineView[] }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const actions = useServerInstanceActions();
  if (engines.length === 0) return <EmptyState icon={<Download size={28} />} title={t("engines.emptyTitle")} text={t("engines.emptyBody")} />;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-12">
      {engines.map((engine) => (
        <article key={engine.engineId} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-12 rounded-lg border border-line bg-surface p-16">
          <EngineLogo engineId={engine.engineId} name={engine.name} size={44} />
          <div className="flex-1 min-w-0"><h3 className="text-body-lg-medium text-fg truncate">{engine.name}</h3><p className="text-body-xs text-fg-secondary">{engine.installed ? t("engines.version", { version: engine.installed.version }) : t("engines.notInstalled")}</p></div>
          {engine.installable ? (
            <Button className="col-span-2 w-full" size="sm" variant={engine.installed ? "secondary" : "primary"} disabled={actions.installEngine.isPending} icon={<Download size={14} />} onClick={() => void actions.installEngine.mutateAsync({ engineId: engine.engineId }).catch((error) => show(`server-engine:${engine.engineId}`, { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) }))}>
              {t(engine.installed ? "actions.reinstall" : "actions.install")}
            </Button>
          ) : (
            <p className="col-span-2 text-body-xs text-fg-muted">{t("engines.fromGameFiles")}</p>
          )}
        </article>
      ))}
    </div>
  );
}

function ModsTab({ mods }: { mods: ServerMod[] }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const actions = useServerInstanceActions();
  const gameNames = useGameNames();
  const [deleting, setDeleting] = useState<ServerMod | null>(null);
  if (mods.length === 0) return <EmptyState icon={<PackagePlus size={28} />} title={t("mods.emptyTitle")} text={t("mods.emptyBody")} />;
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-12">
        {mods.map((mod) => (
          <article key={mod.id} className="flex flex-col gap-10 rounded-lg border border-line bg-surface p-16">
            <div className="flex items-start gap-10"><PackagePlus size={22} className="text-fg-accent" /><div className="flex-1 min-w-0"><h3 className="text-body-lg-medium text-fg truncate">{mod.name}</h3><p className="text-mono-xs text-fg-muted">{mod.folder}</p></div><Badge>{gameNames.short(mod.game)}</Badge></div>
            <p className="text-body-xs text-fg-secondary">{t("mods.fileCount", { count: mod.files.length })} · {t(`mods.sources.${mod.source.kind}`)}</p>
            <div className="flex justify-end"><Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={actions.deleteMod.isPending} onClick={() => setDeleting(mod)}>{t("actions.delete")}</Button></div>
          </article>
        ))}
      </div>
      {deleting ? (
        <Dialog
          title={t("deleteMod.title")}
          body={t("deleteMod.body", { name: deleting.name })}
          variant="danger"
          onClose={() => setDeleting(null)}
          actions={<>
            <Button onClick={() => setDeleting(null)}>{t("actions.cancel")}</Button>
            <Button variant="danger" disabled={actions.deleteMod.isPending} onClick={() => void actions.deleteMod.mutateAsync(deleting.id).then(() => setDeleting(null)).catch((error) => show(`server-mod:${deleting.id}`, { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) }))}>{t("actions.delete")}</Button>
          </>}
        />
      ) : null}
    </>
  );
}

function CreateServerDialog({ game, engines, mods, busy, onClose, onCreate }: { game: Game; engines: ServerEngineView[]; mods: ServerMod[]; busy: boolean; onClose: () => void; onCreate: (input: { name: string; game: Game; engineId: string; modId: string | null; port: number | null; public: boolean | null }) => Promise<void> }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const [name, setName] = useState("");
  const [engineId, setEngineId] = useState(engines[0]?.engineId ?? "");
  const [modId, setModId] = useState("");
  const [port, setPort] = useState("29070");
  const [publicServer, setPublicServer] = useState(false);
  return (
    <Dialog title={t("create.title")} body={t("create.body")} onClose={onClose} actions={<>
      <Button onClick={onClose}>{t("actions.cancel")}</Button>
      <Button variant="primary" disabled={busy || !name.trim() || !engineId} onClick={() => void onCreate({ name, game, engineId, modId: modId || null, port: Number(port) || null, public: publicServer }).catch((error) => show("server:create:error", { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) }))}>{t("actions.create")}</Button>
    </>}>
      <div className="flex flex-col gap-12">
        <Field label={t("fields.name")}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("create.namePlaceholder")} /></Field>
        <Field label={t("fields.engine")}><Select value={engineId} onChange={setEngineId} ariaLabel={t("fields.engine")} options={engines.map((engine) => ({ value: engine.engineId, label: engine.name, hint: engine.installed?.version ?? t("engines.notInstalled") }))} /></Field>
        <Field label={t("fields.mod")}><Select value={modId} onChange={setModId} ariaLabel={t("fields.mod")} options={[{ value: "", label: t("instances.noMod") }, ...mods.map((mod) => ({ value: mod.id, label: mod.name, hint: mod.folder }))]} /></Field>
        <Field label={t("fields.port")}><Input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} /></Field>
        <label className="flex items-center gap-10 text-body-sm text-fg-secondary"><Toggle checked={publicServer} label={t("fields.public")} onChange={setPublicServer} />{t("create.publicHint")}</label>
      </div>
    </Dialog>
  );
}

function AddModDialog({ game, onClose }: { game: Game; onClose: () => void }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const actions = useServerInstanceActions();
  const [source, setSource] = useState<"disk" | "jkhub">("disk");
  const [sourcePath, setSourcePath] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [fileId, setFileId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const categoryId = game === "ja" ? 25 : 43;
  const listing = useJkhubListing(game, categoryId, "recentlyUpdated", page);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const completeListing = useCompleteJkhubListing(game, categoryId, "recentlyUpdated", Boolean(normalizedQuery));
  const cards = filterServerModCards(
    normalizedQuery ? (completeListing.data?.cards ?? []) : (listing.data?.cards ?? []),
    normalizedQuery,
  );
  const busy = actions.addModFromDisk.isPending || actions.addModFromJkhub.isPending;
  const pickDisk = async (directory: boolean) => {
    const picked = await open({ directory, multiple: false, title: t("addMod.pickSource") });
    if (typeof picked === "string") {
      setSourcePath(picked);
      const guessed = picked.split(/[\\/]/).filter(Boolean).pop() ?? "mod";
      if (!name) setName(guessed);
      if (!folder) setFolder(slugFolder(guessed));
    }
  };
  const install = async () => {
    try {
      if (source === "disk") await actions.addModFromDisk.mutateAsync({ name, game, folder, sourcePath });
      else if (fileId !== null) await actions.addModFromJkhub.mutateAsync({ fileId, name, game, folder });
      onClose();
    } catch (error) {
      show("server-mod:add:error", { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) });
    }
  };
  return (
    <Dialog wide title={t("addMod.title")} body={t("addMod.body")} onClose={onClose} actions={<>
      <Button onClick={onClose}>{t("actions.cancel")}</Button>
      <Button variant="primary" disabled={busy || !name.trim() || !folder.trim() || (source === "disk" ? !sourcePath : fileId === null)} onClick={() => void install()}>{t("actions.addMod")}</Button>
    </>}>
      <div className="flex flex-col gap-12">
        <Tabs value={source} onChange={setSource} tabs={[{ id: "disk", label: t("addMod.disk") }, { id: "jkhub", label: t("addMod.jkhub") }]} />
        {source === "disk" ? (
          <div className="flex flex-wrap gap-8">
            <Input readOnly value={sourcePath} placeholder={t("addMod.noSource")} className="flex-1 min-w-240" />
            <Button icon={<FolderOpen size={16} />} onClick={() => void pickDisk(true)}>{t("addMod.chooseFolder")}</Button>
            <Button icon={<FileCode2 size={16} />} onClick={() => void pickDisk(false)}>{t("addMod.chooseArchive")}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("addMod.searchJkhub")} />
            <p className="text-body-xs text-fg-muted">{t("addMod.serverSideCategory", { category: categoryId })}</p>
            <div className="max-h-220 overflow-auto rounded-md border border-line">
              {normalizedQuery && completeListing.isPending ? <p className="p-12 text-body-sm text-fg-muted">{t("addMod.searchingCategory")}</p> : null}
              {normalizedQuery && completeListing.isError ? <p className="p-12 text-body-sm text-status-error">{errorText(completeListing.error)}</p> : null}
              {cards.map((card) => (
                <button key={card.id} type="button" onClick={() => { setFileId(card.id); setName(card.title); setFolder(slugFolder(card.slug || card.title)); }} className={`w-full flex items-center gap-8 px-12 py-9 border-b border-line-subtle text-left cursor-pointer ${fileId === card.id ? "bg-accent-subtle" : "hover:bg-hover-overlay"}`}>
                  <span className="flex-1 text-body-sm text-fg truncate">{card.title}</span><span className="text-mono-xs text-fg-muted">#{card.id}</span>
                </button>
              ))}
              {(normalizedQuery ? completeListing.data : listing.data) && cards.length === 0 ? <p className="p-12 text-body-sm text-fg-muted">{t("addMod.noResults")}</p> : null}
            </div>
            {!normalizedQuery && listing.data && listing.data.pages > 1 ? (
              <div className="flex items-center justify-between gap-8">
                <Button size="sm" icon={<ChevronLeft size={14} />} disabled={page <= 1} onClick={() => { setPage((value) => Math.max(1, value - 1)); setFileId(null); }}>{t("addMod.previousPage")}</Button>
                <span className="text-body-xs text-fg-muted">{t("addMod.page", { page, pages: listing.data.pages })}</span>
                <Button size="sm" icon={<ChevronRight size={14} />} disabled={page >= listing.data.pages} onClick={() => { setPage((value) => Math.min(listing.data.pages, value + 1)); setFileId(null); }}>{t("addMod.nextPage")}</Button>
              </div>
            ) : null}
          </div>
        )}
        <div className="grid grid-cols-2 gap-12 @max-[760px]/page:grid-cols-1">
          <Field label={t("fields.name")}><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={t("fields.modFolder")}><Input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={t("fields.modFolderPlaceholder")} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

function NameDialog({ title, body, initial, confirm, busy, onClose, onConfirm }: { title: string; body: string; initial: string; confirm: string; busy: boolean; onClose: () => void; onConfirm: (name: string) => Promise<void> }) {
  const { t } = useTranslation("serverInstances");
  const errorText = useErrorText();
  const { show } = useToasts();
  const [name, setName] = useState(initial);
  return <Dialog title={title} body={body} onClose={onClose} actions={<><Button onClick={onClose}>{t("actions.cancel")}</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={() => void onConfirm(name).catch((error) => show("server:name:error", { variant: "error", title: t("feedback.actionFailed"), text: errorText(error) }))}>{confirm}</Button></>}><Field label={t("fields.name")}><Input value={name} onChange={(event) => setName(event.target.value)} /></Field></Dialog>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-6"><span className="text-label-xs text-fg-muted">{label}</span>{children}</label>;
}

function serverDraft(server: ServerInstanceView): UpdateServerInstanceInput {
  return { name: server.name, engineId: server.engineId, modId: server.modId, port: server.port, public: server.public, startupConfig: server.startupConfig, engineArgs: server.engineArgs, modArgs: server.modArgs };
}

function isEditable(path: string): boolean {
  return /\.(?:cfg|config|txt|ini|json|xml|yaml|yml|lua|script|log)$/i.test(path);
}

function slugFolder(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "mod";
}

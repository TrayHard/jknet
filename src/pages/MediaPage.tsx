import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Copy,
  FolderOpen,
  Film,
  Play,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import {
  useClients,
  useMedia,
  useMediaActions,
  useVideoJobs,
  useVideoPreferences,
} from "../lib/queries";
import { useActiveGame, clientsOfGame } from "../lib/game";
import { useErrorText } from "../i18n/errors";
import type { MediaItem, VideoSettings } from "../lib/ipc";
import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, Input, Select, Dialog } from "../components/ui";
import { TagEditor } from "../components/TagEditor";
import { ConfigCodeEditor } from "../components/ConfigCodeEditor";
import { VideoJobCard } from "../components/VideoJobCard";

export function MediaPage() {
  const { t, i18n } = useTranslation("common"),
    errorText = useErrorText();
  const media = useMedia(),
    actions = useMediaActions(),
    clients = useClients(),
    game = useActiveGame(),
    jobs = useVideoJobs(),
    prefs = useVideoPreferences();
  const [kind, setKind] = useState<MediaItem["kind"] | "all">("demos"),
    [clientFilter, setClientFilter] = useState(""),
    [tag, setTag] = useState(""),
    [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(""),
    [name, setName] = useState(""),
    [tags, setTags] = useState<string[]>([]),
    [target, setTarget] = useState("");
  const [message, setMessage] = useState(""),
    [exportOpen, setExportOpen] = useState(false),
    [captureClient, setCaptureClient] = useState("");
  const [fps, setFps] = useState("60"),
    [format, setFormat] = useState("mp4");
  const [deleteTargets, setDeleteTargets] = useState<MediaItem[]>([]);
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({ scope: "", ids: new Set() });
  const renderingDemo = (id: string) => jobs.data?.some(job => job.status === "rendering" && job.demoId === id) ?? false;
  const [fov, setFov] = useState("100"),
    [commands, setCommands] = useState(""),
    [presetId, setPresetId] = useState(""),
    [presetName, setPresetName] = useState(""),
    [presetMessage, setPresetMessage] = useState("");
  const renderSettings: VideoSettings = { fps: Number(fps), format, fov: Number(fov), commands };
  const validSettings = Number.isInteger(Number(fov)) && Number(fov) >= 1 && Number(fov) <= 160 && new TextEncoder().encode(commands).length <= 32768;
  const applySettings = (settings: VideoSettings) => {
    setFps(String(settings.fps)); setFormat(settings.format);
    setFov(String(settings.fov)); setCommands(settings.commands);
  };
  const gameClients = clientsOfGame(clients.data, game),
    all = (media.data ?? []).filter((i) => i.game === game),
    allTags = [...new Set(all.flatMap((i) => i.tags))].sort();
  const items = all.filter(
    (i) =>
      (kind === "all" || i.kind === kind) &&
      (!clientFilter || i.origins.some((o) => o.clientId === clientFilter)) &&
      (!tag || i.tags.includes(tag)) &&
      i.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  // A selection belongs to the visible result set. Changing filters cannot
  // leave hidden items selected for a subsequent destructive action.
  const selectionScope = JSON.stringify([game, kind, clientFilter, tag, search]);
  useEffect(() => {
    setSelection({ scope: selectionScope, ids: new Set() });
  }, [selectionScope]);
  const checkedIds = selection.scope === selectionScope ? selection.ids : new Set<string>();
  const checkedItems = items.filter(item => checkedIds.has(item.id));
  const allChecked = items.length > 0 && checkedItems.length === items.length;
  const clearSelection = () => setSelection({ scope: selectionScope, ids: new Set() });
  const toggleChecked = (id: string, checked: boolean) => {
    const ids = new Set(checkedItems.map(item => item.id));
    if (checked) ids.add(id); else ids.delete(id);
    setSelection({ scope: selectionScope, ids });
  };
  const selected = items.find((i) => i.id === selectedId);
  const select = (item: MediaItem) => {
    setSelectedId(item.id);
    setName(item.name);
    setTags(item.tags);
    setMessage("");
  };
  const failure =
    media.error ??
    actions.edit.error ??
    actions.copy.error ??
    actions.open.error ??
    actions.play.error ??
    actions.exportVideo.error ??
    actions.cancelVideo.error ??
    actions.preparePreview.error ??
    actions.remove.error ??
    jobs.error ?? prefs.error;
  const exportFailure = actions.exportVideo.error ?? actions.savePreset.error ?? actions.deletePreset.error ?? prefs.error;
  const captureClients = gameClients.filter(
    (c) => c.engineId === "jamme" && c.engineVersion,
  );
  const captureId =
    captureClients.find((c) => c.id === captureClient)?.id ??
    captureClients[0]?.id ??
    "";
  const targetId =
    gameClients.find((c) => c.id === target)?.id ??
    gameClients.find((c) => c.engineVersion)?.id ??
    "";
  const date = (seconds: number) =>
    new Date(seconds * 1000).toLocaleString(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <Page>
      <PageHeader
        title={t("media.title")}
        actions={
          <Button
            size="sm"
            icon={<RefreshCw size={14} />}
            disabled={media.isFetching}
            onClick={() => void media.refetch()}
          >
            {t("media.refresh")}
          </Button>
        }
      />
      <div className="flex flex-col gap-16">
        <div className="flex flex-wrap items-center gap-12">
          <div className="flex gap-4 rounded-md bg-input p-4">
            {(["all", "demos", "screenshots", "videos"] as const).map((tab) => (
              <Button
                key={tab}
                size="sm"
                variant={tab === kind ? "primary" : "ghost"}
                onClick={() => {
                  setKind(tab);
                  setSelectedId("");
                }}
              >
                {t(`media.${tab}`)}{" "}
                <span className="opacity-60">
                  {tab === "all" ? all.length : all.filter((i) => i.kind === tab).length}
                </span>
              </Button>
            ))}
          </div>
          <Input
            className="flex-1 min-w-180 max-w-360"
            icon={<Search size={14} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t("media.search")}
            placeholder={t("media.search")}
          />
          <Select
            className="w-180"
            ariaLabel={t("media.client")}
            value={clientFilter}
            onChange={setClientFilter}
            options={[
              { value: "", label: t("media.allClients") },
              ...gameClients.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <Select
            className="w-160"
            ariaLabel={t("media.tags")}
            value={tag}
            onChange={setTag}
            options={[
              { value: "", label: t("media.allTags") },
              ...allTags.map((v) => ({ value: v, label: v })),
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-12 rounded-md border border-line bg-surface px-12 py-8">
          <label className="flex cursor-pointer items-center gap-8 text-body-sm text-fg">
            <input
              type="checkbox"
              className="h-16 w-16 accent-accent"
              checked={allChecked}
              ref={node => { if (node) node.indeterminate = checkedItems.length > 0 && !allChecked; }}
              disabled={!items.length || actions.remove.isPending}
              onChange={event => setSelection({ scope: selectionScope, ids: new Set(event.target.checked ? items.map(item => item.id) : []) })}
            />
            {t("media.selectAll")}
          </label>
          <span role="status" className="text-body-xs text-fg-secondary">{t("media.selectionCount", { count: checkedItems.length, total: items.length })}</span>
          <Button variant="ghost" size="sm" disabled={!checkedItems.length || actions.remove.isPending} onClick={clearSelection}>{t("media.clearSelection")}</Button>
          <Button
            className="ml-auto"
            size="sm"
            variant="danger"
            icon={<Trash2 size={14} />}
            disabled={!checkedItems.length || checkedItems.some(item => renderingDemo(item.id)) || actions.remove.isPending || actions.preparePreview.isPending}
            onClick={() => {
              actions.remove.reset();
              setDeleteTargets(checkedItems);
            }}
          >{t("media.deleteSelected")}</Button>
          {checkedItems.some(item => renderingDemo(item.id)) ? <p className="basis-full text-body-xs text-fg-muted">{t("media.deleteRenderingHint")}</p> : null}
        </div>
        {failure ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {errorText(failure)}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-body-sm text-fg-secondary">
            {message}
          </p>
        ) : null}
        {jobs.data?.filter(job => job.status !== "complete" || job.videoIds.some(id => media.data?.some(item => item.id === id))).map((job) => (
          <VideoJobCard key={job.id} job={job}
            cancelling={actions.cancelVideo.isPending}
            onCancel={() => actions.cancelVideo.mutate(job.id)}
            onShow={() => {
                  setKind("videos");
                  setClientFilter("");
                  setTag("");
                  setSearch("");
                  const item = all.find((i) => i.id === job.videoIds[0]);
                  if (item) select(item);
                }}
          />
        ))}
        <div className="grid grid-cols-[minmax(260px,0.85fr)_minmax(320px,1.15fr)] gap-20 items-start">
          <div className="flex flex-col gap-8 max-h-[calc(100vh-220px)] overflow-auto pr-4">
            {items.map((item) => (
              <div
                key={item.id}
                className={`flex items-center gap-12 rounded-lg border px-12 py-10 ${checkedIds.has(item.id) || item.id === selectedId ? "border-line-focus bg-accent-subtle" : "border-line bg-surface hover:bg-elevated"}`}
              >
                <input
                  type="checkbox"
                  className="h-16 w-16 shrink-0 accent-accent"
                  aria-label={t("media.selectNamed", { name: item.name })}
                  checked={checkedIds.has(item.id)}
                  disabled={actions.remove.isPending}
                  onChange={event => toggleChecked(item.id, event.target.checked)}
                />
              <button
                type="button"
                onClick={() => select(item)}
                className="flex min-w-0 flex-1 items-center gap-12 text-left rounded-sm focus-visible:outline focus-visible:outline-line-focus"
              >
                {item.kind === "screenshots" && item.preview ? (
                  <img
                    src={item.preview}
                    alt=""
                    loading="lazy"
                    className="w-112 h-72 shrink-0 object-contain rounded-sm bg-input"
                  />
                ) : (
                  <Film size={24} className="text-fg-muted shrink-0" />
                )}
                <div className="min-w-0 flex-1 flex flex-col gap-4">
                  <span className="text-body-md text-fg truncate">
                    {item.name}
                  </span>
                  <span className="text-body-xs text-fg-muted">
                    {date(item.origins[0]?.createdAt ?? 0)} ·{" "}
                    {(item.size / 1048576).toFixed(1)} {t("media.megabytes")}
                  </span>
                  <div className="flex flex-wrap gap-4">
                    {item.tags.map((tag) => (
                      <Badge key={tag} tone="accent">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <span className="text-label-xs text-fg-muted">
                  {item.extension.toUpperCase()}
                </span>
              </button>
              </div>
            ))}
            {!items.length ? (
              <p className="p-20 text-body-sm text-fg-muted">
                {t(media.isFetching ? "media.scanning" : "media.empty")}
              </p>
            ) : null}
          </div>
          {selected ? (
            <section className="sticky top-16 min-w-0 rounded-lg border border-line bg-surface overflow-hidden">
              {selected.kind === "screenshots" && selected.preview ? (
                <img
                  src={selected.preview}
                  alt={selected.name}
                  className="w-full max-h-[48vh] object-contain bg-input"
                />
              ) : null}
              {selected.kind === "videos" && selected.preview && !deleteTargets.some(item => item.id === selected.id) ? (
                <video
                  key={selected.id}
                  src={selected.preview}
                  controls
                  preload="metadata"
                  className="w-full max-h-[48vh] bg-input"
                />
              ) : null}
              {selected.kind === "videos" && !selected.preview ? (
                <div className="flex flex-col items-center gap-12 p-24">
                  <p className="text-body-sm text-fg-muted">
                    {t("media.legacyPreviewHint")}
                  </p>
                  <Button
                    disabled={actions.preparePreview.isPending}
                    onClick={() => actions.preparePreview.mutate(selected.id)}
                  >
                    {t(
                      actions.preparePreview.isPending
                        ? "media.phase_encoding"
                        : "media.preparePreview",
                    )}
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-col gap-12 p-16">
                <div className="flex gap-8">
                  <Input
                    className="flex-1 min-w-0"
                    aria-label={t("media.name")}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Button
                    icon={<Save size={14} />}
                    disabled={!name.trim() || actions.edit.isPending}
                    onClick={() =>
                      actions.edit.mutate(
                        { id: selected.id, name, tags },
                        { onSuccess: () => setMessage(t("media.saved")) },
                      )
                    }
                  >
                    {t("media.save")}
                  </Button>
                </div>
                <TagEditor
                  key={selected.id}
                  value={tags}
                  onChange={setTags}
                  suggestions={allTags}
                />
                <div className="flex flex-wrap items-center gap-8 border-t border-line pt-12">
                  {selected.kind === "demos" ? (
                    <>
                      <Select
                        className="w-160"
                        size="sm"
                        ariaLabel={t("media.playIn")}
                        value={targetId}
                        onChange={setTarget}
                        options={gameClients.map((c) => ({
                          value: c.id,
                          label: c.name,
                          disabled: !c.engineVersion,
                        }))}
                      />
                      <Button
                        size="sm"
                        icon={<Play size={14} />}
                        disabled={!targetId || actions.play.isPending}
                        onClick={() =>
                          actions.play.mutate({
                            id: selected.id,
                            clientId: targetId,
                          })
                        }
                      >
                        {t("media.play")}
                      </Button>
                      <Button
                        size="sm"
                        icon={<Film size={14} />}
                        disabled={prefs.isLoading || !!prefs.error}
                        onClick={() => {
                          applySettings(prefs.data ?? { format: "mp4", fps: 60, fov: 100, commands: "" });
                          setPresetId(""); setPresetName(""); setPresetMessage("");
                          actions.exportVideo.reset(); actions.savePreset.reset(); actions.deletePreset.reset();
                          setExportOpen(true);
                        }}
                      >
                        {t("media.exportVideo")}
                      </Button>
                    </>
                  ) : null}
                  {selected.kind === "screenshots" ? (
                    <Button
                      size="sm"
                      icon={<Copy size={14} />}
                      disabled={actions.copy.isPending}
                      onClick={() =>
                        actions.copy.mutate(selected.id, {
                          onSuccess: () => setMessage(t("media.copied")),
                        })
                      }
                    >
                      {t("media.copy")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<FolderOpen size={14} />}
                    onClick={() => actions.open.mutate(selected.id)}
                  >
                    {t("media.openFolder")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={14} />}
                    disabled={renderingDemo(selected.id) || actions.remove.isPending || actions.preparePreview.isPending}
                    title={renderingDemo(selected.id) ? t("media.deleteRenderingHint") : undefined}
                    onClick={() => {
                      actions.remove.reset();
                      setDeleteTargets([selected]);
                    }}
                  >
                    {t("media.delete")}
                  </Button>
                </div>
                {renderingDemo(selected.id) ? <p className="text-body-xs text-fg-muted">{t("media.deleteRenderingHint")}</p> : null}
                <div className="flex flex-wrap gap-x-16 gap-y-4 text-body-xs text-fg-muted">
                  {selected.origins.map((origin, i) => (
                    <span key={i} title={origin.source}>
                      {origin.clientName} · {date(origin.createdAt)}
                      {origin.dateIsModified
                        ? ` ${t("media.modifiedDate")}`
                        : ""}
                    </span>
                  ))}
                </div>
              </div>
            </section>
          ) : (
            <div className="flex min-h-240 items-center justify-center rounded-lg border border-dashed border-line text-body-sm text-fg-muted">
              {t("media.selectItem")}
            </div>
          )}
        </div>
      </div>
      {deleteTargets.length > 0 ? (
        <Dialog
          variant="danger"
          title={deleteTargets.length === 1 ? t("media.deleteTitle", { name: deleteTargets[0].name }) : t("media.deleteSelectedTitle", { count: deleteTargets.length })}
          body={t(deleteTargets.length === 1 ? "media.deleteHint" : "media.deleteSelectedHint")}
          onClose={() => { if (!actions.remove.isPending) setDeleteTargets([]); }}
          actions={
            <>
              <Button variant="ghost" disabled={actions.remove.isPending} onClick={() => setDeleteTargets([])}>{t("media.keep")}</Button>
              <Button
                variant="danger"
                icon={<Trash2 size={14} />}
                disabled={actions.remove.isPending || deleteTargets.some(item => renderingDemo(item.id))}
                onClick={() => actions.remove.mutate(deleteTargets.map(item => item.id), {
                  onSuccess: () => {
                    if (deleteTargets.some(item => item.id === selectedId)) setSelectedId("");
                    setMessage(deleteTargets.length === 1 ? t("media.deleted") : t("media.deletedCount", { count: deleteTargets.length }));
                    setDeleteTargets([]);
                    clearSelection();
                  },
                })}
              >{t(actions.remove.isPending ? "media.deleting" : "media.delete")}</Button>
            </>
          }
        >
          {deleteTargets.length > 1 ? (
            <ul className="flex max-h-192 flex-col gap-4 overflow-auto text-body-sm text-fg-secondary" aria-label={t("media.selectedFiles")}>
              {deleteTargets.map(item => <li key={item.id} className="flex items-center gap-8"><span className="min-w-0 flex-1 break-words">{item.name}</span><span className="shrink-0 text-body-xs text-fg-muted">{item.extension.toUpperCase()}</span></li>)}
            </ul>
          ) : null}
          {actions.remove.error ? <p role="alert" className="text-body-sm text-fg-danger">{errorText(actions.remove.error)}</p> : null}
          {deleteTargets.some(item => renderingDemo(item.id)) ? <p className="text-body-sm text-fg-muted">{t("media.deleteRenderingHint")}</p> : null}
        </Dialog>
      ) : null}
      {exportOpen && selected ? (
        <Dialog
          wide
          title={t("media.exportVideo")}
          body={t("media.exportHint")}
          onClose={() => setExportOpen(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setExportOpen(false)}>
                {t("configs.close")}
              </Button>
              <Button
                icon={<Film size={14} />}
                disabled={
                  !captureId ||
                  !validSettings ||
                  actions.exportVideo.isPending ||
                  jobs.data?.some((j) => j.status === "rendering")
                }
                onClick={() =>
                  actions.exportVideo.mutate(
                    {
                      demoId: selected.id,
                      clientId: captureId,
                      settings: renderSettings,
                    },
                    { onSuccess: () => setExportOpen(false) },
                  )
                }
              >
                {t("media.exportVideo")}
              </Button>
            </>
          }
        >
          <div className="flex max-h-[60vh] flex-col gap-16 overflow-y-auto pr-4 [&>*]:shrink-0">
            {exportFailure ? <p role="alert" className="text-body-sm text-fg-danger">{errorText(exportFailure)}</p> : null}
            <div className="rounded-md border border-line bg-elevated p-12 flex flex-col gap-8">
              <Select label={t("media.renderPreset")} ariaLabel={t("media.renderPreset")} value={presetId}
                disabled={actions.savePreset.isPending || actions.deletePreset.isPending}
                onChange={(id) => {
                  setPresetId(id); setPresetMessage("");
                  const preset = prefs.data?.presets.find(p => p.id === id);
                  setPresetName(preset?.name ?? "");
                  if (preset) applySettings(preset.settings);
                }}
                options={[{ value: "", label: t("media.customPreset") }, ...(prefs.data?.presets ?? []).map(p => ({ value: p.id, label: p.name }))]} />
              <div className="flex flex-wrap gap-8 items-end">
                <Input className="flex-1 min-w-160" aria-label={t("media.presetName")} placeholder={t("media.presetName")} value={presetName} maxLength={120} onChange={e => setPresetName(e.target.value)} />
                <Button size="sm" icon={<Save size={14} />} disabled={!presetName.trim() || !validSettings || actions.savePreset.isPending || actions.deletePreset.isPending}
                  onClick={() => actions.savePreset.mutate({ id: presetId, name: presetName, settings: renderSettings }, { onSuccess: preset => { setPresetId(preset.id); setPresetName(preset.name); setPresetMessage(t("media.presetSaved")); } })}>{t(presetId ? "media.updatePreset" : "media.savePreset")}</Button>
                {presetId ? <>
                  <Button variant="ghost" size="sm" disabled={!presetName.trim() || !validSettings || actions.savePreset.isPending || actions.deletePreset.isPending}
                    onClick={() => actions.savePreset.mutate({ id: "", name: presetName, settings: renderSettings }, { onSuccess: preset => { setPresetId(preset.id); setPresetMessage(t("media.presetSaved")); } })}>{t("media.savePresetCopy")}</Button>
                  <Button variant="ghost" size="sm" disabled={actions.savePreset.isPending || actions.deletePreset.isPending} onClick={() => actions.deletePreset.mutate(presetId, { onSuccess: () => { setPresetId(""); setPresetName(""); setPresetMessage(t("media.presetDeleted")); } })}>{t("media.deletePreset")}</Button>
                </> : null}
              </div>
              {presetMessage ? <p role="status" className="text-body-xs text-fg-secondary">{presetMessage}</p> : null}
            </div>
            <Select
              label={t("media.captureClient")}
              ariaLabel={t("media.captureClient")}
              value={captureId}
              onChange={setCaptureClient}
              options={captureClients.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
            <div className="grid grid-cols-2 gap-12">
              <Select
                label={t("media.format")}
                ariaLabel={t("media.format")}
                value={format}
                onChange={setFormat}
                options={["mp4", "webm", "mkv"].map((f) => ({
                  value: f,
                  label: f.toUpperCase(),
                }))}
              />
              <Select
                label={t("media.fps")}
                ariaLabel={t("media.fps")}
                value={fps}
                onChange={setFps}
                options={[
                  { value: "30", label: "30" },
                  { value: "60", label: "60" },
                ]}
              />
            </div>
            <label className="flex flex-col gap-8 text-label-sm text-fg">{t("media.fov")}<Input aria-label={t("media.fov")} type="number" min={1} max={160} step={1} value={fov} onChange={e => setFov(e.target.value)} /></label>
            <div className="flex flex-col gap-8">
              <p className="text-label-sm text-fg">{t("media.renderCommands")}</p>
              <p className="text-body-xs text-fg-muted">{t("media.renderCommandsHint")}</p>
              <ConfigCodeEditor value={commands} onChange={setCommands} height={160} ariaLabel={t("media.renderCommands")} />
            </div>
            {!validSettings ? <p role="alert" className="text-body-sm text-fg-danger">{t("media.invalidRenderSettings")}</p> : null}
            {!captureId ? (
              <p className="text-body-sm text-fg-muted">
                {t("media.needJamme")}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </Page>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileSearch, Music, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import { DEFAULT_SINGLE_HILT } from "../../lib/sabers";
import { matchesPreviewSearch } from "../../lib/previewSearch";
import { firstPick, isGalleryKind, isTextEntry, kindsOfMode, PREVIEW_GROUP_KINDS, subgroupKey, subgroupOf } from "../../lib/previewKinds";
import { useSettings, useUpdateSettings } from "../../lib/queries";
import { assembledSkinValue, parseAssembledSkin, skinIconUrl, bundlesIpc, filePreviewIpc, PREVIEW_MODES, type BundleFileRoot, type CharColor, type FilePreview, type FilePreviewEntry, type FilePreviewKind, type FilePreviewSource, type PreviewMode } from "../../lib/ipc";
import { ModelPreview } from "../ModelPreview";
import { PartsPanel, SkinPicker } from "../client/SkinPicker";
import { TintSliders } from "../client/TintSliders";
import { LibraryObjectIcon } from "./LibraryObjectIcon";
import { MapScenePreview } from "./MapScenePreview";
import { Gallery, Lightbox } from "./FilePreviewGallery";
import { FontView, PlainView, StringsView, TextView } from "./FilePreviewText";
import { PreviewOverlayContext } from "./previewOverlay";
import { Badge, Button, Dialog, EmptyState, Input, Select } from "../ui";

/**
 * What the dialog previews. The first two belong to the Library screen; the
 * other two are a pk3 of a bundle — of a draft on this disk, or of a
 * published version, which the core fetches first.
 * --- slice: bundles ---
 */
export type PreviewTarget =
  | { kind: "installed"; clientId: string; itemId: string; title: string }
  | { kind: "jkhub"; clientId: string | null; id: number; title: string }
  | { kind: "draft"; draftId: string; scope: string; root: BundleFileRoot; path: string; title: string }
  | { kind: "bundle"; bundleId: string; versionId: string; scope: string; root: BundleFileRoot; path: string; title: string };

/** The query key of a target: what tells one preview from another. */
function targetKey(target: PreviewTarget): readonly unknown[] {
  switch (target.kind) {
    case "installed": return ["file-preview", "installed", target.clientId, target.itemId];
    case "jkhub": return ["file-preview", "jkhub", target.clientId, target.id];
    case "draft": return ["file-preview", "draft", target.draftId, target.scope, target.root, target.path];
    case "bundle": return ["file-preview", "bundle", target.bundleId, target.versionId, target.scope, target.root, target.path];
  }
}

/** Opens the preview session of a target. */
function openTarget(target: PreviewTarget): Promise<FilePreview> {
  switch (target.kind) {
    case "installed": return filePreviewIpc.installed(target.clientId, target.itemId);
    case "jkhub": return filePreviewIpc.jkhub(target.id, target.clientId);
    case "draft": return bundlesIpc.previewDraftFile(target.draftId, target.scope, target.root, target.path);
    case "bundle": return bundlesIpc.previewBundleFile(target.bundleId, target.versionId, target.scope, target.root, target.path);
  }
}

export function FilePreviewDialog({ target, onClose, progress }: {
  target: PreviewTarget;
  onClose: () => void;
  /** Bytes of the archive coming down before the session opens: a JKHub file, or a file of a bundle. */
  progress?: { received: number; total: number } | null;
}) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const { t: jkhub } = useTranslation("jkhub");
  const errorText = useErrorText();
  const format = useFormat();
  const cache = useQueryClient();
  const { mode, setMode, error: modeError } = usePreviewMode();
  // The client whose skins the «with character» view uses: only a library file has one.
  const clientId = target.kind === "installed" || target.kind === "jkhub" ? target.clientId : null;
  const key = targetKey(target);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = await openTarget(target);
      if (!cache.getQueryCache().find({ queryKey: key })?.getObserversCount()) void filePreviewIpc.release(result.id).catch(() => {});
      return result;
    },
    staleTime: Infinity, gcTime: 0, retry: false,
  });
  const current = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = query.data?.id;
    current.current = id;
    return () => {
      current.current = undefined;
      queueMicrotask(() => {
        if (id && current.current !== id) void filePreviewIpc.release(id).catch(() => {});
      });
    };
  }, [query.data?.id]);
  return <PreviewFrame title={target.title} onClose={onClose} titleActions={<PreviewModeSwitch value={mode} onChange={setMode} error={modeError} />}>
    {query.isPending ? <p role="status" className="py-24 text-body-sm text-fg-secondary">
      {(target.kind === "jkhub" || target.kind === "bundle") && progress
        ? jkhub(progress.total ? "details.downloadingOf" : "details.downloading", { received: format.bytes(progress.received), total: format.bytes(progress.total) })
        : t("preview.loading")}
    </p> : null}
    {query.error ? <div role="alert" className="flex flex-col items-start gap-12 py-24">
      <p className="text-body-sm text-fg-danger">{errorText(query.error)}</p>
      <Button onClick={() => void query.refetch()}>{common("actions.tryAgain")}</Button>
    </div> : null}
    {query.data ? <Contents key={query.data.id} preview={query.data} clientId={clientId ?? ""} mode={mode} onMode={setMode} /> : null}
  </PreviewFrame>;
}

/**
 * The catalogue owns this session, so closing an object keeps it available.
 * The catalogue of the base game holds finished objects and no files, so the
 * two modes would list the same: the dialog lists everything and has no switch.
 */
export function ReadyFilePreviewDialog({ preview, entry, clientId, onClose }: {
  preview: FilePreview; entry: FilePreviewEntry; clientId: string | null; onClose: () => void;
}) {
  return <PreviewFrame title={entry.label} onClose={onClose}>
    <Contents key={entry.id} preview={preview} clientId={clientId ?? ""} mode="advanced" initialId={entry.id} initialKind={entry.kind} />
  </PreviewFrame>;
}

function PreviewFrame({ title, titleActions, onClose, children }: { title: string; titleActions?: ReactNode; onClose: () => void; children: ReactNode }) {
  const { t: common } = useTranslation("common");
  // --- slice: pk3 contents --- set by the enlarged picture while it is up; see `previewOverlay.ts`.
  const overlay = useRef(false);
  // Escape closes this preview while retaining a JKHub details dialog behind it.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (overlay.current) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else onClose();
      }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);

  return <PreviewOverlayContext.Provider value={overlay}>
    <Dialog wide="preview" title={title} titleActions={titleActions} onClose={onClose} actions={<Button onClick={onClose}>{common("actions.close")}</Button>}>{children}</Dialog>
  </PreviewOverlayContext.Provider>;
}

/**
 * --- slice: preview modes ---
 * The mode of every preview dialog: `previewMode` of the settings, `simple`
 * until they load. A press switches this dialog at once and writes the one
 * field as a patch, so the next dialog opens the same way; a refusal of the
 * core comes back as `error` for the switch to show.
 */
function usePreviewMode(): { mode: PreviewMode; setMode: (mode: PreviewMode) => void; error: Error | null } {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [chosen, setChosen] = useState<PreviewMode | null>(null);
  const mode = chosen ?? settings.data?.previewMode ?? "simple";
  const setMode = (next: PreviewMode) => {
    if (next === mode) return;
    setChosen(next);
    update.mutate({ previewMode: next });
  };
  return { mode, setMode, error: update.error };
}

/** The **Simple** / **Advanced** segment of the title row: two buttons of the kit, the active one filled. */
function PreviewModeSwitch({ value, onChange, error }: { value: PreviewMode; onChange: (mode: PreviewMode) => void; error: Error | null }) {
  const { t } = useTranslation("library");
  const errorText = useErrorText();
  return <>
    {error ? <span role="alert" className="text-body-sm text-fg-danger max-w-320 truncate" title={errorText(error)}>{errorText(error)}</span> : null}
    <div role="group" aria-label={t("preview.mode.label")} className="flex items-center gap-4">
      {PREVIEW_MODES.map(mode => <Button key={mode} size="sm" variant={value === mode ? "primary" : "ghost"} aria-pressed={value === mode}
        title={t(`preview.mode.${mode}Hint`)} onClick={() => onChange(mode)}>{t(`preview.mode.${mode}`)}</Button>)}
    </div>
  </>;
}

/** The filter of the list: every group of the taxonomy, after «all objects». */
export const PREVIEW_KINDS = ["all", ...PREVIEW_GROUP_KINDS] as const;

/** How many rows of one group are drawn before **Load more**. */
const LIST_PAGE = 100;

/** The heading of a group or a folder in the list: the whole row folds it. */
const FOLD_BUTTON = "w-full flex items-center gap-8 px-8 text-left rounded-sm cursor-pointer select-none transition-colors duration-150 hover:bg-hover-overlay hover:text-fg";

function Contents({ preview, clientId, mode, onMode, initialId, initialKind = "all" }: {
  preview: FilePreview; clientId: string; mode: PreviewMode; onMode?: (mode: PreviewMode) => void; initialId?: string; initialKind?: string;
}) {
  const { t } = useTranslation("library");
  const groups = useMemo(() => kindsOfMode(mode), [mode]);
  // Advanced puts the rows of a group under a subheading per folder; Simple lists them flat.
  const subgrouped = mode === "advanced";
  const [search, setSearch] = useState("");
  const [chosenKind, setKind] = useState<string>(initialKind);
  // A filter the mode does not list — **Textures** after a switch to Simple — reads as «all objects».
  const kind = chosenKind === "all" || (groups as readonly string[]).includes(chosenKind) ? chosenKind : "all";
  // The objects of the mode: group order first, then the subheading inside a group, then the order the core gave. The sort is stable.
  const all = useMemo(() => groups.flatMap(group => preview.entries
    .filter(entry => entry.kind === group)
    .sort((a, b) => subgroupOf(a).localeCompare(subgroupOf(b)))), [preview, groups]);
  const entries = useMemo(() => all.filter(entry => (kind === "all" || entry.kind === kind) && matchesPreviewSearch(entry, search)), [all, kind, search]);
  const [picked, setPicked] = useState(() => initialId ?? firstPick(all)?.id);
  // Rows of a group drawn so far, by group; a group left out draws one page.
  const [shown, setShown] = useState<Record<string, number>>({});
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const selected = entries.find(entry => entry.id === picked) ?? firstPick(entries);
  const characterHilt = preview.entries.find(entry => entry.kind === "hilt" && entry.hiltId?.toLowerCase() === DEFAULT_SINGLE_HILT.toLowerCase())
    ?? preview.entries.find(entry => entry.kind === "hilt" && entry.model === "models/weapons2/saber/saber_w.glm");
  const at = selected ? entries.indexOf(selected) : -1;
  const choose = (offset: number) => setPicked(entries[(at + offset + entries.length) % entries.length]?.id);
  const source = (entry: FilePreviewEntry): FilePreviewSource => ({ previewId: preview.id, archive: entry.archive });
  // The pictures the grid and the enlarged view walk: the selected group, as filtered.
  const galleryKind = selected && isGalleryKind(selected.kind) ? selected.kind : null;
  const gallery = useMemo(() => galleryKind ? entries.filter(entry => entry.kind === galleryKind) : [], [entries, galleryKind]);
  const enlargedAt = enlarged === null ? -1 : gallery.findIndex(entry => entry.id === enlarged);
  const options: (typeof PREVIEW_KINDS)[number][] = ["all", ...groups.filter(value => preview.entries.some(entry => entry.kind === value))];
  const listed = groups.filter(group => entries.some(entry => entry.kind === group));
  // One object of the mode needs no list: the dialog opens on it, as before the contents came.
  const many = all.length > 1;

  // --- slice: preview modes --- what is folded: a group by its kind, a folder by `subgroupKey`. Kept while the dialog is up.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) => setCollapsed(current => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const keysOf = (rows: readonly FilePreviewEntry[]): Set<string> => {
    const keys = new Set<string>();
    for (const entry of rows) {
      keys.add(entry.kind);
      if (subgrouped) keys.add(subgroupKey(entry));
    }
    return keys;
  };
  // Typing a search unfolds the groups that answer it and folds the rest, so what the list shows is the matches.
  const onSearch = (value: string) => {
    setSearch(value);
    setShown({});
    if (value.trim() === "") return;
    const matching = keysOf(all.filter(entry => matchesPreviewSearch(entry, value)));
    setCollapsed(new Set([...keysOf(all)].filter(key => !matching.has(key))));
  };
  // A pick made anywhere — the arrows, the grid, the enlarged view — unfolds the group and the folder of the object.
  useEffect(() => {
    if (!selected) return;
    setCollapsed(current => {
      if (!current.has(selected.kind) && !current.has(subgroupKey(selected))) return current;
      const next = new Set(current);
      next.delete(selected.kind);
      next.delete(subgroupKey(selected));
      return next;
    });
  }, [selected]);

  return <div className="flex flex-col gap-12 pt-16">
    {many ? <div className="flex items-center flex-wrap gap-8">
      <Input icon={<Search size={16} />} aria-label={t("preview.search")} placeholder={t("preview.search")}
        value={search} onChange={event => onSearch(event.target.value)} className="flex-1 min-w-200" />
      <Select value={kind} onChange={value => { setKind(value); setShown({}); }} ariaLabel={t("preview.contents")}
        options={options.map(value => ({ value, label: t(`preview.kind.${value}`) }))} className="w-200" />
      <Badge>{entries.length}</Badge>
    </div> : null}
    <div className="flex gap-16 h-[54vh] min-h-320">
      {many ? <div className="w-232 shrink-0 flex flex-col min-h-0">
        <div className="flex items-center justify-end gap-4 pb-4 shrink-0">
          <Button size="sm" variant="ghost" className="px-6" icon={<ChevronsDownUp size={16} aria-hidden="true" />}
            aria-label={t("preview.collapseAll")} title={t("preview.collapseAll")} onClick={() => setCollapsed(keysOf(all))} />
          <Button size="sm" variant="ghost" className="px-6" icon={<ChevronsUpDown size={16} aria-hidden="true" />}
            aria-label={t("preview.expandAll")} title={t("preview.expandAll")} onClick={() => setCollapsed(new Set())} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto pr-4" aria-label={t("preview.contents")}>
          {listed.map(group => <ObjectGroup key={group} group={group} entries={entries.filter(entry => entry.kind === group)} subgrouped={subgrouped}
            collapsed={collapsed} onToggle={toggle} shown={shown[group] ?? LIST_PAGE}
            onMore={() => setShown(value => ({ ...value, [group]: (value[group] ?? LIST_PAGE) + LIST_PAGE }))}
            selectedId={selected?.id} onPick={setPicked} />)}
        </div>
      </div> : null}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {!selected ? (mode === "simple" && all.length === 0 && preview.entries.length > 0
            ? <EmptyState icon={<FileSearch size={24} />} title={t("preview.empty")} text={t("preview.mode.onlyFiles")}
              action={onMode ? <Button onClick={() => onMode("advanced")}>{t("preview.mode.switchAdvanced")}</Button> : undefined} />
            : <EmptyState icon={<FileSearch size={24} />} title={t("preview.empty")} text={t("preview.emptyText")} />)
          : selected.kind === "map" ? <MapScenePreview key={selected.id} source={source(selected)} name={selected.name} />
          : isGalleryKind(selected.kind) ? <Gallery key={selected.kind} previewId={preview.id} entries={gallery} all={preview.entries} selectedId={selected.id}
            subgrouped={subgrouped} collapsed={collapsed} onToggle={toggle} onPick={setPicked} onEnlarge={setEnlarged} />
          : selected.kind === "strings" ? <StringsView key={selected.id} source={source(selected)} entry={selected} />
          : selected.kind === "font" ? <FontView key={selected.id} source={source(selected)} entry={selected} />
          : isTextEntry(selected) ? <TextView key={selected.id} source={source(selected)} entry={selected} />
          : selected.kind === "video" || selected.kind === "other" ? <PlainView key={selected.id} entry={selected} />
          : <Asset key={selected.id} source={source(selected)} entry={selected} clientId={clientId} characterHilt={characterHilt} />}
      </div>
    </div>
    {selected && entries.length > 1 ? <div className="flex items-center gap-8">
      <Button icon={<ChevronLeft size={16} />} aria-label={t("preview.previous")} disabled={entries.length < 2} onClick={() => choose(-1)} />
      <Button icon={<ChevronRight size={16} />} aria-label={t("preview.next")} disabled={entries.length < 2} onClick={() => choose(1)} />
      <span className="text-body-xs text-fg-muted min-w-0 truncate">{selected.label}</span>
      <span className="text-mono-xs text-fg-muted ml-auto whitespace-nowrap">{at + 1} / {entries.length}</span>
    </div> : null}
    {enlargedAt >= 0 ? <Lightbox previewId={preview.id} entries={gallery} all={preview.entries} index={enlargedAt}
      onMove={index => { const entry = gallery[index]; if (entry) { setEnlarged(entry.id); setPicked(entry.id); } }}
      onClose={() => setEnlarged(null)} /> : null}
  </div>;
}

/** The arrow of a heading that folds: right while folded, down while open. */
function FoldChevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return open ? <ChevronDown size={size} aria-hidden="true" className="shrink-0" /> : <ChevronRight size={size} aria-hidden="true" className="shrink-0" />;
}

/**
 * One group of the list: a heading that folds it, with the count, then the
 * rows — in Advanced under a subheading per subfolder or per language when
 * the group has any, each folding on its own. `shown` rows are drawn before
 * **Load more**; the selected row is always among them, and the rows of a
 * folded folder cost nothing, so folding a large folder brings the next one in.
 */
function ObjectGroup({ group, entries, subgrouped, collapsed, onToggle, shown, onMore, selectedId, onPick }: {
  group: FilePreviewKind; entries: FilePreviewEntry[]; subgrouped: boolean; collapsed: ReadonlySet<string>; onToggle: (key: string) => void;
  shown: number; onMore: () => void; selectedId: string | undefined; onPick: (id: string) => void;
}) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const open = !collapsed.has(group);
  const subgroups = useMemo(() => {
    const map = new Map<string, FilePreviewEntry[]>();
    for (const entry of entries) {
      const key = subgroupOf(entry);
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    return [...map.entries()];
  }, [entries]);
  const titled = subgrouped && subgroups.some(([name]) => name !== "");
  // The rows that can be drawn: those of the folders left unfolded, cut to the page with the selected row always in.
  const unfolded = titled ? entries.filter(entry => !collapsed.has(subgroupKey(entry))) : entries;
  const at = unfolded.findIndex(entry => entry.id === selectedId);
  const drawn = new Set(unfolded.slice(0, Math.max(shown, at + 1)).map(entry => entry.id));
  const sections: [string, FilePreviewEntry[]][] = titled ? subgroups : [["", entries]];
  return <section className="mb-12" aria-label={t(`preview.kind.${group}`)}>
    <h3 className="text-label-xs text-fg-muted border-b border-line mb-4">
      <button type="button" aria-expanded={open} onClick={() => onToggle(group)} className={cn(FOLD_BUTTON, "py-8")}>
        <FoldChevron open={open} />
        <LibraryObjectIcon kind={group} size={16} /><span className="flex-1 min-w-0 truncate">{t(`preview.kind.${group}`)}</span>
        <span className="text-mono-xs tabular-nums">{entries.length}</span>
      </button>
    </h3>
    {open ? <>
      {sections.map(([name, rows]) => {
        const key = `${group}/${name}`;
        const folded = titled && collapsed.has(key);
        const visible = rows.filter(entry => drawn.has(entry.id));
        // A folder past the page appears once **Load more** reaches it; a folded one stands at once, as a heading alone.
        if (!folded && visible.length === 0) return null;
        return <div key={name}>
          {titled ? <h4 className="text-mono-xs text-fg-muted">
            <button type="button" aria-expanded={!folded} onClick={() => onToggle(key)} title={name || undefined} className={cn(FOLD_BUTTON, "pt-8 pb-4")}>
              <FoldChevron open={!folded} size={12} />
              <span className="flex-1 min-w-0 truncate">{name || t("preview.rootFolder")}</span>
              <span className="tabular-nums">{rows.length}</span>
            </button>
          </h4> : null}
          {!folded ? <ul className="flex flex-col gap-4">
            {visible.map(entry => <ObjectRow key={entry.id} entry={entry} selected={selectedId === entry.id} onPick={() => onPick(entry.id)} />)}
          </ul> : null}
        </div>;
      })}
      {drawn.size < unfolded.length ? <Button size="sm" variant="ghost" onClick={onMore}>{common("actions.loadMore")}</Button> : null}
    </> : null}
  </section>;
}

function ObjectRow({ entry, selected, onPick }: { entry: FilePreviewEntry; selected: boolean; onPick: () => void }) {
  const { t } = useTranslation("library");
  const ref = useRef<HTMLLIElement>(null);
  // A pick made elsewhere — the grid, the enlarged view, the arrows — brings its row into view.
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const icon = skinIconUrl(entry.appearance?.icon ?? null);
  return <li ref={ref}>
    <button type="button" onClick={onPick} title={entry.name}
      aria-label={entry.label} aria-description={t(`preview.kind.${entry.kind}`)}
      aria-pressed={selected}
      className={cn("w-full flex items-center gap-8 px-8 py-8 text-left rounded-md cursor-pointer", selected ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay")}>
      {icon ? <img src={icon} alt="" className="size-32 shrink-0 rounded-sm object-contain" /> : <LibraryObjectIcon kind={entry.kind} size={24} className="shrink-0 text-fg-muted" />}
      <span className="text-body-sm break-words">{entry.label}</span>
    </button>
  </li>;
}

function Asset({ source, entry, clientId, characterHilt }: { source: FilePreviewSource; entry: FilePreviewEntry; clientId: string; characterHilt?: FilePreviewEntry }) {
  const { t } = useTranslation("library");
  const character = entry.kind === "skin" || entry.kind === "npc";
  const weapon = entry.kind === "weapon" || entry.kind === "hilt";
  const [parts, setParts] = useState(() => parseAssembledSkin(entry.appearance?.value ?? null));
  const [tint, setTint] = useState<CharColor | null>(null);
  const [withCharacter, setWithCharacter] = useState(false);
  const [actor, setActor] = useState<string | null>("kyle");
  const request = entry.hiltId ? { kind: "hilt" as const, value: entry.hiltId }
    : { kind: "model" as const, value: entry.model ?? "", skins: entry.skins, ...(entry.kind === "hilt" ? { saber: true } : {}) };
  return <div className="h-full flex flex-col gap-12">
    {weapon ? <div className="flex flex-wrap gap-8 shrink-0">
      <Button size="sm" variant={!withCharacter ? "primary" : "ghost"} onClick={() => setWithCharacter(false)}>{t("preview.weaponOnly")}</Button>
      <Button size="sm" variant={withCharacter ? "primary" : "ghost"} disabled={!clientId} title={!clientId ? t("preview.selectClient") : undefined}
        onClick={() => setWithCharacter(true)}>{t("preview.withCharacter")}</Button>
    </div> : null}
    {entry.model && withCharacter ? <ModelPreview key="actor" className="shrink-0" clientId={clientId} kind="character" value={actor ?? "kyle/default"} tint={tint}
      heldWeapon={{ request, source, saber: entry.kind === "hilt" }} height="clamp(140px, 24vh, 280px)" /> : entry.model ? <ModelPreview key="object" className="shrink-0" clientId={clientId} source={source}
      {...(parts ? { kind: "character" as const, value: assembledSkinValue(parts) } : request)} tint={tint}
      {...(character && characterHilt ? { heldWeapon: { request: characterHilt.hiltId ? { kind: "hilt" as const, value: characterHilt.hiltId }
        : { kind: "model" as const, value: characterHilt.model!, skins: characterHilt.skins, saber: true }, source: { ...source, archive: characterHilt.archive }, saber: true }, bladeColor: 4 }
        : { sabers: character ? { saber1: DEFAULT_SINGLE_HILT, saber2: "none", color1: 4, color2: 4 } : undefined })}
      height={parts ? "clamp(140px, 24vh, 280px)" : entry.audio.length ? "30vh" : "38vh"} /> : null}
    {parts || withCharacter || entry.audio.length || !entry.model ? <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-12 [&>*]:shrink-0">
    {parts && entry.appearance?.parts ? <PartsPanel parts={entry.appearance.parts} picked={parts} frame="size-44" tintBelow onChange={setParts} /> : null}
    {withCharacter ? <SkinPicker clientId={clientId} value={actor} onChange={setActor} size="sm" tintBelow allowDefault={false} /> : null}
    {parts || withCharacter ? <TintSliders value={tint} onChange={setTint} /> : null}
    {!entry.model || entry.audio.length ? <AudioCollection source={source} entry={entry} /> : null}
    </div> : null}
  </div>;
}

function AudioCollection({ source, entry }: { source: FilePreviewSource; entry: FilePreviewEntry }) {
  const { t } = useTranslation("library");
  const [name, setName] = useState(entry.audio[0]?.name ?? entry.name);
  const selected = entry.audio.find(clip => clip.name === name) ?? entry;
  return <div className={cn("flex flex-col gap-12", !entry.model && "h-full items-center justify-center px-24")}>
    {!entry.model ? <><Music size={48} className="text-fg-accent" aria-hidden="true" /><p className="text-body-lg font-semibold text-center">{entry.label}</p></> : null}
    {entry.audio.length ? <Select value={name} onChange={setName} ariaLabel={t("preview.kind.sound")}
      options={entry.audio.map(clip => ({ value: clip.name, label: clip.label }))} className="w-full" /> : null}
    <AudioPlayer key={selected.name} source={source} name={selected.name} label={selected.label} />
  </div>;
}

function AudioPlayer({ source, name, label }: { source: FilePreviewSource; name: string; label: string }) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const errorText = useErrorText();
  const [failed, setFailed] = useState(false);
  const query = useQuery({
    queryKey: ["file-preview-asset", source, name],
    queryFn: async () => {
      const found = (await filePreviewIpc.assets(source, [name])).find(asset => asset.name === name);
      if (!found) throw new Error("Preview resource is missing");
      return found;
    },
    retry: false, staleTime: Infinity, gcTime: 60_000,
  });
  if (query.error) return <div role="alert" className="flex flex-col gap-12 items-start p-12">
    <p className="text-body-sm text-fg-danger">{errorText(query.error)}</p><Button onClick={() => void query.refetch()}>{common("actions.tryAgain")}</Button>
  </div>;
  if (query.isPending) return <p role="status" className="p-12 text-body-sm text-fg-muted">{t("preview.loading")}</p>;
  const asset = query.data;
  return <div className="w-full flex flex-col gap-12">
    {asset.path ? <audio aria-label={label} controls preload="metadata" src={asset.path} className="w-full" onError={() => setFailed(true)} /> : null}
    {failed ? <p role="alert" className="text-body-sm text-fg-danger">{t("preview.audioFailed")}</p> : null}
  </div>;
}

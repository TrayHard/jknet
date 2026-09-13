import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FileSearch, Music, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import { DEFAULT_SINGLE_HILT } from "../../lib/sabers";
import { matchesPreviewSearch } from "../../lib/previewSearch";
import { assembledSkinValue, parseAssembledSkin, skinIconUrl, filePreviewIpc, type CharColor, type FilePreview, type FilePreviewEntry, type FilePreviewSource } from "../../lib/ipc";
import { ModelPreview } from "../ModelPreview";
import { PartsPanel, SkinPicker } from "../client/SkinPicker";
import { TintSliders } from "../client/TintSliders";
import { LibraryObjectIcon } from "./LibraryObjectIcon";
import { MapScenePreview } from "./MapScenePreview";
import { Badge, Button, Dialog, EmptyState, Input, Select } from "../ui";

export type PreviewTarget =
  | { kind: "installed"; clientId: string; itemId: string; title: string }
  | { kind: "jkhub"; clientId: string | null; id: number; title: string };

export function FilePreviewDialog({ target, onClose, progress }: {
  target: PreviewTarget;
  onClose: () => void;
  progress?: { received: number; total: number } | null;
}) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const { t: jkhub } = useTranslation("jkhub");
  const errorText = useErrorText();
  const format = useFormat();
  const cache = useQueryClient();
  const key = ["file-preview", target.kind, target.clientId, target.kind === "installed" ? target.itemId : target.id];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = target.kind === "installed"
        ? await filePreviewIpc.installed(target.clientId, target.itemId)
        : await filePreviewIpc.jkhub(target.id, target.clientId);
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
  return <PreviewFrame title={target.title} onClose={onClose}>
    {query.isPending ? <p role="status" className="py-24 text-body-sm text-fg-secondary">
      {target.kind === "jkhub" && progress
        ? jkhub(progress.total ? "details.downloadingOf" : "details.downloading", { received: format.bytes(progress.received), total: format.bytes(progress.total) })
        : t("preview.loading")}
    </p> : null}
    {query.error ? <div role="alert" className="flex flex-col items-start gap-12 py-24">
      <p className="text-body-sm text-fg-danger">{errorText(query.error)}</p>
      <Button onClick={() => void query.refetch()}>{common("actions.tryAgain")}</Button>
    </div> : null}
    {query.data ? <Contents key={query.data.id} preview={query.data} clientId={target.clientId ?? ""} /> : null}
  </PreviewFrame>;
}

/** The catalogue owns this session, so closing an object keeps it available. */
export function ReadyFilePreviewDialog({ preview, entry, clientId, onClose }: {
  preview: FilePreview; entry: FilePreviewEntry; clientId: string | null; onClose: () => void;
}) {
  return <PreviewFrame title={entry.label} onClose={onClose}>
    <Contents key={entry.id} preview={preview} clientId={clientId ?? ""} initialId={entry.id} initialKind={entry.kind} />
  </PreviewFrame>;
}

function PreviewFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t: common } = useTranslation("common");
  // Escape closes this preview while retaining a JKHub details dialog behind it.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else onClose();
      }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);

  return <Dialog wide="preview" title={title} onClose={onClose} actions={<Button onClick={onClose}>{common("actions.close")}</Button>}>{children}</Dialog>;
}

export const PREVIEW_KINDS = ["all", "map", "skin", "hilt", "weapon", "npc", "vehicle", "music", "sound"] as const;
const KINDS = PREVIEW_KINDS;
function Contents({ preview, clientId, initialId, initialKind = "all" }: { preview: FilePreview; clientId: string; initialId?: string; initialKind?: string }) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<string>(initialKind);
  const [picked, setPicked] = useState(initialId ?? preview.entries[0]?.id);
  const [shown, setShown] = useState(100);
  const entries = useMemo(() => KINDS.flatMap(group => preview.entries.filter(entry => entry.kind === group && (kind === "all" || entry.kind === kind)
    && matchesPreviewSearch(entry, search))), [preview, search, kind]);
  const selected = entries.find(entry => entry.id === picked) ?? entries[0];
  const characterHilt = preview.entries.find(entry => entry.kind === "hilt" && entry.hiltId?.toLowerCase() === DEFAULT_SINGLE_HILT.toLowerCase())
    ?? preview.entries.find(entry => entry.kind === "hilt" && entry.model === "models/weapons2/saber/saber_w.glm");
  const at = selected ? entries.indexOf(selected) : -1;
  const visibleEntries = entries.slice(0, Math.max(shown, at + 1));
  const choose = (offset: number) => setPicked(entries[(at + offset + entries.length) % entries.length]?.id);

  return <div className="flex flex-col gap-12 pt-16">
    {preview.entries.length > 1 ? <div className="flex items-center flex-wrap gap-8">
      <Input icon={<Search size={16} />} aria-label={t("preview.search")} placeholder={t("preview.search")}
        value={search} onChange={event => { setSearch(event.target.value); setShown(100); }} className="flex-1 min-w-200" />
      <Select value={kind} onChange={value => { setKind(value); setShown(100); }} ariaLabel={t("preview.contents")}
        options={KINDS.filter(value => value === "all" || preview.entries.some(entry => entry.kind === value))
          .map(value => ({ value, label: t(`preview.kind.${value}`) }))} className="w-176" />
      <Badge>{entries.length}</Badge>
    </div> : null}
    <div className="flex gap-16 h-[54vh] min-h-320">
      {preview.entries.length > 1 ? <div className="w-232 shrink-0 overflow-y-auto pr-4" aria-label={t("preview.contents")}>
        {KINDS.filter(group => visibleEntries.some(entry => entry.kind === group)).map(group => <section key={group} className="mb-12" aria-label={t(`preview.kind.${group}`)}>
          <h3 className="flex items-center gap-8 px-8 py-8 text-label-xs text-fg-muted border-b border-line mb-4">
            <LibraryObjectIcon kind={group} size={16} />{t(`preview.kind.${group}`)}
          </h3>
        <ul className="flex flex-col gap-4">
          {visibleEntries.filter(entry => entry.kind === group).map(entry => <li key={entry.id}>
            <button type="button" onClick={() => setPicked(entry.id)} title={entry.label}
              aria-label={entry.label} aria-description={t(`preview.kind.${entry.kind}`)}
              aria-pressed={selected?.id === entry.id}
              className={cn("w-full flex items-center gap-8 px-8 py-8 text-left rounded-md cursor-pointer", selected?.id === entry.id ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay")}>
              {skinIconUrl(entry.appearance?.icon ?? null) ? <img src={skinIconUrl(entry.appearance?.icon ?? null)!} alt="" className="size-32 shrink-0 rounded-sm object-contain" /> : <LibraryObjectIcon kind={entry.kind} size={24} className="shrink-0 text-fg-muted" />}
              <span className="text-body-sm break-words">{entry.label}</span>
            </button>
          </li>)}
        </ul>
        </section>)}
        {shown < entries.length ? <Button size="sm" variant="ghost" onClick={() => setShown(value => value + 100)}>{common("actions.loadMore")}</Button> : null}
      </div> : null}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selected?.kind === "map" ? <MapScenePreview key={selected.id} source={{ previewId: preview.id, archive: selected.archive }} name={selected.name} /> : selected ? <Asset key={selected.id} source={{ previewId: preview.id, archive: selected.archive }} entry={selected} clientId={clientId} characterHilt={characterHilt} /> :
          <EmptyState icon={<FileSearch size={24} />} title={t("preview.empty")} text={t("preview.emptyText")} />}
      </div>
    </div>
    {selected && entries.length > 1 ? <div className="flex items-center gap-8">
      <Button icon={<ChevronLeft size={16} />} aria-label={t("preview.previous")} disabled={entries.length < 2} onClick={() => choose(-1)} />
      <Button icon={<ChevronRight size={16} />} aria-label={t("preview.next")} disabled={entries.length < 2} onClick={() => choose(1)} />
      <span className="text-body-xs text-fg-muted min-w-0 truncate">{selected.label}</span>
      <span className="text-mono-xs text-fg-muted ml-auto whitespace-nowrap">{at + 1} / {entries.length}</span>
    </div> : null}
  </div>;
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

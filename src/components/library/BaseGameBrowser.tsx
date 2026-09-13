import { useQuery } from "@tanstack/react-query";
import { FolderOpen, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import { filePreviewIpc, skinIconUrl, type FilePreviewEntry, type Game, type SortDirection } from "../../lib/ipc";
import { useSettings } from "../../lib/queries";
import { matchesPreviewSearch } from "../../lib/previewSearch";
import { Badge, Button, EmptyState, Input, Select } from "../ui";
import { PREVIEW_KINDS, ReadyFilePreviewDialog } from "./FilePreviewDialog";
import { LibraryObjectIcon } from "./LibraryObjectIcon";
import { LibrarySort } from "./LibrarySort";
import { BaseGameMapCard, useBaseGameMapShots } from "./BaseGameMapCard";

export function BaseGameBrowser({ game, clientId }: { game: Game; clientId: string | null }) {
  const { t } = useTranslation("library"), { t: common } = useTranslation("common");
  const errorText = useErrorText(), navigate = useNavigate();
  const settings = useSettings();
  const key = ["base-game-preview", game, settings.data?.gameDataPaths?.[game], settings.data?.dataDirOverride];
  const query = useQuery({
    queryKey: key,
    enabled: !!settings.data,
    queryFn: async ({ signal }) => {
      const result = await filePreviewIpc.baseGame(game);
      if (signal.aborted) void filePreviewIpc.release(result.id).catch(() => {});
      return result;
    },
    staleTime: Infinity, gcTime: 0, retry: false,
  });
  const mapShots = useBaseGameMapShots(query.data);
  const current = useRef<string | undefined>(undefined);
  const [search, setSearch] = useState(""), [kind, setKind] = useState("all"), [archive, setArchive] = useState("all");
  const [direction, setDirection] = useState<SortDirection>("asc"), [shown, setShown] = useState(120);
  const [picked, setPicked] = useState<FilePreviewEntry | null>(null);
  useEffect(() => {
    const id = query.data?.id; current.current = id; setPicked(null);
    return () => {
      current.current = undefined;
      queueMicrotask(() => { if (id && current.current !== id) void filePreviewIpc.release(id).catch(() => {}); });
    };
  }, [query.data?.id]);
  const matching = useMemo(() => (query.data?.entries ?? []).filter(entry =>
    (archive === "all" || entry.archive === Number(archive)) && matchesPreviewSearch(entry, search)), [query.data, archive, search]);
  const entries = useMemo(() => matching.filter(entry => kind === "all" || entry.kind === kind)
    .sort((a, b) => a.label.localeCompare(b.label) * (direction === "asc" ? 1 : -1)), [matching, kind, direction]);
  useEffect(() => { setShown(120); }, [kind, archive, search, direction]);

  if (query.isPending) return <p role="status" className="text-body-sm text-fg-muted py-24">{t("baseGame.loading")}</p>;
  if (query.error) return <div role="alert" className="flex flex-col items-start gap-12 py-24">
    <p className="text-body-sm text-fg-danger">{errorText(query.error)}</p>
    <Button onClick={() => void query.refetch()}>{common("actions.tryAgain")}</Button>
  </div>;
  if (!query.data.archives.length) return <EmptyState icon={<FolderOpen size={24} />} title={t("baseGame.missingTitle")}
    text={t("baseGame.missingText")} action={<Button onClick={() => void navigate("/settings")}>{t("baseGame.openSettings")}</Button>} />;
  const visible = entries.slice(0, shown);
  return <section aria-label={t("tabs.baseGame")}>
    <p className="text-body-sm text-fg-secondary mb-16">{t("baseGame.description")}</p>
    <div className="flex flex-wrap items-center gap-12 pb-16">
      <Input icon={<Search size={16} />} value={search} onChange={event => setSearch(event.target.value)}
        aria-label={t("baseGame.search")} placeholder={t("baseGame.search")} className="min-w-200 flex-1" />
      <Select value={archive} onChange={setArchive} ariaLabel={t("baseGame.archive")} className="w-176"
        options={[{ value: "all", label: t("baseGame.allArchives") }, ...query.data.archives.map((name, index) => ({ value: String(index), label: name }))]} />
      <LibrarySort value="name" onChange={() => {}} options={[{ value: "name", label: t("sort.name") }]} direction={direction} onDirection={setDirection} />
      <Button icon={<RefreshCw size={16} />} disabled={query.isFetching} onClick={() => { setPicked(null); void query.refetch(); }}>{common("actions.refresh")}</Button>
    </div>
    <div className="flex items-start gap-24">
      <aside className="w-200 shrink-0 flex flex-col gap-2">
        {PREVIEW_KINDS.map(group => <button key={group} type="button" onClick={() => setKind(group)} aria-pressed={kind === group}
          className={cn("flex items-center gap-8 min-h-36 px-12 py-8 rounded-md cursor-pointer text-body-sm transition-colors", kind === group ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg")}>
          <LibraryObjectIcon kind={group} size={16} className="shrink-0" />
          <span className="flex-1 text-left">{t(`preview.kind.${group}`)}</span>
          <Badge>{group === "all" ? matching.length : matching.filter(entry => entry.kind === group).length}</Badge>
        </button>)}
      </aside>
      <div className="flex-1 min-w-0">
        {!entries.length ? <EmptyState icon={<Search size={24} />} title={t("empty.filteredTitle")} text={t("baseGame.noResults")} /> : null}
        {PREVIEW_KINDS.filter(group => visible.some(entry => entry.kind === group)).map(group => <section key={group} className="mb-20" aria-label={t(`preview.kind.${group}`)}>
          <h3 className="flex items-center gap-8 text-label-sm text-fg-muted mb-12"><LibraryObjectIcon kind={group} size={16} />{t(`preview.kind.${group}`)}</h3>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-12">
            {visible.filter(entry => entry.kind === group).map(entry => <li key={entry.id}>
              {entry.kind === "map" ? <BaseGameMapCard entry={entry} archive={query.data.archives[entry.archive]} images={mapShots.data?.get(entry.id)} onOpen={() => setPicked(entry)} />
              : <button type="button" className="w-full h-full flex items-center gap-12 p-16 rounded-lg border border-line bg-surface hover:bg-hover-overlay text-left cursor-pointer"
                aria-label={t("preview.open", { name: entry.label })} onClick={() => setPicked(entry)}>
                {skinIconUrl(entry.appearance?.icon ?? null) ? <img src={skinIconUrl(entry.appearance?.icon ?? null)!} alt="" loading="lazy" className="size-48 object-contain rounded-md shrink-0" />
                  : <LibraryObjectIcon kind={entry.kind} size={40} className="text-fg-muted shrink-0" />}
                <span className="min-w-0"><span className="block text-body-md-medium text-fg break-words">{entry.label}</span>
                  <span className="block text-body-xs text-fg-muted mt-4">{query.data.archives[entry.archive]}</span></span>
              </button>}
            </li>)}
          </ul>
        </section>)}
        {shown < entries.length ? <Button onClick={() => setShown(value => value + 120)}>{common("actions.loadMore")}</Button> : null}
      </div>
    </div>
    {picked ? <ReadyFilePreviewDialog preview={query.data} entry={picked} clientId={clientId} onClose={() => setPicked(null)} /> : null}
  </section>;
}

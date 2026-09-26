import { useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Info,
  Library,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

// --- slice: game switch ---
import { NEW_CLIENT_PARAM } from "../components/MissingClientToast";
import { ConflictsDialog } from "../components/library/ConflictsDialog";
import { JkhubBrowser } from "../components/library/JkhubBrowser";
import { LibrarySearch } from "../components/library/LibrarySearch";
import { LibrarySort } from "../components/library/LibrarySort";
import { LibraryCard } from "../components/library/LibraryCard";
import { FilePreviewDialog } from "../components/library/FilePreviewDialog";
import { BaseGameBrowser } from "../components/library/BaseGameBrowser";
import { RemoveItemDialog } from "../components/library/RemoveItemDialog";
import { CATEGORIES } from "../components/library/categories";
import { Page, PageHeader } from "../components/PageHeader";
// --- slice: pk3 editor ---
import { Pk3EditorDialog } from "../components/pk3/Pk3EditorDialog";
import {
  Badge,
  Button,
  EmptyState,
  Select,
  Toggle,
  type SelectOption,
} from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { cn } from "../lib/format";
import {
  LIBRARY_CHANGED_EVENT,
  type LibraryCategory,
  type LibraryChanged,
  type LibraryItem,
  type SkippedFile,
  type SortDirection,
} from "../lib/ipc";
// --- slice: game switch ---
import {
  clientsOfGame,
  resolveDefaultClientId,
  useActiveGame,
  useGameNames,
} from "../lib/game";
import {
  libraryKeys,
  useAddLibraryFiles,
  useClients,
  useLibrary,
  useLibraryConflicts,
  useRemoveLibraryItem,
  useSetLibraryItemEnabled,
  useSettings,
  useUpdateSettings,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";

type LibraryTab = "installed" | "baseGame" | "jkhub";
type SortMode = "recent" | "name" | "size";
type InstalledCategory = LibraryCategory | "all" | "conflicts";

// --- slice: i18n --- the ids are the state, the labels come from the catalog.
const TAB_IDS: LibraryTab[] = ["installed", "baseGame", "jkhub"];
const SORT_IDS: SortMode[] = ["recent", "name", "size"];

/**
 * Client packages, the active game's original assets, and the JKHub catalogue.
 * Installed files belong to the selected client; original assets are read-only
 * and remain available without a client. JKNet never writes into the game folder.
 */
export function LibraryPage() {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const clients = useClients();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // --- slice: game switch ---
  // The picker offers the clients of the active game. A file installed into a
  // client is read by that client's engine, so a Jedi Academy client in this
  // list while the launcher is on Jedi Outcast is an install that would never
  // be loaded by the game on screen.
  const activeGame = useActiveGame();
  const { label: gameName } = useGameNames();

  const [clientId, setClientId] = useState<string | null>(null);
  const [tab, setTab] = useState<LibraryTab>("installed");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<InstalledCategory>("all");
  const [sort, setSort] = useState<SortMode>("recent");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [removing, setRemoving] = useState<LibraryItem | null>(null);
  const [previewing, setPreviewing] = useState<LibraryItem | null>(null);
  // --- slice: pk3 editor ---
  // The client travels with the file: the editor holds a session on that
  // archive until it closes, whatever the picker says meanwhile.
  const [editing, setEditing] = useState<{ clientId: string; item: LibraryItem } | null>(null);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [showConflictNotice, setShowConflictNotice] = useState<boolean | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const items = useLibrary(clientId);
  const conflicts = useLibraryConflicts(clientId);
  const addFiles = useAddLibraryFiles(clientId);
  const setEnabled = useSetLibraryItemEnabled(clientId);
  const removeItem = useRemoveLibraryItem(clientId);

  const clientList = useMemo(
    () => clientsOfGame(clients.data, activeGame),
    [clients.data, activeGame],
  );
  const client = clientList.find((entry) => entry.id === clientId) ?? null;

  useEffect(() => { setPreviewing(null); }, [clientId, activeGame]);

  // The editor outlives a switch of the picker, but not its client: once the
  // client is deleted, the archive it opened is gone too.
  useEffect(() => {
    if (!editing || !clients.data) return;
    if (!clients.data.some((entry) => entry.id === editing.clientId)) setEditing(null);
  }, [clients.data, editing]);

  // Follows the default client until the player picks another one, and
  // recovers when the selected client is deleted on the Clients screen.
  //
  // --- slice: game switch --- a switch empties this list of the other game's
  // clients, so the selection is re-made from the new game's default one.
  const preferred = resolveDefaultClientId(settings.data, activeGame);
  useEffect(() => {
    if (clientList.length === 0) {
      if (clientId !== null) setClientId(null);
      return;
    }
    if (clientId && clientList.some((entry) => entry.id === clientId)) return;
    const fallback = clientList.find((entry) => entry.id === preferred) ?? clientList[0];
    setClientId(fallback.id);
  }, [clientList, clientId, preferred]);

  const install = (paths: string[]) => {
    if (!clientId || paths.length === 0) return;
    setError(null);
    addFiles.mutate(paths, {
      onSuccess: (result) => setSkipped(result.skipped),
      onError: (e) => setError(errorText(e)),
    });
  };

  // The listeners below are registered once, so they read the current handler
  // through a ref instead of resubscribing on every render.
  const installRef = useRef(install);
  useEffect(() => {
    installRef.current = install;
  });

  // Files dropped on the window go to the selected client. Outside Tauri
  // there is no such event, and `getCurrentWebview` would throw.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
          return;
        }
        setDragging(false);
        if (event.payload.type !== "drop") return;
        const pk3 = event.payload.paths.filter((path) =>
          path.toLowerCase().endsWith(".pk3"),
        );
        installRef.current(pk3);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e: unknown) => setError(errorText(e)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // `library:changed` covers what the mutations do not: a change made while
  // another screen was open, or by a command of another slice.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<LibraryChanged>(LIBRARY_CHANGED_EVENT, (event) => {
      const changed = event.payload.clientId;
      queryClient.invalidateQueries({ queryKey: libraryKeys.items(changed) });
      queryClient.invalidateQueries({ queryKey: libraryKeys.conflicts(changed) });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  const pickFiles = async () => {
    setError(null);
    try {
      const picked = await open({
        multiple: true,
        title: t("pickTitle"),
        filters: [{ name: t("pickFilter"), extensions: ["pk3"] }],
      });
      if (Array.isArray(picked)) install(picked);
    } catch (e) {
      setError(errorText(e));
    }
  };

  // ---------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------

  const all = useMemo(() => items.data ?? [], [items.data]);

  const matching = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((item) => {
      if (onlyEnabled && !item.enabled) return false;
      if (!needle) return true;
      return (
        item.displayName.toLowerCase().includes(needle) ||
        item.fileName.toLowerCase().includes(needle)
      );
    });
  }, [all, search, onlyEnabled]);

  const counts = useMemo(() => {
    const map = new Map<LibraryCategory, number>();
    for (const item of matching) {
      map.set(item.category, (map.get(item.category) ?? 0) + 1);
    }
    return map;
  }, [matching]);

  const conflictReport = conflicts.data ?? null;
  const conflicting = useMemo(
    () => new Set(conflictReport?.files ?? []),
    [conflictReport],
  );

  const shown = useMemo(() => {
    const list = matching.filter((item) => {
      if (category === "all") return true;
      if (category === "conflicts") return conflicting.has(item.id);
      return item.category === category;
    });
    const sorted = [...list];
    sorted.sort((a, b) => {
      const order = sort === "name"
        ? a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
        : sort === "size" ? a.size - b.size : a.addedAt.localeCompare(b.addedAt);
      return (direction === "asc" ? order : -order) || a.id.localeCompare(b.id);
    });
    return sorted;
  }, [matching, category, sort, direction, conflicting]);
  const noticeVisible =
    showConflictNotice ?? (settings.data?.libraryConflictNoticeDismissed === false);
  const dismissConflicts = () => {
    setShowConflictNotice(false);
    updateSettings.mutate({ libraryConflictNoticeDismissed: true }, {
      onError: (failure) => setError(errorText(failure)),
    });
  };
  const showConflicts = () => {
    setShowConflictNotice(true);
    requestAnimationFrame(() => noticeRef.current?.scrollIntoView({ block: "nearest" }));
  };

  const queryError = clients.error ?? items.error ?? conflicts.error ?? null;
  const failure = error ?? (queryError ? errorText(queryError) : null);
  const busy = addFiles.isPending || setEnabled.isPending || removeItem.isPending;

  const clientOptions: SelectOption[] = clientList.map((entry) => ({
    value: entry.id,
    label: entry.name,
  }));

  return (
    <Page>
      <PageHeader title={t("title")} />

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      {/* The target client and the local install action stay together. */}
      <section className="flex flex-wrap items-center gap-12 rounded-lg border border-line bg-surface p-12 mb-16">
        <span className="text-label-xs text-fg-muted">{t("clientBar.label")}</span>
        <Select
          ariaLabel={t("clientBar.label")}
          options={clientOptions}
          placeholder={tCommon("select.nothingToChoose")}
          value={clientId ?? ""}
          onChange={setClientId}
          className="w-200"
        />
        <Button
          variant="primary"
          icon={<Plus size={16} />}
          disabled={!clientId || busy}
          onClick={() => void pickFiles()}
          className="ml-auto"
        >
          {t("addFiles")}
        </Button>
      </section>

      {/* Tabs ------------------------------------------------------------ */}
      <nav className="flex items-center gap-4 border-b border-line mb-16">
        {TAB_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "h-36 px-12 -mb-1 border-b-2 cursor-pointer transition-colors duration-150",
              "text-body-md-medium",
              tab === id
                ? "border-line-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </nav>

      {/* Both tabs work in the active game. The Installed tab gets it through
          the client picker above, which offers this game's clients only; the
          Browse JKHub tab reads it itself with `useActiveGame` and browses that
          game's roots, so a Jedi Outcast file is never offered for install into
          a Jedi Academy client. */}
      {tab === "installed" ? (
        <InstalledTab
          clients={clientOptions.length}
          gameName={gameName(activeGame)}
          onCreateClient={() => void navigate(`/clients?${NEW_CLIENT_PARAM}=1`)}
          clientName={client?.name ?? t("fallback.thisClient")}
          hasClient={clientId != null}
          loading={items.isLoading}
          all={all}
          shown={shown}
          counts={counts}
          category={category}
          onCategory={setCategory}
          sort={sort}
          onSort={setSort}
          direction={direction}
          onDirection={setDirection}
          search={search}
          onSearch={setSearch}
          onlyEnabled={onlyEnabled}
          onOnlyEnabled={setOnlyEnabled}
          conflicting={conflicting}
          conflictCount={conflictReport?.files.length ?? 0}
          onShowConflicts={() => setConflictsOpen(true)}
          noticeVisible={noticeVisible}
          noticeRef={noticeRef}
          onDismissNotice={dismissConflicts}
          onConflict={showConflicts}
          conflictMatches={matching.filter(item => conflicting.has(item.id)).length}
          busy={busy}
          onToggle={(item, enabled) =>
            setEnabled.mutate(
              { id: item.id, enabled },
              { onError: (e) => setError(errorText(e)) },
            )
          }
          onRemove={setRemoving}
          onPreview={setPreviewing}
          onEdit={(item) => {
            if (clientId) setEditing({ clientId, item });
          }}
        />
      ) : tab === "baseGame" ? <BaseGameBrowser key={activeGame} game={activeGame} clientId={clientId} /> : (
        // --- slice: jkhub ---
        <JkhubBrowser
          clientId={clientId}
          clientName={client?.name ?? t("fallback.theClient")}
          installed={all}
          search={search}
          onSearch={setSearch}
        />
      )}

      {/* Notices --------------------------------------------------------- */}
      {skipped.length > 0 ? (
        <div
          role="status"
          className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle p-12 mt-16"
        >
          <Info size={16} className="text-fg-warm shrink-0 mt-2" />
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <span className="text-body-sm-medium text-fg">
              {t("skipped.title", { count: skipped.length })}
            </span>
            <ul className="flex flex-col gap-2">
              {skipped.map((entry) => (
                <li key={entry.path} className="text-body-sm text-fg-secondary">
                  <span className="text-mono-xs text-fg">{entry.fileName}</span>
                  {" — "}
                  {/* The reason comes from the core as a rendered sentence. */}
                  {entry.reason}
                  {entry.suggestedName
                    ? ` ${t("skipped.rename", { name: entry.suggestedName })}`
                    : ""}
                </li>
              ))}
            </ul>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setSkipped([])}>
            {tCommon("actions.dismiss")}
          </Button>
        </div>
      ) : null}

      {/* Drag and drop --------------------------------------------------- */}
      {dragging ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay pointer-events-none">
          <div className="flex flex-col items-center gap-12 rounded-xl border border-dashed border-line-accent bg-surface px-48 py-32">
            <Upload size={28} className="text-fg-accent" />
            <span className="text-heading-sm text-fg">
              {t("drop.title", {
                client: client?.name ?? t("fallback.theClient"),
              })}
            </span>
          </div>
        </div>
      ) : null}

      {conflictsOpen && conflictReport ? (
        <ConflictsDialog
          report={conflictReport}
          items={all}
          clientName={client?.name ?? t("fallback.thisClient")}
          busy={busy}
          onClose={() => setConflictsOpen(false)}
          onDisable={(id) =>
            setEnabled.mutate(
              { id, enabled: false },
              { onError: (e) => setError(errorText(e)) },
            )
          }
        />
      ) : null}

      {previewing && clientId ? <FilePreviewDialog
        target={{ kind: "installed", clientId, itemId: previewing.id, title: previewing.displayName }}
        onClose={() => setPreviewing(null)}
      /> : null}

      {/* --- slice: pk3 editor --- a file of the client, opened from its
          card. **Save** re-reads the list and the conflicts through the
          hooks of the editor; closing without it leaves the file as it was. */}
      {editing ? (
        <Pk3EditorDialog
          target={{ kind: "library", clientId: editing.clientId, itemId: editing.item.id }}
          title={editing.item.displayName}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {removing ? (
        <RemoveItemDialog
          item={removing}
          clientName={client?.name ?? t("fallback.thisClient")}
          busy={removeItem.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() =>
            removeItem.mutate(removing.id, {
              onSuccess: () => setRemoving(null),
              onError: (e) => {
                setError(errorText(e));
                setRemoving(null);
              },
            })
          }
        />
      ) : null}
    </Page>
  );
}

interface InstalledTabProps {
  clients: number;
  // --- slice: game switch ---
  /** Name of the active game, for the empty state that has no client to show. */
  gameName: string;
  /** Opens the New client dialog on the Clients screen. */
  onCreateClient: () => void;
  clientName: string;
  hasClient: boolean;
  loading: boolean;
  all: LibraryItem[];
  shown: LibraryItem[];
  counts: Map<LibraryCategory, number>;
  category: InstalledCategory;
  onCategory: (category: InstalledCategory) => void;
  sort: SortMode;
  onSort: (sort: SortMode) => void;
  direction: SortDirection;
  onDirection: (direction: SortDirection) => void;
  search: string;
  onSearch: (search: string) => void;
  onlyEnabled: boolean;
  onOnlyEnabled: (value: boolean) => void;
  conflicting: Set<string>;
  conflictCount: number;
  onShowConflicts: () => void;
  noticeVisible: boolean;
  noticeRef: React.RefObject<HTMLDivElement | null>;
  onDismissNotice: () => void;
  onConflict: () => void;
  conflictMatches: number;
  busy: boolean;
  onToggle: (item: LibraryItem, enabled: boolean) => void;
  onRemove: (item: LibraryItem) => void;
  onPreview: (item: LibraryItem) => void;
  // --- slice: pk3 editor ---
  onEdit: (item: LibraryItem) => void;
}

/** The Installed tab: categories on the left, cards on the right. */
function InstalledTab({
  clients,
  gameName,
  onCreateClient,
  clientName,
  hasClient,
  loading,
  all,
  shown,
  counts,
  category,
  onCategory,
  sort,
  onSort,
  direction,
  onDirection,
  search,
  onSearch,
  onlyEnabled,
  onOnlyEnabled,
  conflicting,
  conflictCount,
  onShowConflicts,
  noticeVisible,
  noticeRef,
  onDismissNotice,
  onConflict,
  conflictMatches,
  busy,
  onToggle,
  onRemove,
  onPreview,
  onEdit,
}: InstalledTabProps) {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");

  if (clients === 0) {
    return (
      <EmptyState
        icon={<Library size={24} />}
        // --- slice: game switch --- the game is named, because a player with
        // clients on the other segment has not lost them.
        title={t("empty.noClientsTitle", { game: gameName })}
        text={t("empty.noClientsText")}
        action={
          <Button variant="primary" icon={<Plus size={16} />} onClick={onCreateClient}>
            {t("empty.newClient")}
          </Button>
        }
      />
    );
  }

  if (loading || !hasClient) {
    return <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>;
  }

  if (all.length === 0) {
    return (
      <EmptyState
        icon={<Library size={24} />}
        title={t("empty.noFilesTitle", { client: clientName })}
        text={t("empty.noFilesText")}
      />
    );
  }

  return (
    <>
      {noticeVisible && conflictCount > 1 ? (
        <div
          ref={noticeRef}
          role="status"
          className="flex flex-wrap items-center gap-8 rounded-md border border-line-warm bg-warm-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-warm shrink-0" />
          <span className="text-body-sm text-fg flex-1">
            {t("conflicts.notice", { count: conflictCount })}
          </span>
          <Button size="sm" onClick={onShowConflicts}>
            {t("conflicts.see")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="px-8"
            aria-label={t("conflicts.dismissNotice")}
            title={t("conflicts.dismissNotice")}
            onClick={onDismissNotice}
          >
            <X size={16} aria-hidden />
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-12 pb-16">
        <LibrarySearch value={search} onChange={onSearch} />
        <label className="flex items-center gap-8 cursor-pointer ml-auto">
          <Toggle label={t("onlyEnabledSwitch")} checked={onlyEnabled} onChange={onOnlyEnabled} />
          <span className="text-body-sm text-fg-secondary">{t("onlyEnabled")}</span>
        </label>
        <LibrarySort
          value={sort}
          onChange={value => onSort(value as SortMode)}
          options={SORT_IDS.map(id => ({ value: id, label: t(`sort.${id}`) }))}
          direction={direction}
          onDirection={onDirection}
        />
      </div>

      {/* --- slice: chat layout --- the widths are the page's, not the
          window's: the chat drawer pinned beside the page takes 380 px of the
          window (`AppShell`). On a narrow page the categories wrap above the
          cards instead of taking 200 px beside them. */}
      <div className="flex items-start gap-24 @max-[760px]/page:flex-col @max-[760px]/page:items-stretch @max-[760px]/page:gap-16">
        <aside className="w-200 shrink-0 flex flex-col gap-2 @max-[760px]/page:w-auto @max-[760px]/page:flex-row @max-[760px]/page:flex-wrap @max-[760px]/page:gap-4">
          <CategoryButton
            label={t("categories.all")}
            count={[...counts.values()].reduce((sum, n) => sum + n, 0)}
            active={category === "all"}
            onClick={() => onCategory("all")}
          />
          <CategoryButton
            label={t("categories.conflicts")}
            count={conflictMatches}
            active={category === "conflicts"}
            onClick={() => onCategory("conflicts")}
          />
          {CATEGORIES.map((entry) => (
            <CategoryButton
              key={entry.id}
              label={t(`categories.${entry.id}`)}
              count={counts.get(entry.id) ?? 0}
              active={category === entry.id}
              onClick={() => onCategory(entry.id)}
            />
          ))}
        </aside>

        <div className="flex-1 min-w-0">
          {shown.length === 0 ? (
            <EmptyState
              icon={<Search size={24} />}
              title={t("empty.filteredTitle")}
              text={t("empty.filteredText")}
            />
          ) : (
            <ul className="grid grid-cols-1 @min-[568px]/page:grid-cols-2 @min-[1048px]/page:grid-cols-3 gap-12">
              {shown.map((item) => (
                <LibraryCard
                  key={item.id}
                  item={item}
                  busy={busy}
                  conflicting={conflicting.has(item.id)}
                  onConflict={onConflict}
                  onToggle={(enabled) => onToggle(item, enabled)}
                  onRemove={() => onRemove(item)}
                  onPreview={() => onPreview(item)}
                  // Every card here is a file of the player: the engine's
                  // own archives never reach this list.
                  onEdit={() => onEdit(item)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

interface CategoryButtonProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function CategoryButton({ label, count, active, onClick }: CategoryButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-8 h-36 px-12 rounded-md cursor-pointer",
        "text-body-md-medium transition-colors duration-150",
        active
          ? "bg-selected-overlay text-fg"
          : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
      )}
    >
      <span className="flex-1 text-left truncate">{label}</span>
      <Badge tone={active ? "accent" : "neutral"}>{count}</Badge>
    </button>
  );
}

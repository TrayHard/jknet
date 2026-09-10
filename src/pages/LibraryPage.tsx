import { useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ExternalLink,
  Info,
  Library,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

// --- slice: game switch ---
import { NEW_CLIENT_PARAM } from "../components/MissingClientToast";
import { ConflictsDialog } from "../components/library/ConflictsDialog";
import { JkhubBrowser } from "../components/library/JkhubBrowser";
import { LibraryCard } from "../components/library/LibraryCard";
import { RemoveItemDialog } from "../components/library/RemoveItemDialog";
import { CATEGORIES } from "../components/library/categories";
import { Page, PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Toggle,
  type SelectOption,
} from "../components/ui";
import { cn, formatBytes } from "../lib/format";
import {
  errorMessage,
  LIBRARY_CHANGED_EVENT,
  type LibraryCategory,
  type LibraryChanged,
  type LibraryItem,
  type SkippedFile,
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
  useEngines,
  useLibrary,
  useLibraryConflicts,
  useRemoveLibraryItem,
  useSetLibraryItemEnabled,
  useSettings,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";

/** Where the community publishes the files this screen installs. */
const JKHUB_FILES = "https://jkhub.org/files/";

type LibraryTab = "installed" | "jkhub" | "updates";
type SortMode = "recent" | "name" | "size";

const TABS: Array<{ id: LibraryTab; label: string }> = [
  { id: "installed", label: "Installed" },
  { id: "jkhub", label: "Browse JKHub" },
  { id: "updates", label: "Updates" },
];

const SORTS: SelectOption[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "size", label: "Size" },
];

/**
 * The Library screen: the pk3 files of one client.
 *
 * Everything on the screen is scoped to the client picked in the bar under
 * the title. A file belongs to a client, not to the launcher, because the
 * engine reads it from that client's `home\` folder — JKNet never writes into
 * the game folder.
 */
export function LibraryPage() {
  const clients = useClients();
  const settings = useSettings();
  const engines = useEngines();
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
  const [category, setCategory] = useState<LibraryCategory | "all">("all");
  const [sort, setSort] = useState<SortMode>("recent");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [removing, setRemoving] = useState<LibraryItem | null>(null);
  const [conflictsOpen, setConflictsOpen] = useState(false);
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
      onError: (e) => setError(errorMessage(e)),
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
      .catch((e: unknown) => setError(errorMessage(e)));
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
        title: "Add pk3 files",
        filters: [{ name: "Jedi Academy archives", extensions: ["pk3"] }],
      });
      if (Array.isArray(picked)) install(picked);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const browseJkhub = () => {
    if (!isTauri()) return;
    void openUrl(JKHUB_FILES).catch((e: unknown) => setError(errorMessage(e)));
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

  const shown = useMemo(() => {
    const list = matching.filter(
      (item) => category === "all" || item.category === category,
    );
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === "name") {
        return a.displayName.localeCompare(b.displayName, undefined, {
          sensitivity: "base",
        });
      }
      if (sort === "size") return b.size - a.size;
      return b.addedAt.localeCompare(a.addedAt);
    });
    return sorted;
  }, [matching, category, sort]);

  const conflictReport = conflicts.data ?? null;
  const conflicting = useMemo(
    () => new Set(conflictReport?.files ?? []),
    [conflictReport],
  );

  const enabledCount = all.filter((item) => item.enabled).length;
  const totalSize = all.reduce((sum, item) => sum + item.size, 0);
  const engineName =
    engines.data?.find((engine) => engine.id === client?.engineId)?.name ??
    client?.engineId ??
    "no engine";

  const subtitle = client
    ? `${client.name} · ${engineName} · ${all.length} files · ${enabledCount} enabled · ${formatBytes(totalSize)}`
    : "Skins, hilts, maps and mods, installed into the client you choose.";

  const queryError = clients.error ?? items.error ?? conflicts.error ?? null;
  const failure = error ?? (queryError ? errorMessage(queryError) : null);
  const busy = addFiles.isPending || setEnabled.isPending || removeItem.isPending;

  const clientOptions: SelectOption[] = clientList.map((entry) => ({
    value: entry.id,
    label: entry.name,
  }));

  return (
    <Page>
      <PageHeader
        title="Library"
        subtitle={subtitle}
        actions={
          <>
            <Input
              icon={<Search size={16} />}
              placeholder="Search files"
              value={search}
              className="w-232"
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button icon={<ExternalLink size={16} />} onClick={browseJkhub}>
              Browse JKHub
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={16} />}
              disabled={!clientId || busy}
              onClick={() => void pickFiles()}
            >
              Add files
            </Button>
          </>
        }
      />

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      {/* Client bar ------------------------------------------------------ */}
      <section className="flex items-center gap-12 rounded-lg border border-line bg-surface p-12 mb-16">
        <span className="text-label-xs text-fg-muted">Client</span>
        <Select
          ariaLabel="Client"
          options={clientOptions}
          placeholder="Nothing to choose"
          value={clientId ?? ""}
          onChange={setClientId}
          className="w-200"
        />
        <p className="text-body-sm text-fg-muted flex-1 min-w-0">
          Files are installed into this client only. Another client with the
          same engine keeps its own set. {gameName(activeGame)} clients are
          listed here; switch game in the sidebar for the other ones.
        </p>
      </section>

      {/* Tabs ------------------------------------------------------------ */}
      <nav className="flex items-center gap-4 border-b border-line mb-16">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "h-36 px-12 -mb-1 border-b-2 cursor-pointer transition-colors duration-150",
              "text-body-md-medium",
              tab === entry.id
                ? "border-line-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {entry.label}
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
          clientName={client?.name ?? "This client"}
          hasClient={clientId != null}
          loading={items.isLoading}
          all={all}
          shown={shown}
          counts={counts}
          category={category}
          onCategory={setCategory}
          sort={sort}
          onSort={setSort}
          onlyEnabled={onlyEnabled}
          onOnlyEnabled={setOnlyEnabled}
          conflicting={conflicting}
          conflictCount={conflictReport?.files.length ?? 0}
          onShowConflicts={() => setConflictsOpen(true)}
          busy={busy}
          onToggle={(item, enabled) =>
            setEnabled.mutate(
              { id: item.id, enabled },
              { onError: (e) => setError(errorMessage(e)) },
            )
          }
          onRemove={setRemoving}
          onBrowse={browseJkhub}
          onAdd={() => void pickFiles()}
        />
      ) : tab === "jkhub" ? (
        // --- slice: jkhub ---
        <JkhubBrowser
          clientId={clientId}
          clientName={client?.name ?? "the client"}
          installed={all}
        />
      ) : (
        <EmptyState
          icon={<ExternalLink size={24} />}
          title="No updates yet"
          text="Once files carry a JKHub version, the ones with a newer release show up here."
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
              {skipped.length} file{skipped.length === 1 ? "" : "s"} were not added
            </span>
            <ul className="flex flex-col gap-2">
              {skipped.map((entry) => (
                <li key={entry.path} className="text-body-sm text-fg-secondary">
                  <span className="text-mono-xs text-fg">{entry.fileName}</span>
                  {" — "}
                  {entry.reason}
                  {entry.suggestedName ? ` Rename it to ${entry.suggestedName}.` : ""}
                </li>
              ))}
            </ul>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setSkipped([])}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {/* Drag and drop --------------------------------------------------- */}
      {dragging ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay pointer-events-none">
          <div className="flex flex-col items-center gap-12 rounded-xl border border-dashed border-line-accent bg-surface px-48 py-32">
            <Upload size={28} className="text-fg-accent" />
            <span className="text-heading-sm text-fg">
              Drop pk3 files to install them into {client?.name ?? "the client"}
            </span>
          </div>
        </div>
      ) : null}

      {conflictsOpen && conflictReport ? (
        <ConflictsDialog
          report={conflictReport}
          items={all}
          clientName={client?.name ?? "this client"}
          busy={busy}
          onClose={() => setConflictsOpen(false)}
          onDisable={(id) =>
            setEnabled.mutate(
              { id, enabled: false },
              { onError: (e) => setError(errorMessage(e)) },
            )
          }
        />
      ) : null}

      {removing ? (
        <RemoveItemDialog
          item={removing}
          clientName={client?.name ?? "this client"}
          busy={removeItem.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() =>
            removeItem.mutate(removing.id, {
              onSuccess: () => setRemoving(null),
              onError: (e) => {
                setError(errorMessage(e));
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
  category: LibraryCategory | "all";
  onCategory: (category: LibraryCategory | "all") => void;
  sort: SortMode;
  onSort: (sort: SortMode) => void;
  onlyEnabled: boolean;
  onOnlyEnabled: (value: boolean) => void;
  conflicting: Set<string>;
  conflictCount: number;
  onShowConflicts: () => void;
  busy: boolean;
  onToggle: (item: LibraryItem, enabled: boolean) => void;
  onRemove: (item: LibraryItem) => void;
  onBrowse: () => void;
  onAdd: () => void;
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
  onlyEnabled,
  onOnlyEnabled,
  conflicting,
  conflictCount,
  onShowConflicts,
  busy,
  onToggle,
  onRemove,
  onBrowse,
  onAdd,
}: InstalledTabProps) {
  if (clients === 0) {
    return (
      <EmptyState
        icon={<Library size={24} />}
        // --- slice: game switch --- the game is named, because a player with
        // clients on the other segment has not lost them.
        title={`No ${gameName} clients yet`}
        text="A library file is installed into a client. Create one and this list starts filling up."
        action={
          <Button variant="primary" icon={<Plus size={16} />} onClick={onCreateClient}>
            New client
          </Button>
        }
      />
    );
  }

  if (loading || !hasClient) {
    return <p className="text-body-sm text-fg-muted">Loading…</p>;
  }

  if (all.length === 0) {
    return (
      <EmptyState
        icon={<Library size={24} />}
        title={`${clientName} has no files yet`}
        text="Find skins, hilts, maps and mods on JKHub, then add the pk3 files here. You can also drop them straight onto this window."
        action={
          <div className="flex items-center gap-8">
            <Button icon={<ExternalLink size={16} />} onClick={onBrowse}>
              Browse JKHub
            </Button>
            <Button variant="primary" icon={<Plus size={16} />} onClick={onAdd}>
              Add files
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <>
      {conflictCount > 1 ? (
        <div
          role="status"
          className="flex items-center gap-8 rounded-md border border-line-warm bg-warm-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-warm shrink-0" />
          <span className="text-body-sm text-fg flex-1">
            {conflictCount} files change the same content. The engine loads the
            last one and ignores the rest.
          </span>
          <Button size="sm" onClick={onShowConflicts}>
            See what wins
          </Button>
        </div>
      ) : null}

      <div className="flex items-start gap-24">
        <aside className="w-200 shrink-0 flex flex-col gap-2">
          <CategoryButton
            label="All"
            count={[...counts.values()].reduce((sum, n) => sum + n, 0)}
            active={category === "all"}
            onClick={() => onCategory("all")}
          />
          {CATEGORIES.map((entry) => (
            <CategoryButton
              key={entry.id}
              label={entry.label}
              count={counts.get(entry.id) ?? 0}
              active={category === entry.id}
              onClick={() => onCategory(entry.id)}
            />
          ))}
        </aside>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-12 pb-12">
            <label className="flex items-center gap-8 cursor-pointer">
              <Toggle
                label="Show only enabled files"
                checked={onlyEnabled}
                onChange={onOnlyEnabled}
              />
              <span className="text-body-sm text-fg-secondary">Only enabled</span>
            </label>
            <span className="flex-1" />
            <span className="text-label-xs text-fg-muted">Sort by</span>
            <Select
              ariaLabel="Sort by"
              options={SORTS}
              value={sort}
              onChange={(value) => onSort(value as SortMode)}
              className="w-136"
            />
          </div>

          {shown.length === 0 ? (
            <EmptyState
              icon={<Search size={24} />}
              title="Nothing matches"
              text="No file in this client matches the search and the filters. Clear them to see the whole library."
            />
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-12">
              {shown.map((item) => (
                <LibraryCard
                  key={item.id}
                  item={item}
                  busy={busy}
                  conflicting={conflicting.has(item.id)}
                  onToggle={(enabled) => onToggle(item, enabled)}
                  onRemove={() => onRemove(item)}
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

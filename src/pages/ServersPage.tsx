import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
  Server as ServerIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// --- slice: game switch ---
import { useMissingClientToast } from "../components/MissingClientToast";
import { PageHeader } from "../components/PageHeader";
import { ServerDetails } from "../components/servers/ServerDetails";
import { ROW_COLUMNS, ServerRow } from "../components/servers/ServerRow";
import { SkeletonRows } from "../components/servers/SkeletonRow";
import { Tabs, type TabDefinition } from "../components/servers/Tabs";
import {
  applyFilters,
  applyTab,
  DEFAULT_DIRECTION,
  DEFAULT_FILTERS,
  distinctValues,
  filtersAreDefault,
  isBotOnly,
  sortServers,
  totalBots,
  totalRealPlayers,
  type ServerFilters,
  type ServerTab,
  type SortColumn,
  type SortDirection,
} from "../components/servers/filter";
import {
  respondedSoFar,
  rowsToHold,
  scanLabel,
  scanView,
} from "../components/servers/refreshView";
import {
  Button,
  EmptyState,
  Input,
  Select,
  Toggle,
  type SelectOption,
} from "../components/ui";
import { cn } from "../lib/format";
import {
  errorMessage,
  type Game,
  type GameInfo,
  type ServerInfo,
  type ServersDoneEvent,
} from "../lib/ipc";
// --- slice: game switch ---
import { useActiveGame, useDefaultClient, useGameNames } from "../lib/game";
import {
  useAddServerHistory,
  useCachedServers,
  useGameInfo,
  useLaunchClient,
  useServerRefresh,
  useServerStatus,
  useSetServerFavorite,
  useSettings,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";

/**
 * When the screen refreshes by itself.
 *
 * One refresh is around 230 UDP probes and four seconds, so opening the tab
 * for the third time in a minute must not start a third scan. The timestamp
 * lives outside the component because the route unmounts on every navigation.
 */
const AUTO_REFRESH_AFTER_MS = 60_000;
// --- slice: game switch ---
// One stamp per game: the two lists come from different master servers, so a
// refresh of Jedi Academy says nothing about how fresh the Jedi Outcast list is.
const lastAutoRefresh: Partial<Record<Game, number>> = {};

/**
 * Servers: the browser over the two Quake 3 master servers.
 *
 * The screen renders the cached list first, then fills in live rows as
 * `servers:batch` events arrive, which is why the table is never empty while
 * a scan runs. Filters, tabs and sorting are pure functions in
 * `components/servers/filter.ts`; this file only holds the state.
 */
export function ServersPage() {
  const settings = useSettings();
  const cached = useCachedServers();
  const refresh = useServerRefresh();
  const setFavorite = useSetServerFavorite();
  const addHistory = useAddServerHistory();
  const launchClient = useLaunchClient();
  // --- slice: game switch ---
  // The list, the filters, the tabs and Connect all belong to one game. The
  // queries are keyed by it already, so the switch is what makes them refetch;
  // what this screen adds is forgetting the rows and the selection of the game
  // it just left.
  const activeGame = useActiveGame();
  const gameInfo = useGameInfo(activeGame);
  const { label: gameName } = useGameNames();
  const defaultClient = useDefaultClient();
  const missingClientToast = useMissingClientToast();

  const [tab, setTab] = useState<ServerTab>("all");
  const [filters, setFilters] = useState<ServerFilters>(DEFAULT_FILTERS);
  const [sortColumn, setSortColumn] = useState<SortColumn>("players");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const startRefresh = refresh.refresh;
  const attempted = useRef(false);
  // The scan waits for the list on disk. It is a few milliseconds away, and
  // starting without it would leave the screen holding an empty table for the
  // four seconds the scan takes — the skeleton belongs to the first run of a
  // fresh install, not to every visit.
  const cacheSettled = !cached.isPending;
  // --- slice: game switch ---
  // The switch is a new list to fetch, so the screen asks for it as if it had
  // just been opened. `attempted` is reset by the game as well, which is what
  // makes the first look at Jedi Outcast scan instead of showing an empty
  // table until the player presses Refresh.
  const attemptedFor = useRef<Game | null>(null);
  useEffect(() => {
    if (attemptedFor.current !== activeGame) {
      attemptedFor.current = activeGame;
      attempted.current = false;
    }
    if (attempted.current || !isTauri() || !cacheSettled) return;
    // A scan of the game the player just left is still in flight, and the core
    // runs one at a time. Waiting costs nothing: this effect runs again the
    // moment that scan ends.
    if (refresh.running) return;
    attempted.current = true;
    const last = lastAutoRefresh[activeGame] ?? 0;
    if (Date.now() - last < AUTO_REFRESH_AFTER_MS) return;
    lastAutoRefresh[activeGame] = Date.now();
    startRefresh();
  }, [startRefresh, cacheSettled, activeGame, refresh.running]);

  const live = useMemo(() => cached.data ?? [], [cached.data]);
  // The rows the whole screen works from. While a scan runs they are the ones
  // it started with, so counts, tabs, filter options and the table agree with
  // each other and none of them moves under the cursor.
  //
  // --- slice: game switch --- the hold is dropped when the game changes: rows
  // held from a Jedi Academy scan have no business under a Jedi Outcast list.
  const held = useHeldRows(live, refresh.running, activeGame);
  const view = scanView(live, held, refresh.running);
  const all = view.rows;
  const historyAddresses = useMemo(
    () => (settings.data?.serverHistory ?? []).map((entry) => entry.address),
    [settings.data],
  );

  // --- slice: game switch ---
  // The selection and the filters are bound to the list they were made on: a
  // mod folder and a gametype number mean different things in the two games —
  // number 7 is Siege in Jedi Academy and CTF in Jedi Outcast — so carrying
  // them over would hide rows for a reason nothing on screen explains. The
  // tabs stay: All, Trusted, Favorites and History mean the same in both.
  useEffect(() => {
    setSelectedAddress(null);
    setFilters(DEFAULT_FILTERS);
  }, [activeGame]);

  const visible = useMemo(() => {
    const inTab = applyTab(all, tab, historyAddresses);
    const filtered = applyFilters(inTab, filters);
    // History keeps its own order: the point of the tab is when, not how busy.
    return tab === "history"
      ? filtered
      : sortServers(filtered, sortColumn, sortDirection);
  }, [all, tab, historyAddresses, filters, sortColumn, sortDirection]);

  const selected = visible.find((row) => row.address === selectedAddress);
  const status = useServerStatus(selected?.address ?? null);

  // Both counts run over the whole list, not the filtered one: the head of the
  // subtitle already says "X of N servers", so the rest describes the network
  // rather than the current search box.
  const playersOnline = useMemo(() => totalRealPlayers(all), [all]);
  const botsOnline = useMemo(() => totalBots(all), [all]);
  /** Rows the bot switch takes off the table, for the empty state to name. */
  const hiddenBotOnly = useMemo(
    () => (filters.hideBotOnly ? all.filter(isBotOnly).length : 0),
    [all, filters.hideBotOnly],
  );
  const secondsAgo = useSecondsSince(refresh.refreshedAt);

  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection(DEFAULT_DIRECTION[column]);
  };

  /**
   * Records the address and starts the default client on it.
   *
   * History is written first and on its own: the player pressed Connect, so
   * the row belongs in History even when the launch fails on a missing engine.
   */
  const connect = () => {
    if (selected === undefined) return;
    // --- slice: game switch ---
    // The row belongs to the active game, so the client that reaches it is
    // that game's. Without one the press is answered by a toast that names the
    // game and offers to make the client, rather than by a dead button.
    if (defaultClient === undefined) {
      missingClientToast(activeGame);
      return;
    }
    // The core refuses a second game anyway; stopping here keeps the player
    // from seeing "is already running" after their own double click.
    if (launchClient.isPending) return;
    setConnectError(null);
    addHistory.mutate(selected.address);
    launchClient.mutate(
      { clientId: defaultClient.id, connect: selected.address },
      { onError: (e) => setConnectError(errorMessage(e)) },
    );
  };

  const listError = cached.error !== null ? errorMessage(cached.error) : null;

  return (
    <div className="flex flex-col h-full p-24">
      <PageHeader
        title="Servers"
        subtitle={describeCounts({
          // --- slice: game switch --- the list is one game's, and the line
          // says which: two lists that look alike need naming apart.
          game: gameName(activeGame),
          visible: visible.length,
          total: all.length,
          players: playersOnline,
          bots: botsOnline,
          secondsAgo,
          scanning: refresh.running,
          progress: refresh.progress,
        })}
        actions={
          <>
            <Input
              icon={<Search size={16} />}
              placeholder="Name, map or address"
              value={filters.search}
              onChange={(event) =>
                setFilters({ ...filters, search: event.target.value })
              }
              className="w-260"
            />
            <Button
              icon={
                <RefreshCw
                  size={16}
                  className={refresh.running ? "animate-spin" : undefined}
                />
              }
              disabled={refresh.running}
              onClick={startRefresh}
            >
              {refresh.running ? "Scanning" : "Refresh"}
            </Button>
          </>
        }
      />

      <FilterRow
        servers={all}
        filters={filters}
        onChange={setFilters}
        gameInfo={gameInfo}
      />

      <Tabs
        className="mt-16"
        value={tab}
        onChange={setTab}
        tabs={buildTabs(all, historyAddresses)}
      />

      {refresh.error !== null ? (
        <Alert
          title="Could not reach the master servers"
          detail={refresh.error}
          action={
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={startRefresh}>
              Retry
            </Button>
          }
        />
      ) : null}

      {listError !== null ? (
        <Alert title="The server cache is unavailable" detail={listError} />
      ) : null}

      {connectError !== null ? (
        <Alert title="Could not start the client" detail={connectError} />
      ) : null}

      <div className="flex flex-1 min-h-0 gap-16 pt-12">
        <div className="relative flex flex-col flex-1 min-w-0">
          {/* The loader covers this region and nothing else, so the search
              box, the filters and the tabs stay usable during a scan. `inert`
              keeps the Tab key out of the rows it hides. */}
          <div
            className="flex flex-col flex-1 min-h-0"
            inert={view.frozen}
            aria-busy={view.frozen}
          >
            <SortHeader
              column={sortColumn}
              direction={sortDirection}
              onToggle={toggleSort}
            />
            <div className="flex-1 min-h-0 overflow-y-auto pt-4">
              {view.skeleton ? (
                <SkeletonRows count={10} />
              ) : visible.length === 0 ? (
                <EmptyState
                  className="mt-24"
                  icon={<ServerIcon size={24} />}
                  title={emptyTitle(tab, all.length)}
                  text={emptyText(tab, all.length, hiddenBotOnly)}
                  action={
                    tab === "all" && all.length === 0 ? (
                      <Button icon={<RefreshCw size={16} />} onClick={startRefresh}>
                        Refresh
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                visible.map((server) => (
                  <ServerRow
                    key={server.address}
                    server={server}
                    selected={server.address === selectedAddress}
                    onSelect={() => setSelectedAddress(server.address)}
                    onToggleFavorite={() =>
                      setFavorite.mutate({
                        address: server.address,
                        favorite: !server.favorite,
                      })
                    }
                  />
                ))
              )}
            </div>
          </div>

          {view.frozen ? (
            <ScanOverlay
              label={scanLabel(respondedSoFar(live, held), refresh.progress)}
            />
          ) : null}
        </div>

        {selected === undefined ? (
          <aside className="flex flex-col items-center justify-center gap-12 w-320 shrink-0 rounded-lg border border-dashed border-line text-center px-24">
            <span className="flex items-center justify-center size-48 rounded-full bg-surface text-fg-muted">
              <ServerIcon size={24} />
            </span>
            <p className="text-body-sm text-fg-muted">
              Select a server to see its players and connect.
            </p>
          </aside>
        ) : (
          <ServerDetails
            server={selected}
            players={status.data?.players}
            playersLoading={status.isFetching && status.data === undefined}
            playersError={
              status.error === null
                ? null
                : `No player list: ${errorMessage(status.error)}`
            }
            // --- slice: game switch ---
            // Live even without a client: pressing it is how the player finds
            // out they need one, and the toast that says so offers to make it.
            canConnect
            connecting={launchClient.isPending}
            onConnect={connect}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The loader over the held-still table.
 *
 * It sits inside the table column, so the search box, the filters, the tabs
 * and the details panel of the selected server stay where they were and stay
 * usable. Being a plain element, it also swallows every click and wheel tick
 * aimed at the rows underneath.
 */
function ScanOverlay({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-app/70 backdrop-blur-[1px]">
      <span
        role="status"
        className="inline-flex items-center gap-8 px-12 py-8 rounded-md border border-line bg-surface text-body-sm text-fg-secondary shadow-card"
      >
        <RefreshCw size={16} className="animate-spin text-fg-accent" />
        {label}
      </span>
    </div>
  );
}

/**
 * The rows as they were when the running scan started.
 *
 * The list is captured on the edge, not on every render: a scan that begins
 * with rows on screen keeps exactly those until it ends, whatever the batches
 * do to the query cache in between. Refs rather than state because nothing
 * here needs a render of its own — the flag that flips already causes one.
 */
function useHeldRows(
  live: ServerInfo[],
  scanning: boolean,
  game: Game,
): ServerInfo[] | null {
  const held = useRef<ServerInfo[] | null>(null);
  const wasScanning = useRef(false);
  // --- slice: game switch ---
  // A switch mid-scan is the case this guards: the old list would otherwise
  // stay frozen on screen under a loader counting the new game's answers.
  const heldGame = useRef(game);

  if (heldGame.current !== game) {
    heldGame.current = game;
    // Nothing held: the rows of the new game are the ones to draw, and they
    // are not moving — the scan still in flight belongs to the game the
    // player left, and its batches land in that game's list.
    held.current = null;
  } else if (scanning !== wasScanning.current) {
    wasScanning.current = scanning;
    held.current = rowsToHold(live, scanning);
  }

  return held.current;
}

/** The Mode, Mod, Players and Version dropdowns, plus **Reset filters**. */
function FilterRow({
  servers,
  filters,
  onChange,
  gameInfo,
}: {
  servers: ServerInfo[];
  filters: ServerFilters;
  onChange: (filters: ServerFilters) => void;
  // --- slice: game switch ---
  /** The active game, for its gametype table. `undefined` until it loads. */
  gameInfo: GameInfo | undefined;
}) {
  // --- slice: game switch ---
  // The game's own table first, then whatever numbers the rows carry that the
  // table does not know — a mod is free to invent one. Building the list from
  // the rows alone made the dropdown change shape with every refresh, and it
  // offered Siege on a Jedi Outcast screen as soon as one server published a
  // seven. The table is the game's `bg_public.h`, so the labels are the ones
  // that game uses for those numbers.
  const modes = useMemo<SelectOption[]>(() => {
    const labels = new Map<string, string>();
    (gameInfo?.gametypes ?? []).forEach((label, index) => {
      labels.set(String(index), label);
    });
    for (const server of servers) {
      const key = String(server.gametype);
      if (!labels.has(key)) labels.set(key, server.gametypeLabel);
    }
    return [
      { value: "any", label: "Any" },
      ...[...labels.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [servers, gameInfo]);

  const mods = useMemo<SelectOption[]>(
    () => [
      { value: "any", label: "Any" },
      ...distinctValues(servers, "modName").map((value) => ({
        value,
        label: value,
      })),
    ],
    [servers],
  );

  const versions = useMemo<SelectOption[]>(
    () => [
      { value: "any", label: "Any" },
      ...distinctValues(servers, "protocol").map((value) => ({
        value,
        label: value,
      })),
    ],
    [servers],
  );

  return (
    <div className="flex flex-wrap items-center gap-8 pt-4">
      <Select
        label="Mode"
        ariaLabel="Mode"
        value={filters.gametype}
        options={modes}
        onChange={(gametype) => onChange({ ...filters, gametype })}
      />
      <Select
        label="Mod"
        ariaLabel="Mod"
        value={filters.modName}
        options={mods}
        onChange={(modName) => onChange({ ...filters, modName })}
      />
      <Select
        label="Players"
        ariaLabel="Players"
        value={filters.players}
        options={[
          { value: "any", label: "Any" },
          { value: "not-empty", label: "Not empty" },
          { value: "not-full", label: "Not full" },
        ]}
        onChange={(value) =>
          onChange({ ...filters, players: value as ServerFilters["players"] })
        }
      />
      <Select
        label="Version"
        ariaLabel="Version"
        value={filters.protocol}
        options={versions}
        onChange={(protocol) => onChange({ ...filters, protocol })}
      />
      {/* The same shell as a Select, but the control inside is the switch.
          Nesting the Toggle in a clickable shell would nest two buttons. */}
      <div className="inline-flex items-center gap-8 h-36 pl-12 pr-8 rounded-md bg-input border border-line">
        <span className="text-label-xs text-fg-muted shrink-0">Bots</span>
        <span className="text-body-sm-medium text-fg shrink-0 whitespace-nowrap">
          Hide bot-only
        </span>
        <Toggle
          label="Hide servers where every player is a bot"
          checked={filters.hideBotOnly}
          onChange={(hideBotOnly) => onChange({ ...filters, hideBotOnly })}
        />
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={filtersAreDefault(filters)}
        onClick={() => onChange(DEFAULT_FILTERS)}
      >
        Reset filters
      </Button>
    </div>
  );
}

/** The clickable column titles over the table. */
function SortHeader({
  column,
  direction,
  onToggle,
}: {
  column: SortColumn;
  direction: SortDirection;
  onToggle: (column: SortColumn) => void;
}) {
  const cell = (id: SortColumn, label: string, align?: string) => (
    <button
      type="button"
      onClick={() => onToggle(id)}
      className={cn(
        "inline-flex items-center gap-4 text-label-xs cursor-pointer",
        "transition-colors duration-150 hover:text-fg-secondary",
        column === id ? "text-fg-accent" : "text-fg-muted",
        align,
      )}
    >
      {label}
      {column === id ? (
        direction === "asc" ? (
          <ChevronUp size={12} />
        ) : (
          <ChevronDown size={12} />
        )
      ) : null}
    </button>
  );

  return (
    <div
      style={{ gridTemplateColumns: ROW_COLUMNS }}
      className="grid items-center gap-12 h-28 px-12 border-b border-line"
    >
      <span />
      {cell("name", "SERVER")}
      <span />
      {cell("map", "MAP")}
      {cell("mode", "MODE")}
      {cell("players", "PLR")}
      {cell("ping", "PING")}
      {cell("mod", "MOD")}
    </div>
  );
}

/** The inline error bar of the design's Servers · Error screen. */
function Alert({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex items-center gap-12 mt-12 px-12 py-10 rounded-md border border-line-danger bg-danger-subtle"
    >
      <AlertTriangle size={16} className="text-fg-danger shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-body-sm-medium text-fg">{title}</p>
        <p className="text-body-sm text-fg-muted truncate">{detail}</p>
      </div>
      {action}
    </div>
  );
}

/** The tab strip with its counts. */
function buildTabs(
  servers: ServerInfo[],
  historyAddresses: string[],
): TabDefinition<ServerTab>[] {
  const known = new Set(servers.map((server) => server.address));
  return [
    { id: "all", label: "All", count: servers.length },
    {
      id: "trusted",
      label: "Trusted",
      count: servers.filter((server) => server.trusted).length,
    },
    {
      id: "favorites",
      label: "Favorites",
      count: servers.filter((server) => server.favorite).length,
    },
    {
      id: "history",
      label: "History",
      count: historyAddresses.filter((address) => known.has(address)).length,
    },
    {
      id: "lan",
      label: "LAN",
      disabled: true,
      title: "Broadcast discovery arrives with the launch slice",
    },
  ];
}

/**
 * The line under the title: what is shown, out of what, and how fresh.
 *
 * "Players" means people. The bots are named separately so the number nobody
 * can act on cannot be mistaken for the one they can.
 */
function describeCounts(state: {
  /** Name of the active game, which is whose list this is. */
  game: string;
  visible: number;
  total: number;
  players: number;
  bots: number;
  secondsAgo: number | null;
  scanning: boolean;
  progress: ServersDoneEvent | null;
}): string {
  const { game, visible, total, players, bots, secondsAgo, scanning, progress } =
    state;
  const head =
    total === 0
      ? `No ${game} servers yet`
      : visible === total
        ? `${total} ${game} servers`
        : `${visible} of ${total} ${game} servers`;
  const middle = total === 0 ? "" : ` · ${players} players online`;
  const botTail =
    total === 0 || bots === 0 ? "" : ` · ${bots} bots hidden from counts`;

  if (scanning) return `${head}${middle}${botTail} · asking the master servers`;

  const silent =
    progress === null || progress.responded === progress.total
      ? ""
      : ` · ${progress.total - progress.responded} did not answer`;
  const tail =
    secondsAgo === null ? "" : ` · refreshed ${formatAge(secondsAgo)} ago`;
  return `${head}${middle}${botTail}${tail}${silent}`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}

function emptyTitle(tab: ServerTab, total: number): string {
  if (tab === "lan") return "LAN discovery is not built yet";
  if (tab === "favorites") return "No favorites yet";
  if (tab === "history") return "No connections yet";
  if (tab === "trusted") return "No trusted servers in this list";
  return total === 0 ? "No servers yet" : "Nothing matches the filters";
}

function emptyText(
  tab: ServerTab,
  total: number,
  hiddenBotOnly: number,
): string {
  switch (tab) {
    case "lan":
      return "Broadcast discovery on the local network arrives in a later task.";
    case "favorites":
      return "Press the star on a row to keep a server here.";
    case "history":
      return "Servers you connect to show up here, newest first.";
    case "trusted":
      return "The bundled list of vouched-for community servers is empty in this build.";
    default:
      if (total === 0) {
        return "Press Refresh to ask the master servers who is online.";
      }
      // A player who filtered everything away deserves to know that the bot
      // switch is holding part of the list back.
      return hiddenBotOnly > 0
        ? `Widen the filters, or clear the search box. ${hiddenBotOnly} ${
            hiddenBotOnly === 1 ? "server has" : "servers have"
          } bots and nobody else; turn off Hide bot-only to see ${
            hiddenBotOnly === 1 ? "it" : "them"
          }.`
        : "Widen the filters, or clear the search box.";
  }
}

/** Seconds since `timestamp`, recomputed once a second. */
function useSecondsSince(timestamp: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (timestamp === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timestamp]);

  if (timestamp === null) return null;
  return Math.max(0, Math.floor((now - timestamp) / 1_000));
}

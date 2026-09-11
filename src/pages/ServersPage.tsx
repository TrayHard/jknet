import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Globe,
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
import { useTranslation } from "react-i18next";

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
  DEFAULT_STORED_FILTERS,
  distinctValues,
  filtersAreDefault,
  isBotOnly,
  sameStoredFilters,
  sortServers,
  storedFilters,
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
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
import { useGametypeLabels } from "../i18n/useGameLabels";
import { cn } from "../lib/format";
import type { Game, GameInfo, ServerInfo, ServersDoneEvent } from "../lib/ipc";
// --- slice: game switch ---
import { useActiveGame, useDefaultClient, useGameNames } from "../lib/game";
import {
  useAddServerHistory,
  useCachedServers,
  useGameInfo,
  useLanServers,
  useLaunchClient,
  useServerRefresh,
  useServerStatus,
  useSetServerFavorite,
  useSettings,
  useUpdateSettings,
} from "../lib/queries";

/**
 * Servers: the browser over the two Quake 3 master servers.
 *
 * The screen opens on the cached list and scans nothing until the player asks.
 * The engine's own browser behaves the same way — `UI_DoServerRefresh` returns
 * at once unless a menu command set `refreshActive` (`codemp/ui/ui_main.c:10457`,
 * OpenJK `1a6a6434`) — and two hundred UDP probes are not something to do
 * behind somebody's back every time a route mounts.
 *
 * --- slice: servers browser ---
 * Two buttons, as in the game: **Get new list** asks the master servers and
 * probes what they return, **Refresh** re-probes the addresses of the tab that
 * is open. Every tab scans under its own scope and keeps its own loader, so one
 * tab's scan never freezes another's list. Filters, tabs and sorting are pure
 * functions in `components/servers/filter.ts`; this file only holds the state.
 */
export function ServersPage() {
  const { t } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
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
  const [sortColumn, setSortColumn] = useState<SortColumn>("players");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // --- slice: servers browser ---
  // The dropdowns and the switches live in `settings.json`, so the screen
  // opens the way the player left it. The search box does not: a browser that
  // opens on yesterday's search word looks like one that lost half the list.
  const [search, setSearch] = useState("");
  const updateSettings = useUpdateSettings();
  const stored = settings.data?.serverFilters ?? DEFAULT_STORED_FILTERS;
  const filters = useMemo<ServerFilters>(
    () => ({ ...stored, search }),
    [stored, search],
  );
  // The settings as of this render, for the effect on the game switch: that
  // effect must not run again every time another writer touches the document.
  const storedNow = useRef(stored);
  storedNow.current = stored;
  /** Applies a change and saves everything but the search box. */
  const changeFilters = (next: ServerFilters) => {
    setSearch(next.search);
    const kept = storedFilters(next);
    if (!sameStoredFilters(kept, storedNow.current)) {
      updateSettings.mutate({ serverFilters: kept });
    }
  };

  // --- slice: servers browser ---
  // The rows of the open tab and the indicator that belongs to it. The LAN tab
  // draws from the sweep's own list; every other tab draws from the list the
  // master servers filled.
  const lan = useLanServers();
  const scope = refresh.scopes[tab];
  /** Whether a sweep has finished, which is what "nothing here" then means. */
  const lanScanned = refresh.scopes.lan.refreshedAt !== null;
  const source = useMemo(
    () => (tab === "lan" ? lan : (cached.data ?? [])),
    [tab, lan, cached.data],
  );
  // The rows the screen works from. While this tab's scan runs they are the
  // ones it started with, so counts, tabs, filter options and the table agree
  // with each other and none of them moves under the cursor.
  //
  // --- slice: game switch --- the hold is dropped when the game changes: rows
  // held from a Jedi Academy scan have no business under a Jedi Outcast list.
  // It is dropped on a tab change for the same reason.
  const held = useHeldRows(source, scope.running, `${activeGame}:${tab}`);
  const view = scanView(source, held, scope.running);
  const historyAddresses = useMemo(
    () => (settings.data?.serverHistory ?? []).map((entry) => entry.address),
    [settings.data],
  );
  const favoriteAddresses = useMemo(
    () => settings.data?.favoriteServers ?? [],
    [settings.data],
  );

  // --- slice: game switch ---
  // The selection and three of the filters are bound to the list they were
  // made on: a mod folder and a gametype number mean different things in the
  // two games — number 7 is Siege in Jedi Academy and CTF in Jedi Outcast — so
  // carrying them over would hide rows for a reason nothing on screen explains.
  // Players, bots and passwords mean the same in both and survive the switch,
  // as do the tabs.
  //
  // The game is read off the settings rather than from `useActiveGame`, which
  // answers Jedi Academy while the document loads: a switch that never happened
  // must not clear a row the player saved.
  const settledGame = settings.data?.activeGame;
  const previousGame = useRef<Game | undefined>(undefined);
  useEffect(() => {
    if (settledGame === undefined) return;
    const before = previousGame.current;
    previousGame.current = settledGame;
    if (before === undefined || before === settledGame) return;
    setSelectedAddress(null);
    const forEitherGame = {
      ...storedNow.current,
      gametype: "any",
      modName: "any",
      protocol: "any",
    };
    if (!sameStoredFilters(forEitherGame, storedNow.current)) {
      updateSettings.mutate({ serverFilters: forEitherGame });
    }
  }, [settledGame, updateSettings]);

  // --- slice: servers browser ---
  // The rows of the open tab before the filters: what the subtitle counts and
  // what the empty state reasons about.
  const inTab = useMemo(
    () => applyTab(view.rows, tab, historyAddresses),
    [view.rows, tab, historyAddresses],
  );
  const visible = useMemo(() => {
    const filtered = applyFilters(inTab, filters);
    // History keeps its own order: the point of the tab is when, not how busy.
    return tab === "history"
      ? filtered
      : sortServers(filtered, sortColumn, sortDirection);
  }, [inTab, tab, filters, sortColumn, sortDirection]);

  const selected = visible.find((row) => row.address === selectedAddress);
  const status = useServerStatus(selected?.address ?? null);

  // Both counts run over the whole tab, not the filtered list: the head of the
  // subtitle already says "X of N servers", so the rest describes the tab
  // rather than the current search box.
  const playersOnline = useMemo(() => totalRealPlayers(inTab), [inTab]);
  const botsOnline = useMemo(() => totalBots(inTab), [inTab]);
  /** Rows the bot switch takes off the table, for the empty state to name. */
  const hiddenBotOnly = useMemo(
    () => (filters.hideBotOnly ? inTab.filter(isBotOnly).length : 0),
    [inTab, filters.hideBotOnly],
  );
  const secondsAgo = useSecondsSince(scope.refreshedAt);

  // --- slice: servers browser ---
  /**
   * The addresses **Refresh** asks about on this tab.
   *
   * All re-probes the rows on screen; Favorites and History ask about the
   * addresses the player saved, whether or not a scan has ever seen them. The
   * LAN tab has no address list at all — a broadcast is how it finds out.
   */
  const tabAddresses = useMemo(() => {
    switch (tab) {
      case "favorites":
        return favoriteAddresses;
      case "history":
        return historyAddresses;
      case "lan":
        return [];
      default:
        return inTab.map((server) => server.address);
    }
  }, [tab, favoriteAddresses, historyAddresses, inTab]);

  /**
   * **Refresh**: asks this tab's servers again, and no master server.
   *
   * The engine draws the same line between its two buttons: `RefreshFilter`
   * only re-pings what is already on screen (`codemp/ui/ui_main.c:10500`).
   */
  const refreshTab = () => {
    if (tab === "lan") {
      refresh.refreshLan();
      return;
    }
    if (tabAddresses.length === 0) return;
    refresh.refreshAddresses(tab, tabAddresses);
  };
  /** Nothing to ask: an empty tab needs the other button, or a star first. */
  const nothingToRefresh = tab !== "lan" && tabAddresses.length === 0;

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
      { onError: (e) => setConnectError(errorText(e)) },
    );
  };

  const listError = cached.error !== null ? errorText(cached.error) : null;

  return (
    <div className="flex flex-col h-full p-24">
      <PageHeader
        title={t("title")}
        subtitle={describeCounts(t, {
          // --- slice: game switch --- the list is one game's, and the line
          // says which: two lists that look alike need naming apart.
          game: gameName(activeGame),
          visible: visible.length,
          total: inTab.length,
          players: playersOnline,
          bots: botsOnline,
          age: secondsAgo === null ? null : format.age(secondsAgo),
          scanning: scope.running,
          progress: scope.progress,
        })}
        actions={
          <>
            <Input
              icon={<Search size={16} />}
              placeholder={t("searchPlaceholder")}
              value={filters.search}
              onChange={(event) =>
                changeFilters({ ...filters, search: event.target.value })
              }
              className="w-260"
            />
            {/* --- slice: servers browser ---
                Two buttons, as in the game menu: this one re-asks the servers
                already on the tab, the next one goes to the master servers. */}
            <Button
              icon={
                <RefreshCw
                  size={16}
                  className={scope.running ? "animate-spin" : undefined}
                />
              }
              title={t("refreshHint")}
              disabled={scope.running || nothingToRefresh}
              onClick={refreshTab}
            >
              {scope.running ? t("scanning") : t("refresh")}
            </Button>
            {tab === "all" ? (
              <Button
                icon={<Globe size={16} />}
                title={t("getNewListHint")}
                disabled={scope.running}
                onClick={refresh.getNewList}
              >
                {t("getNewList")}
              </Button>
            ) : null}
          </>
        }
      />

      <FilterRow
        servers={inTab}
        filters={filters}
        onChange={changeFilters}
        gameInfo={gameInfo}
      />

      <Tabs
        className="mt-16"
        value={tab}
        onChange={setTab}
        // --- slice: servers browser ---
        // The strip counts the rows the screen is drawing, so a frozen table
        // and the number beside its tab cannot disagree.
        tabs={buildTabs(
          t,
          tab === "lan" ? (cached.data ?? []) : view.rows,
          tab === "lan" ? view.rows : lan,
          historyAddresses,
        )}
      />

      {scope.error !== null ? (
        <Alert
          title={tab === "all" ? t("alerts.masters") : t("alerts.refresh")}
          detail={scope.error}
          action={
            <Button
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={tab === "all" ? refresh.getNewList : refreshTab}
            >
              {tCommon("actions.retry")}
            </Button>
          }
        />
      ) : null}

      {listError !== null ? (
        <Alert title={t("alerts.cache")} detail={listError} />
      ) : null}

      {connectError !== null ? (
        <Alert title={t("alerts.connect")} detail={connectError} />
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
                  title={emptyTitle(t, tab, inTab.length, lanScanned)}
                  text={emptyText(t, tab, inTab.length, hiddenBotOnly, lanScanned)}
                  action={
                    // --- slice: servers browser ---
                    // An empty All tab is a launcher that has never asked the
                    // masters, so the button offered is the one that does.
                    tab === "all" && inTab.length === 0 ? (
                      <Button icon={<Globe size={16} />} onClick={refresh.getNewList}>
                        {t("getNewList")}
                      </Button>
                    ) : tab === "lan" && !lanScanned ? (
                      <Button icon={<RefreshCw size={16} />} onClick={refreshTab}>
                        {t("refresh")}
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
              label={(() => {
                const scan = scanLabel(respondedSoFar(source, held), scope.progress);
                return t(`scan.${scan.kind}`, {
                  count: scan.count,
                  total: scan.total,
                });
              })()}
            />
          ) : null}
        </div>

        {selected === undefined ? (
          <aside className="flex flex-col items-center justify-center gap-12 w-320 shrink-0 rounded-lg border border-dashed border-line text-center px-24">
            <span className="flex items-center justify-center size-48 rounded-full bg-surface text-fg-muted">
              <ServerIcon size={24} />
            </span>
            <p className="text-body-sm text-fg-muted">{t("empty.pickServer")}</p>
          </aside>
        ) : (
          <ServerDetails
            server={selected}
            players={status.data?.players}
            playersLoading={status.isFetching && status.data === undefined}
            playersError={
              status.error === null
                ? null
                : t("details.playersError", { message: errorText(status.error) })
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
  // --- slice: game switch --- the game, and — slice: servers browser — the
  // tab: a switch mid-scan is what this guards. The old list would otherwise
  // stay frozen on screen under a loader counting somebody else's answers.
  list: string,
): ServerInfo[] | null {
  const held = useRef<ServerInfo[] | null>(null);
  const wasScanning = useRef(false);
  const heldList = useRef(list);

  if (heldList.current !== list) {
    heldList.current = list;
    // Nothing held: the rows of the list now on screen are the ones to draw,
    // and they are not moving — a scan still in flight belongs to the list the
    // player left, and its batches land there.
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
  const { t } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");
  // --- slice: i18n --- the numbers come from the servers, the words from the
  // catalog of the game they belong to.
  const gametypes = useGametypeLabels();
  // --- slice: game switch ---
  // The game's own table first, then whatever numbers the rows carry that the
  // table does not know — a mod is free to invent one. Building the list from
  // the rows alone made the dropdown change shape with every refresh, and it
  // offered Siege on a Jedi Outcast screen as soon as one server published a
  // seven. The table is the game's `bg_public.h`, so the labels are the ones
  // that game uses for those numbers.
  const modes = useMemo<SelectOption[]>(() => {
    const game = gameInfo?.id;
    const labels = new Map<string, string>();
    (gameInfo?.gametypes ?? []).forEach((label, index) => {
      labels.set(
        String(index),
        game === undefined ? label : gametypes.label(game, index, label),
      );
    });
    for (const server of servers) {
      const key = String(server.gametype);
      if (!labels.has(key)) {
        labels.set(
          key,
          gametypes.label(server.game, server.gametype, server.gametypeLabel),
        );
      }
    }
    return [
      { value: "any", label: tCommon("select.any") },
      ...[...labels.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [servers, gameInfo, gametypes, tCommon]);

  const mods = useMemo<SelectOption[]>(
    () => [
      { value: "any", label: tCommon("select.any") },
      // A mod folder is what the operator typed into `fs_game`: data, and
      // never translated.
      ...distinctValues(servers, "modName").map((value) => ({
        value,
        label: value,
      })),
    ],
    [servers, tCommon],
  );

  const versions = useMemo<SelectOption[]>(
    () => [
      { value: "any", label: tCommon("select.any") },
      ...distinctValues(servers, "protocol").map((value) => ({
        value,
        label: value,
      })),
    ],
    [servers, tCommon],
  );

  return (
    <div className="flex flex-wrap items-center gap-8 pt-4">
      <Select
        label={t("filters.mode")}
        ariaLabel={t("filters.mode")}
        value={filters.gametype}
        options={modes}
        onChange={(gametype) => onChange({ ...filters, gametype })}
      />
      <Select
        label={t("filters.mod")}
        ariaLabel={t("filters.mod")}
        value={filters.modName}
        options={mods}
        onChange={(modName) => onChange({ ...filters, modName })}
      />
      <Select
        label={t("filters.players")}
        ariaLabel={t("filters.players")}
        value={filters.players}
        options={[
          { value: "any", label: t("filters.playersAny") },
          { value: "not-empty", label: t("filters.playersNotEmpty") },
          { value: "not-full", label: t("filters.playersNotFull") },
        ]}
        onChange={(value) =>
          onChange({ ...filters, players: value as ServerFilters["players"] })
        }
      />
      <Select
        label={t("filters.version")}
        ariaLabel={t("filters.version")}
        value={filters.protocol}
        options={versions}
        onChange={(protocol) => onChange({ ...filters, protocol })}
      />
      {/* The same shell as a Select, but the control inside is the switch.
          Nesting the Toggle in a clickable shell would nest two buttons. */}
      <div className="inline-flex items-center gap-8 h-36 pl-12 pr-8 rounded-md bg-input border border-line">
        <span className="text-label-xs text-fg-muted shrink-0">
          {t("filters.bots")}
        </span>
        <span className="text-body-sm-medium text-fg shrink-0 whitespace-nowrap">
          {t("filters.hideBotOnly")}
        </span>
        <Toggle
          label={t("filters.hideBotOnlyHint")}
          checked={filters.hideBotOnly}
          onChange={(hideBotOnly) => onChange({ ...filters, hideBotOnly })}
        />
      </div>
      {/* --- slice: servers browser ---
          The lock in the row says a server has a door; this says whether the
          player wants those rows on the list at all. */}
      <div className="inline-flex items-center gap-8 h-36 pl-12 pr-8 rounded-md bg-input border border-line">
        <span className="text-label-xs text-fg-muted shrink-0">
          {t("filters.password")}
        </span>
        <span className="text-body-sm-medium text-fg shrink-0 whitespace-nowrap">
          {t("filters.hidePassworded")}
        </span>
        <Toggle
          label={t("filters.hidePasswordedHint")}
          checked={filters.hidePassworded}
          onChange={(hidePassworded) => onChange({ ...filters, hidePassworded })}
        />
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={filtersAreDefault(filters)}
        onClick={() => onChange(DEFAULT_FILTERS)}
      >
        {t("filters.reset")}
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
  const { t } = useTranslation("servers");
  const cell = (id: SortColumn, label: string, align?: string) => (
    <button
      type="button"
      onClick={() => onToggle(id)}
      // --- slice: i18n --- the columns are 56 to 116 px wide and the design
      // sets those widths, so a heading that grows with the language has to
      // give way rather than push the row out of the table. The tooltip is
      // what keeps a cut heading readable.
      title={label}
      className={cn(
        "inline-flex items-center gap-4 min-w-0 text-label-xs cursor-pointer",
        "transition-colors duration-150 hover:text-fg-secondary",
        column === id ? "text-fg-accent" : "text-fg-muted",
        align,
      )}
    >
      <span className="truncate">{label}</span>
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
      {cell("name", t("columns.server"))}
      <span />
      {cell("map", t("columns.map"))}
      {cell("mode", t("columns.mode"))}
      {cell("players", t("columns.players"))}
      {cell("ping", t("columns.ping"))}
      {cell("mod", t("columns.mod"))}
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

/**
 * The tab strip with its counts.
 *
 * --- slice: servers browser ---
 * `lanRows` is a list of its own: those rows come from a broadcast sweep and
 * never enter the one the master servers filled.
 */
function buildTabs(
  t: ServersT,
  servers: ServerInfo[],
  lanRows: ServerInfo[],
  historyAddresses: string[],
): TabDefinition<ServerTab>[] {
  const known = new Set(servers.map((server) => server.address));
  return [
    { id: "all", label: t("tabs.all"), count: servers.length },
    {
      id: "favorites",
      label: t("tabs.favorites"),
      count: servers.filter((server) => server.favorite).length,
    },
    {
      id: "history",
      label: t("tabs.history"),
      count: historyAddresses.filter((address) => known.has(address)).length,
    },
    {
      id: "lan",
      label: t("tabs.lan"),
      count: lanRows.length,
      title: t("tabs.lanHint"),
    },
  ];
}

// --- slice: i18n ---
/** The `t` of the `servers` namespace, as the builders below take it. */
type ServersT = ReturnType<typeof useTranslation<"servers">>["t"];

/** Punctuation between the parts of the subtitle, not a word. */
const DOT = " · ";

/**
 * The line under the title: what is shown, out of what, and how fresh.
 *
 * "Players" means people. The bots are named separately so the number nobody
 * can act on cannot be mistaken for the one they can.
 *
 * --- slice: i18n ---
 * Each part is a whole message with its own placeholders and its own plural,
 * and the middot between them is punctuation. Nothing here glues half-sentences
 * together: «2 of 118 Jedi Academy servers» is one message, not «2», «of» and
 * «servers».
 */
function describeCounts(
  t: ServersT,
  state: {
    /** Name of the active game, which is whose list this is. */
    game: string;
    visible: number;
    total: number;
    players: number;
    bots: number;
    /** How long ago the list was refreshed, already formatted, or `null`. */
    age: string | null;
    scanning: boolean;
    progress: ServersDoneEvent | null;
  },
): string {
  const { game, visible, total, players, bots, age, scanning, progress } = state;

  const parts: string[] = [
    total === 0
      ? t("subtitle.empty", { game })
      : visible === total
        ? t("subtitle.all", { count: total, game })
        : t("subtitle.some", { count: visible, total, game }),
  ];

  if (total > 0) parts.push(t("subtitle.players", { count: players }));
  if (total > 0 && bots > 0) parts.push(t("subtitle.bots", { count: bots }));

  if (scanning) {
    parts.push(t("subtitle.scanning"));
    return parts.join(DOT);
  }

  if (age !== null) parts.push(t("subtitle.refreshed", { age }));
  if (progress !== null && progress.responded !== progress.total) {
    parts.push(t("subtitle.silent", { count: progress.total - progress.responded }));
  }
  return parts.join(DOT);
}

function emptyTitle(
  t: ServersT,
  tab: ServerTab,
  total: number,
  // --- slice: servers browser --- a LAN tab nobody has swept yet and one that
  // swept and found nothing are two different sentences.
  lanScanned: boolean,
): string {
  if (tab === "lan") return lanScanned ? t("empty.lanNoneTitle") : t("empty.lanTitle");
  if (tab === "favorites") return t("empty.favoritesTitle");
  if (tab === "history") return t("empty.historyTitle");
  return total === 0 ? t("empty.noneTitle") : t("empty.filteredTitle");
}

function emptyText(
  t: ServersT,
  tab: ServerTab,
  total: number,
  hiddenBotOnly: number,
  lanScanned: boolean,
): string {
  switch (tab) {
    case "lan":
      return lanScanned ? t("empty.lanNoneText") : t("empty.lanText");
    case "favorites":
      return t("empty.favoritesText");
    case "history":
      return t("empty.historyText");
    default:
      if (total === 0) return t("empty.noneText");
      // A player who filtered everything away deserves to know that the bot
      // switch is holding part of the list back.
      return hiddenBotOnly > 0
        ? t("empty.filteredBots", { count: hiddenBotOnly })
        : t("empty.filteredText");
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

import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
  Server as ServerIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";

import { PageHeader } from "../components/PageHeader";
import { ServerDetails } from "../components/servers/ServerDetails";
import { ROW_COLUMNS, ServerRow } from "../components/servers/ServerRow";
import { SkeletonRows } from "../components/servers/SkeletonRow";
import { Select, type SelectOption } from "../components/servers/Select";
import { Tabs, type TabDefinition } from "../components/servers/Tabs";
import {
  applyFilters,
  applyTab,
  DEFAULT_DIRECTION,
  distinctValues,
  filtersAreEmpty,
  NO_FILTERS,
  sortServers,
  type ServerFilters,
  type ServerTab,
  type SortColumn,
  type SortDirection,
} from "../components/servers/filter";
import { Button, EmptyState, Input } from "../components/ui";
import { cn } from "../lib/format";
import { errorMessage, launchClient, type ServerInfo } from "../lib/ipc";
import {
  useAddServerHistory,
  useCachedServers,
  useClients,
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
let lastAutoRefresh = 0;

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
  const clients = useClients();
  const cached = useCachedServers();
  const refresh = useServerRefresh();
  const setFavorite = useSetServerFavorite();
  const addHistory = useAddServerHistory();

  const [tab, setTab] = useState<ServerTab>("all");
  const [filters, setFilters] = useState<ServerFilters>(NO_FILTERS);
  const [sortColumn, setSortColumn] = useState<SortColumn>("players");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const startRefresh = refresh.refresh;
  const attempted = useRef(false);
  useEffect(() => {
    if (attempted.current || !isTauri()) return;
    attempted.current = true;
    if (Date.now() - lastAutoRefresh < AUTO_REFRESH_AFTER_MS) return;
    lastAutoRefresh = Date.now();
    startRefresh();
  }, [startRefresh]);

  const all = useMemo(() => cached.data ?? [], [cached.data]);
  const historyAddresses = useMemo(
    () => (settings.data?.serverHistory ?? []).map((entry) => entry.address),
    [settings.data],
  );

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

  const playersOnline = useMemo(
    () => all.reduce((sum, row) => sum + (row.humans ?? row.clients), 0),
    [all],
  );
  const secondsAgo = useSecondsSince(refresh.refreshedAt);

  const defaultClient = clients.data?.find(
    (client) => client.id === settings.data?.defaultClientId,
  );

  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection(DEFAULT_DIRECTION[column]);
  };

  const connect = () => {
    if (selected === undefined || defaultClient === undefined) return;
    setConnectError(null);
    addHistory.mutate(selected.address);
    launchClient({ clientId: defaultClient.id, connect: selected.address }).catch(
      (e: unknown) => setConnectError(errorMessage(e)),
    );
  };

  const listError = cached.error !== null ? errorMessage(cached.error) : null;
  const firstScan = refresh.running && all.length === 0;

  return (
    <div className="flex flex-col h-full p-24">
      <PageHeader
        title="Servers"
        subtitle={describeCounts(visible.length, all.length, playersOnline, secondsAgo)}
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

      <FilterRow servers={all} filters={filters} onChange={setFilters} />

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
        <div className="flex flex-col flex-1 min-w-0">
          <SortHeader
            column={sortColumn}
            direction={sortDirection}
            onToggle={toggleSort}
          />
          <div className="flex-1 min-h-0 overflow-y-auto pt-4">
            {firstScan ? (
              <SkeletonRows count={10} />
            ) : visible.length === 0 ? (
              <EmptyState
                className="mt-24"
                icon={<ServerIcon size={24} />}
                title={emptyTitle(tab, all.length)}
                text={emptyText(tab, all.length)}
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
              status.error !== null ? "This server did not answer." : null
            }
            canConnect={defaultClient !== undefined}
            onConnect={connect}
            hint={
              <p className="text-body-sm text-fg-muted text-center">
                Pick a default client on the{" "}
                <Link to="/clients" className="text-fg-accent underline">
                  Clients
                </Link>{" "}
                screen first.
              </p>
            }
          />
        )}
      </div>
    </div>
  );
}

/** The Mode, Mod, Players and Version dropdowns, plus **Reset filters**. */
function FilterRow({
  servers,
  filters,
  onChange,
}: {
  servers: ServerInfo[];
  filters: ServerFilters;
  onChange: (filters: ServerFilters) => void;
}) {
  const modes = useMemo<SelectOption[]>(() => {
    const labels = new Map<string, string>();
    for (const server of servers) {
      labels.set(String(server.gametype), server.gametypeLabel);
    }
    return [
      { value: "any", label: "Any" },
      ...[...labels.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [servers]);

  const mods = useMemo<SelectOption[]>(
    () => [
      { value: "any", label: "Any" },
      ...distinctValues(servers, "game").map((value) => ({
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
        value={filters.gametype}
        options={modes}
        onChange={(gametype) => onChange({ ...filters, gametype })}
      />
      <Select
        label="Mod"
        value={filters.game}
        options={mods}
        onChange={(game) => onChange({ ...filters, game })}
      />
      <Select
        label="Players"
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
        value={filters.protocol}
        options={versions}
        onChange={(protocol) => onChange({ ...filters, protocol })}
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={filtersAreEmpty(filters)}
        onClick={() => onChange(NO_FILTERS)}
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

/** The line under the title: what is shown, out of what, and how fresh. */
function describeCounts(
  visible: number,
  total: number,
  players: number,
  secondsAgo: number | null,
): string {
  const head =
    total === 0
      ? "No servers yet"
      : visible === total
        ? `${total} servers`
        : `${visible} of ${total} servers`;
  const middle = total === 0 ? "" : ` · ${players} players online`;
  const tail =
    secondsAgo === null ? "" : ` · refreshed ${formatAge(secondsAgo)} ago`;
  return `${head}${middle}${tail}`;
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

function emptyText(tab: ServerTab, total: number): string {
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
      return total === 0
        ? "Press Refresh to ask the master servers who is online."
        : "Widen the filters, or clear the search box.";
  }
}

/** Seconds since `timestamp`, recomputed once a second. */
function useSecondsSince(timestamp: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (timestamp === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timestamp]);

  const seconds = useCallback(
    () => (timestamp === null ? null : Math.max(0, Math.floor((now - timestamp) / 1_000))),
    [now, timestamp],
  );
  return seconds();
}

import { AlertTriangle, Lock, Search, Server, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import {
  applyFilters,
  botCount,
  DEFAULT_DIRECTION,
  distinctValues,
  isBotOnly,
  realPlayers,
  sortServers,
  type PlayersFilter,
  type ServerFilters,
  type SortColumn,
} from "../../../../src/components/servers/filter.ts";
import { ServerName } from "../../../../src/components/servers/ServerName.tsx";
import { Avatar, Button, EmptyState, Input, Select, Toggle } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useGametypeLabels } from "../../../../src/i18n/useGameLabels.ts";
import { cn } from "../../../../src/lib/format.ts";
import { useGameNames } from "../../../../src/lib/game.ts";
import type { Friend, ServerInfo } from "../../../../src/lib/ipc.ts";
import { setCatalogCount } from "../catalog/counts.ts";
import { GameSwitch } from "../catalog/GameSwitch.tsx";
import { catalogUnavailable, friendsOn, serverPath, useFriendsOnServers, useServerList } from "../catalog/serverList.ts";
import { useCatalogGame, useQueryValue, useQueryWriter } from "../catalog/useCatalogGame.ts";

/** The orders of the list: no ping, which from the service would mean nothing. */
type ListSort = Exclude<SortColumn, "ping">;
const SORTS: readonly ListSort[] = ["players", "name", "map", "mode", "mod"];

/** How long the address waits after a keystroke before it takes the search. */
const DEBOUNCE_MS = 300;

/** Friends drawn on a row before the rest become a count. */
const FRIENDS_ON_ROW = 3;

/**
 * The value of `?players=` as the launcher's filter. `1` is short for
 * "somebody is playing", the way a shared link spells it.
 */
function playersFilter(value: string): PlayersFilter {
  if (value === "1" || value === "not-empty") return "not-empty";
  if (value === "not-full") return "not-full";
  return "any";
}

/**
 * The server list of JKNet Online: every server the master servers name,
 * checked by the service, read only. The game, the search, the filters and
 * the order live in the address (`/servers?game=jo&q=duel&players=1`), so a
 * filtered view can be shared as a link. A row opens the server's page
 * beside the list or, on a phone, in its place.
 *
 * The filters are the launcher's (`components/servers/filter.ts`) with its
 * defaults: bot-only servers hidden, passworded ones shown. The rows name
 * the friends playing there. Joining is JKNet's on the PC.
 */
export function ServerListScreen({ selectedAddress }: { selectedAddress?: string }) {
  const { t } = useTranslation("servers");
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const location = useLocation();
  const gameNames = useGameNames();
  const labels = useGametypeLabels();
  const { game, setGame } = useCatalogGame();
  const [q, setQ] = useQueryValue("q");
  const [playersValue, setPlayers] = useQueryValue("players");
  const [mode, setMode] = useQueryValue("mode");
  const [mod, setMod] = useQueryValue("mod");
  const [bots, setBots] = useQueryValue("bots");
  const [password, setPassword] = useQueryValue("password");
  const [sortValue, setSort] = useQueryValue("sort");
  const write = useQueryWriter();
  const sort: ListSort = (SORTS as readonly string[]).includes(sortValue) ? (sortValue as ListSort) : "players";
  const searchInput = useRef<HTMLInputElement>(null);

  // The rows follow every keystroke; the address takes the search a moment
  // after the typing stops, and the box follows the address when it changes
  // under it — the browser's back, a pasted link.
  const [typed, setTyped] = useState(q);
  const written = useRef(q);
  useEffect(() => {
    if (q === written.current) return;
    written.current = q;
    setTyped(q);
  }, [q]);
  useEffect(() => {
    const next = typed.trim();
    if (next === q) return;
    const timer = setTimeout(() => {
      written.current = next;
      setQ(next);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed, q, setQ]);

  const list = useServerList(game);
  const friendsByServer = useFriendsOnServers();
  const rows = useMemo(() => list.data?.servers ?? [], [list.data]);

  const filters: ServerFilters = {
    search: typed,
    gametype: mode === "" ? "any" : mode,
    modName: mod === "" ? "any" : mod,
    players: playersFilter(playersValue),
    protocol: "any",
    hideBotOnly: bots !== "show",
    hidePassworded: password === "hide",
  };
  const shown = sortServers(applyFilters(rows, filters), sort, DEFAULT_DIRECTION[sort]);
  const players = shown.reduce((sum, server) => sum + realPlayers(server), 0);
  // Of the rows every other filter lets through, those with only bots on
  // them: what an empty list says the switch is hiding.
  const botOnlyHidden =
    filters.hideBotOnly && shown.length === 0 ? applyFilters(rows, { ...filters, hideBotOnly: false }).filter(isBotOnly).length : 0;
  const activeFilters =
    (filters.gametype !== "any" ? 1 : 0) +
    (filters.modName !== "any" ? 1 : 0) +
    (filters.players !== "any" ? 1 : 0) +
    (filters.hideBotOnly ? 0 : 1) +
    (filters.hidePassworded ? 1 : 0);
  const [filtersOpen, setFiltersOpen] = useState(activeFilters > 0);

  // The menu's muted count: the servers of this game somebody plays on.
  useEffect(() => {
    if (list.data !== undefined && !list.data.stale) {
      setCatalogCount(`servers:${game}`, list.data.servers.filter((server) => realPlayers(server) > 0).length);
    }
  }, [game, list.data]);

  const modeOptions = distinctValues(rows, "gametype").map((value) => ({
    value,
    label: labels.label(game, Number(value), rows.find((row) => String(row.gametype) === value)?.gametypeLabel),
  }));
  const modOptions = distinctValues(rows, "modName").map((value) => ({ value, label: value }));
  const any = { value: "", label: t("filters.playersAny") };

  const resetFilters = () => write({ mode: "", mod: "", players: "", bots: "", password: "" });

  const updating = list.data?.stale === true;
  const unavailable = list.error !== null && catalogUnavailable(list.error);

  return (
    <div className="flex flex-col pb-16" data-testid="server-list">
      <div className="flex flex-col gap-8 px-16 pt-4 pb-12">
        <Input
          ref={searchInput}
          icon={<Search size={16} />}
          aria-label={t("searchPlaceholder")}
          placeholder={t("searchPlaceholder")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          trailing={
            typed ? (
              <button
                type="button"
                aria-label={tWeb("serverList.clearSearch")}
                title={tWeb("serverList.clearSearch")}
                onClick={() => {
                  setTyped("");
                  searchInput.current?.focus();
                }}
                className="inline-flex size-20 items-center justify-center rounded-sm text-fg-muted hover:text-fg cursor-pointer select-none"
              >
                <X size={14} aria-hidden />
              </button>
            ) : undefined
          }
        />
        {/* A mode and a mod are values of one game's list. */}
        <GameSwitch game={game} onChange={(next) => setGame(next, { mode: "", mod: "" })} />
        <p className="text-body-sm text-fg-secondary">{tWeb("serverList.lead")}</p>
        <div className="flex items-center gap-8">
          <Button
            size="sm"
            variant={activeFilters > 0 ? "secondary" : "ghost"}
            icon={<SlidersHorizontal size={14} />}
            aria-expanded={filtersOpen}
            aria-controls="server-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {activeFilters > 0 ? tWeb("serverList.filtersActive", { count: activeFilters }) : tWeb("serverList.filters")}
          </Button>
          <Select
            ariaLabel={tWeb("serverList.sort")}
            options={SORTS.map((id) => ({ value: id, label: tWeb(`serverList.sortBy.${id}`) }))}
            value={sort}
            onChange={(value) => setSort(value === "players" ? "" : value)}
            className="ml-auto w-144 shrink-0"
          />
        </div>
        {filtersOpen ? (
          <div id="server-filters" className="flex flex-col gap-8 rounded-md border border-line-subtle bg-surface p-10">
            <Select
              ariaLabel={t("filters.players")}
              label={t("filters.players")}
              options={[
                { value: "any", label: t("filters.playersAny") },
                { value: "not-empty", label: t("filters.playersNotEmpty") },
                { value: "not-full", label: t("filters.playersNotFull") },
              ]}
              value={filters.players}
              onChange={(value) => setPlayers(value === "any" ? "" : value)}
            />
            <Select
              ariaLabel={t("filters.mode")}
              label={t("filters.mode")}
              options={[any, ...modeOptions]}
              value={mode}
              onChange={setMode}
            />
            <Select ariaLabel={t("filters.mod")} label={t("filters.mod")} options={[any, ...modOptions]} value={mod} onChange={setMod} />
            <label className="flex items-center gap-10 text-body-sm text-fg" title={t("filters.hideBotOnlyHint")}>
              <span className="min-w-0 flex-1">{t("filters.hideBotOnly")}</span>
              <Toggle
                label={t("filters.hideBotOnly")}
                checked={filters.hideBotOnly}
                onChange={(on) => setBots(on ? "" : "show")}
              />
            </label>
            <label className="flex items-center gap-10 text-body-sm text-fg" title={t("filters.hidePasswordedHint")}>
              <span className="min-w-0 flex-1">{t("filters.hidePassworded")}</span>
              <Toggle
                label={t("filters.hidePassworded")}
                checked={filters.hidePassworded}
                onChange={(on) => setPassword(on ? "hide" : "")}
              />
            </label>
            <Button size="sm" variant="ghost" disabled={activeFilters === 0} onClick={resetFilters} className="self-start">
              {t("filters.reset")}
            </Button>
          </div>
        ) : null}
        {list.data !== undefined && !unavailable ? (
          <p className="flex flex-wrap items-center gap-x-8 text-body-sm text-fg-muted" role="status">
            <span>
              {t("subtitle.servers", { count: shown.length, game: gameNames.label(game) })}
              {" · "}
              {t("subtitle.players", { count: players })}
            </span>
            {updating ? <span className="text-fg-accent">{tWeb("serverList.updating")}</span> : null}
          </p>
        ) : null}
      </div>

      {list.isLoading ? (
        <p role="status" className="px-16 py-12 text-body-sm text-fg-muted">
          {tWeb("serverList.loading")}
        </p>
      ) : unavailable ? (
        <EmptyState
          className="mx-16"
          icon={<Server size={24} />}
          title={tWeb("serverList.unavailable")}
          text={tWeb("serverList.unavailableText")}
          action={
            <Button disabled={list.isFetching} onClick={() => void list.refetch()}>
              {tCommon("actions.tryAgain")}
            </Button>
          }
        />
      ) : list.error !== null && list.data === undefined ? (
        <EmptyState
          className="mx-16"
          icon={<AlertTriangle size={24} />}
          title={tWeb("serverList.errorTitle")}
          text={errorText(list.error)}
          action={
            <Button disabled={list.isFetching} onClick={() => void list.refetch()}>
              {tCommon("actions.tryAgain")}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className="mx-16"
          icon={<Server size={24} />}
          title={updating ? tWeb("serverList.updating") : t("empty.noneTitle")}
          text={tWeb("serverList.emptyText")}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          className="mx-16"
          icon={<Search size={24} />}
          title={t("empty.filteredTitle")}
          text={botOnlyHidden > 0 ? t("empty.filteredBots", { count: botOnlyHidden }) : t("empty.filteredText")}
        />
      ) : (
        <ul className="flex flex-col" aria-label={tWeb("serverList.title")}>
          {shown.map((server) => (
            <ServerRow
              key={server.address}
              server={server}
              mode={labels.label(server.game, server.gametype, server.gametypeLabel)}
              friends={friendsOn(friendsByServer, server.address)}
              selected={server.address === selectedAddress}
              onOpen={() => void navigate(`${serverPath(server.game, server.address)}${location.search}`)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One server: its name in the game's colours, a lock when it asks for a
 * password, the people playing out of its slots with the bots apart, the
 * map, the mode and the mod, and the friends there.
 */
function ServerRow({
  server,
  mode,
  friends,
  selected,
  onOpen,
}: {
  server: ServerInfo;
  mode: string;
  friends: Friend[];
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation("servers");
  const { t: tWeb } = useTranslation("web");
  const bots = botCount(server);
  const facts = [server.map, mode];
  if (server.modName !== "" && server.modName.toLowerCase() !== "base") facts.push(server.modName);
  const counts =
    server.humans === null
      ? t("row.countsUnknownTitle", { clients: server.clients })
      : t("row.countsTitle", { humans: server.humans, bots, slots: server.maxClients });

  return (
    <li>
      <button
        type="button"
        data-testid="server-row"
        data-address={server.address}
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          "flex w-full min-w-0 flex-col gap-2 border-t border-line-subtle px-16 py-10 text-left cursor-pointer",
          "transition-colors duration-100",
          selected ? "bg-selected-overlay" : "hover:bg-hover-overlay",
        )}
      >
        <span className="flex min-w-0 items-center gap-6">
          <ServerName raw={server.hostnameRaw} clean={server.hostnameClean} className="min-w-0 text-body-md-medium text-fg" />
          {server.needpass ? (
            <Lock size={14} role="img" aria-label={t("row.passwordRequired")} className="shrink-0 text-fg-muted" />
          ) : null}
          <span className="ml-auto shrink-0 pl-8 text-mono-sm text-fg-secondary" title={counts} data-testid="server-players">
            {server.humans === null ? `${server.clients}?` : realPlayers(server)}/{server.maxClients}
            {bots > 0 ? <span className="text-fg-muted"> {t("details.bots", { count: bots })}</span> : null}
            <span className="sr-only"> {counts}</span>
          </span>
        </span>
        <span className="truncate text-body-sm text-fg-muted">{facts.filter((fact) => fact !== "").join(" · ")}</span>
        {friends.length > 0 ? (
          <span
            className="flex min-w-0 items-center gap-6 text-body-sm text-fg-accent"
            data-testid="server-friends"
            title={friends.map((friend) => friend.user.displayName).join(", ")}
          >
            <span className="flex shrink-0 -space-x-6" aria-hidden="true">
              {friends.slice(0, FRIENDS_ON_ROW).map((friend) => (
                <Avatar key={friend.user.id} name={friend.user.displayName} src={friend.user.avatarUrl} size="sm" />
              ))}
            </span>
            <span className="min-w-0 truncate">
              {friends.length === 1
                ? tWeb("serverList.friendHere", { name: friends[0].user.displayName })
                : tWeb("serverList.friendsHereCount", { count: friends.length })}
            </span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

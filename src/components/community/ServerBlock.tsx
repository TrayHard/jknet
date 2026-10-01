import { ChevronDown, Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { pingLevel } from "../servers/Ping";
import { ServerName } from "../servers/ServerName";
import { Badge } from "../ui";
import { CopyButton, LiveDot, type LiveState } from "./bits";
import { serverName } from "./format";
import { useCommunityPlatform } from "./platform";
import type { CommunityLivePlayer, CommunityLiveStatus, CommunityServer } from "./types";

/** How often a page asks its servers again while it is open. */
const LIVE_EVERY_MS = 60_000;

/** What is known of a server now: the answer, a silence, a question on its way, or nothing. */
export interface LiveView {
  state: LiveState;
  status: CommunityLiveStatus | null;
  asking: boolean;
}

/**
 * The live state of every server of a page.
 *
 * The service's own answer (`status`, from S6) wins; without it the host may
 * ask the servers itself — the launcher does, over UDP — and a host that can
 * do neither leaves the state unknown. The launcher asks again every minute
 * while the page is open.
 */
export function useLiveStatuses(servers: CommunityServer[]): Record<string, LiveView> {
  const platform = useCommunityPlatform();
  const ask = platform.serverStatus;
  const [views, setViews] = useState<Record<string, LiveView>>({});
  const key = servers.map((server) => `${server.game}/${server.address}`).join(",");

  useEffect(() => {
    if (!ask) return;
    let alive = true;
    const targets = servers.filter((server) => !server.status);
    const round = () => {
      for (const server of targets) {
        setViews((current) => ({
          ...current,
          [server.id]: { state: current[server.id]?.state ?? "unknown", status: current[server.id]?.status ?? null, asking: true },
        }));
        ask(server.address, server.game).then(
          (status) => {
            if (alive) setViews((current) => ({ ...current, [server.id]: { state: "live", status, asking: false } }));
          },
          () => {
            if (alive) setViews((current) => ({ ...current, [server.id]: { state: "off", status: null, asking: false } }));
          },
        );
      }
    };
    round();
    const timer = setInterval(round, LIVE_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // `servers` is read through `key`: the same addresses are the same question.
  }, [ask, key]);

  const result: Record<string, LiveView> = {};
  for (const server of servers) {
    if (server.status) result[server.id] = { state: "live", status: server.status, asking: false };
    else result[server.id] = views[server.id] ?? { state: "unknown", status: null, asking: ask !== undefined };
  }
  return result;
}

/** People on the servers now, when every answer that counts is in. */
export function onlineCount(live: Record<string, LiveView>): number | null {
  const answered = Object.values(live).filter((view) => view.status !== null);
  if (answered.length === 0) return null;
  return answered.reduce((sum, view) => sum + (view.status?.players ?? 0), 0);
}

interface ServerBlockProps {
  server: CommunityServer;
  live: LiveView;
  /** Picked as the server the **Play** buttons join; `undefined` when blocks are not picked. */
  selected?: boolean;
  onSelect?: () => void;
  /** The player list is open. */
  expanded: boolean;
  /** Whether the list folds: a community of one server keeps it open. */
  collapsible: boolean;
  onToggle: () => void;
  /** The server is not verified yet, which only organizers are shown. */
  unverified: boolean;
}

/**
 * One game server of a community: the live dot, what the page calls it,
 * the people on it against its slots, the address to copy, the map, and the
 * list of players with their score and ping.
 */
export function ServerBlock({ server, live, selected, onSelect, expanded, collapsible, onToggle, unverified }: ServerBlockProps) {
  const { t } = useTranslation("community");
  const listId = useId();
  const status = live.status;
  const names = status?.names;
  const liveLabel = live.state === "live" ? t("play.live") : live.state === "off" ? t("play.offline") : undefined;
  // A server without a label is called by what it says of itself, or by its
  // address, which the line under it then does not repeat.
  const hostname = server.label.trim() === "" && status?.hostnameClean ? status : null;
  const namedByAddress = server.label.trim() === "" && hostname === null;

  const firstLine = (
    <>
      <LiveDot state={live.state} label={liveLabel} />
      <span className={cn("min-w-0 flex-1 text-fg [overflow-wrap:anywhere]", namedByAddress ? "text-mono-sm" : "text-body-md-medium")}>
        {hostname ? (
          <ServerName raw={hostname.hostnameRaw ?? hostname.hostnameClean ?? ""} clean={hostname.hostnameClean ?? ""} wrap />
        ) : (
          serverName(server)
        )}
      </span>
      {status?.password ? <Lock size={14} className="shrink-0 text-fg-muted" aria-label={t("play.password")} /> : null}
      {unverified ? (
        <Badge tone="warm" title={t("play.unverifiedHint")}>
          {t("play.unverified")}
        </Badge>
      ) : null}
      {status ? (
        <span className="shrink-0 text-mono-sm tabular-nums text-fg">
          {status.players}/{status.maxPlayers}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-md border bg-input transition-colors",
        selected ? "border-line-accent" : "border-line",
      )}
    >
      {onSelect ? (
        <button
          type="button"
          role="radio"
          aria-checked={selected ?? false}
          onClick={onSelect}
          className="flex w-full cursor-pointer items-center gap-8 rounded-t-md px-12 pt-10 pb-2 text-left hover:bg-hover-overlay"
        >
          {firstLine}
        </button>
      ) : (
        <div className="flex items-center gap-8 px-12 pt-10 pb-2">{firstLine}</div>
      )}
      <div className="flex min-w-0 items-center gap-6 pb-8 pl-28 pr-6">
        <span className="min-w-0 flex-1 truncate text-mono-xs text-fg-secondary" title={server.address}>
          {namedByAddress ? null : server.address}
          {status?.map && !namedByAddress ? <span className="text-fg-muted"> · </span> : null}
          {status?.map ?? null}
        </span>
        <CopyButton text={server.address} />
      </div>
      {live.state === "unknown" && !live.asking ? null : (
        <div className="flex flex-col gap-6 px-12 pb-12">
          {live.asking && status === null ? (
            <p role="status" className="text-body-sm text-fg-muted">
              {t("play.asking")}
            </p>
          ) : live.state === "off" ? (
            <p className="text-body-sm text-fg-muted">{t("play.noAnswer")}</p>
          ) : names === undefined ? null : (
            <>
              {collapsible ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={expanded ? listId : undefined}
                  onClick={onToggle}
                  className="-mx-6 flex min-h-28 cursor-pointer items-center gap-6 rounded-sm px-6 text-left text-body-sm-medium text-fg hover:bg-hover-overlay"
                >
                  {t("play.players")}
                  <span className="text-mono-xs text-fg-secondary">{names.filter((name) => !name.bot).length}</span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn("ml-auto text-fg-secondary transition-transform", expanded && "rotate-180")}
                  />
                </button>
              ) : (
                <p className="flex min-h-28 items-center gap-6 text-body-sm-medium text-fg">
                  {t("play.players")}
                  <span className="text-mono-xs text-fg-secondary">{names.filter((name) => !name.bot).length}</span>
                </p>
              )}
              {expanded || !collapsible ? <PlayerList id={listId} players={names} /> : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PING_COLOR = {
  good: "text-fg-success",
  ok: "text-fg-warm",
  bad: "text-fg-danger",
  unknown: "text-fg-muted",
} as const;

/** The people of a live answer: humans by score, then the bots. */
function PlayerList({ id, players }: { id: string; players: CommunityLivePlayer[] }) {
  const { t } = useTranslation("community");
  if (players.length === 0) {
    return (
      <p id={id} className="text-body-sm text-fg-muted">
        {t("play.noPlayers")}
      </p>
    );
  }
  const ordered = [...players].sort((a, b) => Number(a.bot) - Number(b.bot) || b.score - a.score);
  // The rows share the columns of the table through a subgrid: the score and
  // ping columns are as wide as their longest cell, the header of any language
  // included, and the name takes the rest.
  return (
    <div id={id} role="table" aria-label={t("play.players")} className="grid grid-cols-[minmax(0,1fr)_minmax(40px,auto)_minmax(40px,auto)] gap-x-8 gap-y-2">
      <div role="row" className="col-span-full grid grid-cols-subgrid items-center text-label-xs text-fg-secondary">
        <span role="columnheader">{t("play.player")}</span>
        <span role="columnheader" className="text-right">
          {t("play.score")}
        </span>
        <span role="columnheader" className="text-right">
          {t("play.ping")}
        </span>
      </div>
      {ordered.map((player, index) => (
        <div role="row" key={`${index}-${player.nameRaw}`} className="col-span-full grid min-h-24 grid-cols-subgrid items-center">
          <span role="cell" className="min-w-0">
            <ServerName
              raw={player.nameRaw}
              clean={player.nameClean}
              className={cn("block text-body-sm", player.bot ? "text-fg-disabled" : "text-fg-secondary")}
            />
          </span>
          <span role="cell" className="text-right text-mono-xs tabular-nums text-fg-secondary">
            {player.score}
          </span>
          <span role="cell" className="text-right">
            {player.bot ? (
              <span className="text-label-xs text-fg-disabled">{t("play.bot")}</span>
            ) : (
              <span className={cn("text-mono-xs tabular-nums", PING_COLOR[pingLevel(player.ping)])}>{player.ping}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

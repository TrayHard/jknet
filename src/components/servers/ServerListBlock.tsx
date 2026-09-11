import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

// --- slice: i18n ---
import { useGametypeLabels } from "../../i18n/useGameLabels";
import { cn } from "../../lib/format";
import type { ServerInfo } from "../../lib/ipc";
import { Badge } from "../ui";
import { botCount, realPlayers } from "./filter";
import { Ping } from "./Ping";
import { ServerName } from "./ServerName";

interface ServerListBlockProps {
  /** Heading above the rows. */
  title: string;
  /**
   * The rows to draw, already picked and ordered by the screen: this component
   * decides nothing about which servers belong in it.
   */
  servers: ServerInfo[];
  /** Draws the link to the Servers screen beside the heading. */
  seeAll?: boolean;
  // --- slice: server actions ---
  /**
   * Drawn at the right end of every row.
   *
   * The screen owns them, because starting a client is its business and not
   * this component's. Every row gets the same pair, so the player presses what
   * they see instead of first teaching the list which row they mean.
   */
  actions?: (server: ServerInfo) => ReactNode;
  /**
   * A second line under the name, or `null` for a row that has none.
   *
   * History is the block that uses it — when the player was last on that
   * server — and the other two pass nothing, which is what keeps their rows
   * one line tall. A caption rather than a column: the answer is a phrase in
   * the language on screen, and it belongs to the row rather than to a heading
   * the other two blocks would have to carry empty.
   */
  caption?: (server: ServerInfo) => string | null;
}

/**
 * One titled list of server rows on the Home screen.
 *
 * Home shows three of these — Favorites, History and the busiest ones. They
 * differ only in the pool behind them, so the row itself lives here once: a
 * player who learns to read one of the three reads all three, and a change to
 * the row lands in every block at the same time.
 *
 * An empty block draws nothing at all, heading included. Home is a summary of
 * what the player already has; a heading over nothing is a promise the screen
 * cannot keep, and three of them stacked would push the real lists out of the
 * window.
 *
 * --- slice: server actions ---
 * The row is read, not pressed: **Connect** and the three dots stand on every
 * row and are the only press targets in it. Selecting a row first was a step
 * that bought nothing — the player already knows which server they want, and
 * a list where the buttons appear only after a click is a list whose buttons
 * are found by accident.
 */
export function ServerListBlock({
  title,
  servers,
  seeAll = false,
  actions,
  caption,
}: ServerListBlockProps) {
  const { t } = useTranslation("home");
  // --- slice: server actions ---
  // The tooltip over the player count says the same thing on both screens, so
  // it is the same message: a server row is a server row wherever it is drawn.
  const { t: tServers } = useTranslation("servers");
  const gametypes = useGametypeLabels();

  if (servers.length === 0) return null;

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h2 className="text-label-xs text-fg-muted">{title}</h2>
        {seeAll ? (
          <Link
            to="/servers"
            className="inline-flex items-center gap-2 text-body-sm-medium text-fg-accent hover:underline"
          >
            {t("topServers.seeAll")}
            <ChevronRight size={14} />
          </Link>
        ) : null}
      </div>

      <ul className="flex flex-col rounded-lg border border-line bg-surface overflow-hidden">
        {servers.map((server) => {
          const line = caption?.(server) ?? null;
          return (
            <li
              key={server.address}
              className={cn(
                "grid items-center gap-12 h-44 px-16",
                // The last column is the actions. It is `auto`, so it measures
                // the buttons themselves and the four columns left of it keep
                // the widths the design gives them; the name is the only
                // flexible one and truncates, which is what holds the row on
                // one line down to the 1100 px minimum.
                "grid-cols-[minmax(0,1fr)_auto_76px_56px_auto]",
                "border-b border-line-subtle last:border-b-0",
              )}
            >
              <span className="flex flex-col justify-center min-w-0">
                <ServerName
                  raw={server.hostnameRaw}
                  clean={server.hostnameClean}
                  className="text-body-sm-medium text-fg"
                />
                {line === null ? null : (
                  <span className="text-label-xs text-fg-disabled truncate">
                    {line}
                  </span>
                )}
              </span>
              <Badge tone="accent">
                {gametypes.label(server.game, server.gametype, server.gametypeLabel)}
              </Badge>
              {/* --- slice: server actions ---
                  People over slots, and the bots in the tooltip, exactly as on
                  the Servers screen: the same fact is worth the same room on
                  both, and the message behind the tooltip is the same one. */}
              <span
                className="text-mono-xs tabular-nums text-fg-secondary text-right"
                title={
                  server.playersSource === "unknown"
                    ? tServers("row.countsUnknownTitle", {
                        clients: server.clients,
                      })
                    : tServers("row.countsTitle", {
                        humans: realPlayers(server),
                        bots: botCount(server),
                        slots: server.maxClients,
                      })
                }
              >
                {realPlayers(server)}/{server.maxClients}
                {server.playersSource === "unknown" ? (
                  <span className="text-fg-disabled" aria-hidden="true">
                    {" "}
                    ?
                  </span>
                ) : null}
              </span>
              <Ping ms={server.pingMs} className="justify-end" />
              <span className="flex items-center gap-6">{actions?.(server)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

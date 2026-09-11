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
  /** Address of the selected row, when the selected row is in this block. */
  selectedAddress?: string | null;
  /** Called with the address of the row that was pressed. */
  onSelect?: (address: string) => void;
  /**
   * Drawn at the right end of the selected row, and only there.
   *
   * Buttons on every row would be eight more press targets down a list whose
   * job is reading. The screen owns them, because starting a client is its
   * business and not this component's.
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
 * A row is selected rather than followed. It used to be a link to the Servers
 * screen, which answered every press with the same screen and left the player
 * to find the row again; now the press picks the row out and the two buttons
 * that matter appear on it — **Connect**, and the menu behind the three dots.
 */
export function ServerListBlock({
  title,
  servers,
  seeAll = false,
  selectedAddress = null,
  onSelect,
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

      <div className="flex flex-col rounded-lg border border-line bg-surface overflow-hidden">
        {servers.map((server) => {
          const chosen = server.address === selectedAddress;
          const line = caption?.(server) ?? null;
          return (
            <div
              key={server.address}
              role="row"
              tabIndex={0}
              aria-selected={chosen}
              onClick={() => onSelect?.(server.address)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect?.(server.address);
                }
              }}
              className={cn(
                "grid items-center gap-12 h-44 px-16 cursor-pointer",
                // The last column is the actions of the selected row. It is
                // `auto`, so it takes no width at all on the rows without them
                // and the four columns left of it stay where they were.
                "grid-cols-[minmax(0,1fr)_auto_76px_56px_auto]",
                "border-b border-line-subtle last:border-b-0 transition-colors",
                chosen ? "bg-selected-overlay" : "hover:bg-surface-hover",
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
              <span className="flex items-center gap-6">
                {chosen ? actions?.(server) : null}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

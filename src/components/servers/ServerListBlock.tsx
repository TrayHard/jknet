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
  // --- slice: servers home tweaks ---
  /**
   * Called when the row itself is pressed, anywhere but on its buttons.
   *
   * Home answers «where do I go», and the answer to «tell me more about this
   * one» is the Servers screen with its panel open on that server. The row
   * therefore leads somewhere, the way a row of the browser leads to the panel
   * beside it. Omit it and the row stays what it was: something to read, with
   * the buttons as its only press targets.
   */
  onOpen?: (server: ServerInfo) => void;
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
 * **Connect** and the three dots stand on every row rather than appearing once
 * a row is selected: the player already knows which server they want, and a
 * list whose buttons show up after a click is a list whose buttons are found
 * by accident.
 *
 * --- slice: servers home tweaks ---
 * The row around those buttons leads to the Servers screen with the details
 * panel open on that server, which is where the question the row cannot answer
 * — who is playing, on what map, for how long — is answered.
 */
export function ServerListBlock({
  title,
  servers,
  seeAll = false,
  actions,
  caption,
  onOpen,
}: ServerListBlockProps) {
  const { t } = useTranslation("home");
  // --- slice: server actions ---
  // The tooltip over the player count says the same thing on both screens, so
  // it is the same message: a server row is a server row wherever it is drawn.
  const { t: tServers } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");
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
              // --- slice: servers home tweaks ---
              // The row leads to the details panel of the Servers screen. Its
              // buttons stop the press themselves, so **Connect** and the menu
              // still do what they say rather than navigating away: the click
              // is stopped where the buttons sit, and the key press is taken
              // only when the row itself has the focus. A key event bubbles
              // whatever the click does, and Enter on **Connect** must not
              // start a client and walk off the screen at the same time.
              tabIndex={onOpen === undefined ? undefined : 0}
              onClick={onOpen === undefined ? undefined : () => onOpen(server)}
              onKeyDown={
                onOpen === undefined
                  ? undefined
                  : (event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onOpen(server);
                    }
              }
              className={cn(
                "grid items-center gap-12 h-44 px-16",
                // The last column is the actions. It is `auto`, so it measures
                // the buttons themselves and the columns left of it keep the
                // widths the design gives them; the name is the only flexible
                // one and truncates, which is what holds the row on one line
                // down to the 1100 px minimum.
                //
                // --- slice: servers home tweaks --- the map takes 116 px, the
                // width the same column has on the Servers table, so a player
                // reading both sees one row and not two designs.
                "grid-cols-[minmax(0,1fr)_116px_auto_76px_56px_auto]",
                "border-b border-line-subtle last:border-b-0",
                onOpen === undefined
                  ? undefined
                  : "cursor-pointer transition-colors duration-100 hover:bg-hover-overlay",
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
              {/* --- slice: servers home tweaks ---
                  Which map is up, in the same place in all three blocks. Half
                  the answer to «do I want to go there» is the map, and the row
                  had the mode and the head count without it. A map name is
                  what the operator put in `mapname`: data, never translated,
                  and cut off rather than allowed to push the row apart. */}
              <span
                className="text-mono-xs text-fg-muted truncate"
                title={server.map}
              >
                {server.map || tCommon("values.empty")}
              </span>
              {/* --- slice: servers home tweaks --- the same pill as the one
                  on the table of the Servers screen, down to the floor under
                  its width and the label centred in it. */}
              <Badge tone="accent" centered>
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
              {/* --- slice: servers home tweaks ---
                  The buttons keep the press to themselves: **Connect** starts
                  a client and the menu opens, and neither of them means «show
                  me this server on the other screen». */}
              <span
                className="flex items-center gap-6"
                onClick={(event) => event.stopPropagation()}
              >
                {actions?.(server)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

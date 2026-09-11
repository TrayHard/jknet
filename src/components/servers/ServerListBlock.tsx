import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

// --- slice: i18n ---
import { useGametypeLabels } from "../../i18n/useGameLabels";
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
 */
export function ServerListBlock({
  title,
  servers,
  seeAll = false,
}: ServerListBlockProps) {
  const { t } = useTranslation("home");
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
        {servers.map((server) => (
          <li key={server.address}>
            <Link
              to="/servers"
              className="grid items-center gap-12 h-44 px-16 grid-cols-[minmax(0,1fr)_auto_76px_56px] border-b border-line-subtle last:border-b-0 hover:bg-surface-hover transition-colors"
            >
              <span className="flex items-center gap-6 min-w-0">
                <ServerName
                  raw={server.hostnameRaw}
                  clean={server.hostnameClean}
                  className="text-body-sm-medium text-fg"
                />
              </span>
              <Badge tone="accent">
                {gametypes.label(server.game, server.gametype, server.gametypeLabel)}
              </Badge>
              <span className="text-mono-xs tabular-nums text-fg-secondary text-right">
                {realPlayers(server)}/{server.maxClients}
                {botCount(server) > 0 ? (
                  <span className="text-fg-muted"> +{botCount(server)}b</span>
                ) : null}
              </span>
              <Ping ms={server.pingMs} className="justify-end" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

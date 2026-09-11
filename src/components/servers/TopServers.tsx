import { ChevronRight, Play } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

// --- slice: i18n ---
import { useGametypeLabels } from "../../i18n/useGameLabels";
import { useCachedServers } from "../../lib/queries";
import { Badge, EmptyState } from "../ui";
import { botCount, isBotOnly, realPlayers } from "./filter";
import { Ping } from "./Ping";
import { ServerName } from "./ServerName";

/** How many rows the Home screen shows. */
const TOP_COUNT = 4;

/**
 * The busiest servers, for the Home screen.
 *
 * The data is whatever `cache\servers.json` holds, so this costs no network
 * call of its own.
 *
 * Busiest means people. A server full of bots is not somewhere to send a
 * player from the first screen, so it is dropped from the pool outright.
 */
export function TopServers() {
  const { t } = useTranslation("home");
  const gametypes = useGametypeLabels();
  const cached = useCachedServers();

  const rows = useMemo(() => {
    const all = cached.data ?? [];
    return all
      .filter((server) => !isBotOnly(server))
      .sort((a, b) => realPlayers(b) - realPlayers(a))
      .slice(0, TOP_COUNT);
  }, [cached.data]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Play size={24} />}
        title={t("topServers.emptyTitle")}
        text={t("topServers.emptyText")}
        action={
          <Link
            to="/servers"
            className="text-body-sm-medium text-fg-accent hover:underline"
          >
            {t("topServers.openServers")}
          </Link>
        }
      />
    );
  }

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h2 className="text-label-xs text-fg-muted">{t("topServers.busiest")}</h2>
        <Link
          to="/servers"
          className="inline-flex items-center gap-2 text-body-sm-medium text-fg-accent hover:underline"
        >
          {t("topServers.seeAll")}
          <ChevronRight size={14} />
        </Link>
      </div>

      <ul className="flex flex-col rounded-lg border border-line bg-surface overflow-hidden">
        {rows.map((server) => (
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

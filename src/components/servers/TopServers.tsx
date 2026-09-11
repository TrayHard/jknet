import { Play } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useCachedServers } from "../../lib/queries";
import { EmptyState } from "../ui";
import { isBotOnly, realPlayers } from "./filter";
import { ServerListBlock } from "./ServerListBlock";

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
  const cached = useCachedServers();

  const rows = useMemo(
    () =>
      (cached.data ?? [])
        .filter((server) => !isBotOnly(server))
        .sort((a, b) => realPlayers(b) - realPlayers(a))
        .slice(0, TOP_COUNT),
    [cached.data],
  );

  // Nothing has ever been fetched. This is the one empty state of the whole
  // server section: Favorites and History are built from the same cache, so
  // when it is empty they are empty too and the screen says it once.
  if ((cached.data ?? []).length === 0) {
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

  // A cache in which every server is bot-only leaves `rows` empty, and the
  // block then draws nothing at all. That is deliberate: Favorites and History
  // may well have rows above it, and «no servers in the cache yet» under two
  // populated lists would be a plain lie.
  return <ServerListBlock title={t("topServers.busiest")} servers={rows} seeAll />;
}

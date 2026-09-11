import { Play } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { ServerInfo } from "../../lib/ipc";
import { useCachedServers } from "../../lib/queries";
import { EmptyState } from "../ui";
import { isBotOnly, realPlayers, visibleServers } from "./filter";
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
 *
 * --- slice: server actions ---
 * The row buttons are the Home screen's and are passed straight through: they
 * start a client, which is the screen's business and not this block's.
 */
export function TopServers({
  actions,
}: {
  actions?: (server: ServerInfo) => ReactNode;
}) {
  const { t } = useTranslation("home");
  const cached = useCachedServers();

  const rows = useMemo(
    () =>
      // --- slice: server actions --- a server the player took off the browser
      // is off this list too: the whole point of hiding is not being suggested
      // it again.
      visibleServers(cached.data ?? [])
        .filter((server) => !isBotOnly(server))
        .sort((a, b) => realPlayers(b) - realPlayers(a))
        .slice(0, TOP_COUNT),
    [cached.data],
  );

  // Nothing to send the player to. This is the one empty state of the whole
  // server section, and it belongs here because this pool is the widest of the
  // three: Favorites and History are built from the same cache and cut down
  // further, so an empty pool here would leave the screen with nothing at all
  // under the hero.
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
    <ServerListBlock
      title={t("topServers.busiest")}
      servers={rows}
      seeAll
      actions={actions}
    />
  );
}

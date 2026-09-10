import { ChevronRight, Play, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";

import { useCachedServers } from "../../lib/queries";
import { Badge, EmptyState } from "../ui";
import { Ping } from "./Ping";
import { ServerName } from "./ServerName";

/** How many rows the Home screen shows. */
const TOP_COUNT = 4;

/**
 * The busiest servers, for the Home screen.
 *
 * Trusted servers win when the bundled list has any; otherwise the four
 * busiest ones stand in, because an empty block on the first screen tells a
 * player nothing. The data is whatever `cache\servers.json` holds, so this
 * costs no network call of its own.
 */
export function TopServers() {
  const cached = useCachedServers();

  const rows = useMemo(() => {
    const all = cached.data ?? [];
    const trusted = all.filter((server) => server.trusted);
    const pool = trusted.length > 0 ? trusted : all;
    return [...pool]
      .sort((a, b) => b.clients - a.clients)
      .slice(0, TOP_COUNT);
  }, [cached.data]);

  const heading = rows.some((server) => server.trusted)
    ? "Trusted servers"
    : "Busiest servers";

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Play size={24} />}
        title="No servers in the cache yet"
        text="Open the Servers screen once and the busiest ones show up here."
        action={
          <Link
            to="/servers"
            className="text-body-sm-medium text-fg-accent hover:underline"
          >
            Open Servers
          </Link>
        }
      />
    );
  }

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h2 className="text-label-xs text-fg-muted">{heading}</h2>
        <Link
          to="/servers"
          className="inline-flex items-center gap-2 text-body-sm-medium text-fg-accent hover:underline"
        >
          See all
          <ChevronRight size={14} />
        </Link>
      </div>

      <ul className="flex flex-col rounded-lg border border-line bg-surface overflow-hidden">
        {rows.map((server) => (
          <li key={server.address}>
            <Link
              to="/servers"
              className="grid items-center gap-12 h-44 px-16 grid-cols-[minmax(0,1fr)_auto_56px_56px] border-b border-line-subtle last:border-b-0 hover:bg-surface-hover transition-colors"
            >
              <span className="flex items-center gap-6 min-w-0">
                {server.trusted ? (
                  <ShieldCheck size={14} className="text-fg-warm shrink-0" />
                ) : null}
                <ServerName
                  raw={server.hostnameRaw}
                  clean={server.hostnameClean}
                  className="text-body-sm-medium text-fg"
                />
              </span>
              <Badge tone="accent">{server.gametypeLabel}</Badge>
              <span className="text-mono-xs tabular-nums text-fg-secondary text-right">
                {server.clients}/{server.maxClients}
              </span>
              <Ping ms={server.pingMs} className="justify-end" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

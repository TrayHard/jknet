import { Download } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Panel, PanelHead } from "./bits";
import { serverName } from "./format";
import { useCommunityPlatform } from "./platform";
import { onlineCount, ServerBlock, type LiveView } from "./ServerBlock";
import type { Community, CommunityServer } from "./types";

export interface PlayPanelProps {
  community: Community;
  /** The servers the reader sees, in the order of the page. */
  servers: CommunityServer[];
  live: Record<string, LiveView>;
  selectedId: string | null;
  onSelect: (serverId: string) => void;
  /** Whether a block's player list is open. */
  isExpanded: (serverId: string) => boolean;
  onToggle: (serverId: string) => void;
  /** The reader organizes the page, and sees servers that are not verified. */
  organizer: boolean;
  /**
   * `overview`: **Play** of the overview, the servers and the way in under them.
   * `servers`: the servers alone, the left card of the **Servers** tab.
   * `join`: the way in alone, the right card of that tab.
   */
  mode: "overview" | "servers" | "join";
}

/**
 * **Play**: the servers of the community with what they say now, the one to
 * join picked, and the host's way in — the launcher's client, install and
 * join — or a line that the launcher does it.
 *
 * A community of one server shows its players without a fold; with several,
 * the blocks are picked like radio buttons and each list folds on its own.
 * The **Servers** tab splits the card in two: the servers on the left, the
 * way in beside them.
 */
export function PlayPanel({ community, servers, live, selectedId, onSelect, isExpanded, onToggle, organizer, mode }: PlayPanelProps) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const headId = useId();
  const several = servers.length > 1;
  const online = onlineCount(live);
  const selected = servers.find((server) => server.id === selectedId) ?? servers[0] ?? null;

  const blocks =
    servers.length === 0 ? (
      <p className="text-body-sm text-fg-secondary">{t("play.noServers")}</p>
    ) : (
      <div role={several ? "radiogroup" : undefined} aria-label={several ? t("play.servers") : undefined} className="flex flex-col gap-8">
        {servers.map((server) => (
          <ServerBlock
            key={server.id}
            server={server}
            live={live[server.id] ?? { state: "unknown", status: null, asking: false }}
            selected={several ? server.id === selected?.id : undefined}
            onSelect={several ? () => onSelect(server.id) : undefined}
            expanded={!several || isExpanded(server.id)}
            collapsible={several}
            onToggle={() => onToggle(server.id)}
            unverified={organizer && !server.verified}
          />
        ))}
      </div>
    );

  const join = platform.renderPlay ? (
    platform.renderPlay({ community, server: selected })
  ) : servers.length > 0 ? (
    (platform.playNote ?? (
      <p className="flex items-start gap-8 text-body-sm text-fg-secondary">
        <Download size={16} className="mt-1 shrink-0 text-fg-muted" aria-hidden="true" />
        <span>{t("play.launcherNote")}</span>
      </p>
    ))
  ) : null;

  const sub = online === null ? null : <span className="text-body-sm text-fg-secondary">{t("play.online", { count: online })}</span>;

  if (mode === "servers") {
    return (
      <Panel labelledBy={headId} className="gap-16">
        <PanelHead id={headId} title={t("tabs.servers")} end={sub} />
        {blocks}
      </Panel>
    );
  }
  if (mode === "join") {
    if (join === null) return null;
    return (
      <Panel labelledBy={headId} className="gap-16">
        <PanelHead
          id={headId}
          title={t("play.title")}
          end={
            selected ? (
              <span className="min-w-0 truncate text-body-sm text-fg-secondary" title={selected.address}>
                {selected.label.trim() !== "" ? `${serverName(selected)} · ${selected.address}` : selected.address}
              </span>
            ) : null
          }
        />
        {join}
      </Panel>
    );
  }
  return (
    <Panel labelledBy={headId} className="gap-16">
      <PanelHead id={headId} title={t("play.title")} end={sub} />
      {blocks}
      {join}
    </Panel>
  );
}

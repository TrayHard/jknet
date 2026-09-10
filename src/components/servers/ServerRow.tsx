import { Lock, ShieldCheck, Star } from "lucide-react";

import { cn } from "../../lib/format";
import type { ServerInfo } from "../../lib/ipc";
import { Badge, type BadgeTone } from "../ui";
import { botCount, realPlayers } from "./filter";
import { Ping } from "./Ping";
import { ServerName } from "./ServerName";

/**
 * Column widths of the design: star 16, name fills the rest, the trust and
 * lock marks 40, map 116, mode 60, players 76, ping 56, mod 60. One constant
 * so the header, the rows and the skeleton cannot drift apart.
 *
 * The design gives the players column 52 px, which holds `12/32` and nothing
 * else. The bot suffix needs the rest; the name column gives it up, because
 * it is the only flexible one and a name loses less by being 24 px shorter
 * than a count does by being cut off.
 */
export const ROW_COLUMNS =
  "16px minmax(0, 1fr) 40px 116px 60px 76px 56px 60px";

/** Which badge tone a game type gets, so the modes stay apart at a glance. */
const MODE_TONE: Record<number, BadgeTone> = {
  0: "neutral", // FFA
  1: "purple", // Holocron
  2: "purple", // Jedi Master
  3: "warm", // Duel
  4: "warm", // Power Duel
  6: "success", // Team FFA
  7: "danger", // Siege
  8: "accent", // CTF
  9: "accent", // CTY
};

/** The short label the 60 px mode column can hold. */
const MODE_SHORT: Record<number, string> = {
  0: "FFA",
  1: "HOLO",
  2: "JM",
  3: "DUEL",
  4: "PDUEL",
  5: "SP",
  6: "TFFA",
  7: "SIEGE",
  8: "CTF",
  9: "CTY",
};

interface ServerRowProps {
  server: ServerInfo;
  selected: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}

/** One line of the server table. */
export function ServerRow({
  server,
  selected,
  onSelect,
  onToggleFavorite,
}: ServerRowProps) {
  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      style={{ gridTemplateColumns: ROW_COLUMNS }}
      className={cn(
        "grid items-center gap-12 h-40 px-12 rounded-md cursor-pointer",
        "transition-colors duration-100",
        selected
          ? "bg-selected-overlay text-fg"
          : "hover:bg-hover-overlay text-fg-secondary",
      )}
    >
      <button
        type="button"
        aria-label={server.favorite ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={server.favorite}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite();
        }}
        className={cn(
          "flex items-center justify-center size-16 cursor-pointer",
          server.favorite
            ? "text-fg-warm"
            : "text-fg-disabled hover:text-fg-muted",
        )}
      >
        <Star size={14} fill={server.favorite ? "currentColor" : "none"} />
      </button>

      <ServerName
        raw={server.hostnameRaw}
        clean={server.hostnameClean}
        className="text-body-sm-medium text-fg"
      />

      <span className="flex items-center gap-4 text-fg-muted">
        {server.trusted ? (
          <ShieldCheck size={14} className="text-fg-warm" aria-label="Trusted" />
        ) : null}
        {server.needpass ? (
          <Lock size={14} aria-label="Password required" />
        ) : null}
      </span>

      <span className="text-mono-xs text-fg-muted truncate" title={server.map}>
        {server.map || "—"}
      </span>

      <Badge tone={MODE_TONE[server.gametype] ?? "neutral"}>
        {MODE_SHORT[server.gametype] ?? String(server.gametype)}
      </Badge>

      <PlayerCount server={server} />

      <Ping ms={server.pingMs} />

      <span className="text-mono-xs text-fg-muted truncate" title={server.game}>
        {server.game}
      </span>
    </div>
  );
}

/**
 * Real players over the slot count, and the bots beside it.
 *
 * The bots are muted and marked `b` rather than folded into the total: a
 * player scanning the column is looking for people, and a server showing `0/32
 * +12b` says in one glance what `12/32` used to hide.
 */
function PlayerCount({ server }: { server: ServerInfo }) {
  const humans = realPlayers(server);
  const bots = botCount(server);
  const unknown = server.playersSource === "unknown";

  return (
    <span
      className="text-mono-xs tabular-nums text-fg-secondary truncate"
      title={
        unknown
          ? `${server.clients} clients; this server does not say how many are bots`
          : `${humans} players, ${bots} bots, ${server.maxClients} slots`
      }
    >
      <span className={humans > 0 ? "text-fg" : undefined}>{humans}</span>
      <span className="text-fg-disabled">/{server.maxClients}</span>
      {bots > 0 ? <span className="text-fg-muted"> +{bots}b</span> : null}
      {unknown ? <span className="text-fg-disabled" aria-hidden="true"> ?</span> : null}
    </span>
  );
}

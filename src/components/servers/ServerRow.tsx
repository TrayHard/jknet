import { Lock, ShieldCheck, Star } from "lucide-react";

import { cn } from "../../lib/format";
import type { ServerInfo } from "../../lib/ipc";
import { Badge, type BadgeTone } from "../ui";
import { Ping } from "./Ping";
import { ServerName } from "./ServerName";

/**
 * Column widths of the design: star 16, name fills the rest, the trust and
 * lock marks 40, map 116, mode 60, players 52, ping 56, mod 60. One constant
 * so the header, the rows and the skeleton cannot drift apart.
 */
export const ROW_COLUMNS =
  "16px minmax(0, 1fr) 40px 116px 60px 52px 56px 60px";

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

      <span className="text-mono-xs tabular-nums text-fg-secondary">
        <span className={server.clients > 0 ? "text-fg" : undefined}>
          {server.clients}
        </span>
        <span className="text-fg-disabled">/{server.maxClients}</span>
      </span>

      <Ping ms={server.pingMs} />

      <span className="text-mono-xs text-fg-muted truncate" title={server.game}>
        {server.game}
      </span>
    </div>
  );
}

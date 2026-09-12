import { Eye, EyeOff, Lock, Star } from "lucide-react";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useGametypeLabels } from "../../i18n/useGameLabels";
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
 * else. The 24 px above that were the bot suffix, and they stay after it: at
 * 11 px monospace a busy server writes `128/128`, and a server that publishes
 * no split writes a `?` after it. The name column is the one that gives them
 * up, because it is the only flexible one and it truncates gracefully.
 *
 * --- slice: servers home tweaks ---
 * A ninth column closes the row: the eye that takes a server off the browser.
 * It is 16 px, the width of the star that opens the row, so the two one-press
 * marks of a row frame it rather than each finding a size of their own.
 */
export const ROW_COLUMNS =
  "16px minmax(0, 1fr) 40px 116px 60px 76px 56px 60px 16px";

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

interface ServerRowProps {
  server: ServerInfo;
  selected: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  // --- slice: servers home tweaks ---
  /** Takes this server off the browser, or brings it back on the Hidden tab. */
  onToggleHidden: () => void;
}

/** One line of the server table. */
export function ServerRow({
  server,
  selected,
  onSelect,
  onToggleFavorite,
  onToggleHidden,
}: ServerRowProps) {
  const { t } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");
  // --- slice: i18n --- the short names live in the `games` catalog, one table
  // per game: number 7 is SIEGE in Jedi Academy and CTF in Jedi Outcast.
  const gametypes = useGametypeLabels();

  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        // --- slice: servers home tweaks ---
        // Only when the row itself has the focus. The star and the eye sit
        // inside it and their key presses bubble here whatever they do with
        // the click, so Enter on the eye would hide a server and select it in
        // the same breath.
        if (event.target !== event.currentTarget) return;
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
        // --- slice: servers browser ---
        // A server that did not answer the last check is still a row — the
        // player put it in their favourites — but it is not a row to join, so
        // the whole line steps back.
        !server.responded && "opacity-55",
      )}
    >
      <button
        type="button"
        aria-label={
          server.favorite ? t("row.removeFavorite") : t("row.addFavorite")
        }
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
        {server.needpass ? (
          <Lock size={14} aria-label={t("row.passwordRequired")} />
        ) : null}
      </span>

      {/* A map name is what the operator put in `mapname`: data, never a
          string to translate. */}
      <span className="text-mono-xs text-fg-muted truncate" title={server.map}>
        {server.map || tCommon("values.empty")}
      </span>

      {/* --- slice: servers home tweaks --- `centered`, because this badge
          stands in a column with others under it. The rule itself lives in
          the kit, so the row of Home cannot line its modes up differently. */}
      <Badge tone={MODE_TONE[server.gametype] ?? "neutral"} centered>
        {gametypes.short(server.game, server.gametype)}
      </Badge>

      <PlayerCount server={server} />

      {/* --- slice: servers browser ---
          A measured round trip, or the reason there is none. A ping from the
          last time the server was up would be a promise the row cannot keep.

          --- slice: server actions ---
          Left, and said so rather than inherited: the column holds a number,
          an **Offline** word and a column heading, and three elements that
          each fall where the layout happens to put them are three elements
          that drift apart the moment one of them changes shape. */}
      {server.responded ? (
        <Ping ms={server.pingMs} className="justify-start" />
      ) : (
        <span
          className="text-mono-xs text-fg-disabled text-left truncate"
          title={t("row.noResponseTitle")}
        >
          {t("row.noResponse")}
        </span>
      )}

      <span className="text-mono-xs text-fg-muted truncate" title={server.modName}>
        {server.modName}
      </span>

      {/* --- slice: servers home tweaks ---
          Hiding a server used to take selecting the row and opening the menu
          beside **Connect**, which is three presses to say «not this one».
          The row carries it now, at the end where the star at the other end
          answers the opposite question. Which way it goes is the row's own
          `hidden` flag, so the button reads **Unhide** on the Hidden tab and
          nowhere else — the same rule the menu item follows. */}
      <button
        type="button"
        title={server.hidden ? t("menu.unhide") : t("menu.hide")}
        aria-label={server.hidden ? t("menu.unhide") : t("menu.hide")}
        aria-pressed={server.hidden}
        onClick={(event) => {
          // The row underneath selects on a press, and taking a server off
          // the list is not a way of saying «show me this one».
          event.stopPropagation();
          onToggleHidden();
        }}
        className={cn(
          "flex items-center justify-center size-16 cursor-pointer",
          server.hidden
            ? "text-fg-accent hover:text-fg"
            : "text-fg-disabled hover:text-fg-muted",
        )}
      >
        {server.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </div>
  );
}

/**
 * Real players over the slot count, with the bots in the tooltip.
 *
 * People and slots are the two numbers a player scans the column for, and the
 * cell is 76 px wide: a `+12b` beside them doubled the length of the cell to
 * answer a question nobody was asking while reading down a list. The bots are
 * still a fact about the server, so they are a hover away — and the details
 * panel, which is where a player looks once one row has their attention,
 * spells them out.
 *
 * The `?` of an unknown split stays on the row. It is not a count but a
 * warning that the count beside it is the server's own total, bots included,
 * and a warning that only shows on hover is a warning nobody reads.
 */
function PlayerCount({ server }: { server: ServerInfo }) {
  const { t } = useTranslation("servers");
  const humans = realPlayers(server);
  const bots = botCount(server);
  const unknown = server.playersSource === "unknown";

  return (
    <span
      className="text-mono-xs tabular-nums text-fg-secondary truncate"
      title={
        unknown
          ? t("row.countsUnknownTitle", { clients: server.clients })
          : t("row.countsTitle", {
              humans,
              bots,
              slots: server.maxClients,
            })
      }
    >
      <span className={humans > 0 ? "text-fg" : undefined}>{humans}</span>
      <span className="text-fg-disabled">/{server.maxClients}</span>
      {unknown ? <span className="text-fg-disabled" aria-hidden="true"> ?</span> : null}
    </span>
  );
}

import { Check, Copy, Lock, Play, RefreshCw, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useFormat } from "../../i18n/useFormat";
import { useGametypeLabels } from "../../i18n/useGameLabels";
import { cn } from "../../lib/format";
import type { ServerInfo, ServerPlayer } from "../../lib/ipc";
import { MapPreview } from "../MapPreview";
import { Badge, Button } from "../ui";
import { botCount, realPlayers } from "./filter";
import { Ping } from "./Ping";
import { ServerName } from "./ServerName";

interface ServerDetailsProps {
  server: ServerInfo;
  players: ServerPlayer[] | undefined;
  playersLoading: boolean;
  // --- slice: servers robustness ---
  /**
   * True when `getstatus` went unanswered, retry included.
   *
   * Not the message of that failure: a server may answer `getinfo` in 70 ms
   * and never answer `getstatus` at all, so «did not answer» reads as a broken
   * server when it is a configured one. The panel says what it can show
   * instead — the list the cache remembers, or that this server publishes no
   * list.
   */
  playersFailed: boolean;
  // --- slice: servers robustness ---
  /**
   * Asks this server for its player list again.
   *
   * The two requests `get_server_status` sends cover a lost datagram and
   * nothing beyond it, so a server that was reloading a map when the panel
   * opened stays listless until something asks again. Without the button that
   * something is the player deselecting the row and picking it back — and
   * within the 15 s the query stays fresh, even that returns the cached
   * refusal rather than a new question.
   */
  onRetryPlayers: () => void;
  onConnect: () => void;
  /** False when there is no default client to start. */
  canConnect: boolean;
  /** True while a launch is in flight, so the button cannot start a second. */
  connecting: boolean;
  /** Shown under the button when `canConnect` is false. */
  hint?: ReactNode;
}

/**
 * The panel to the right of the table, for the selected server.
 *
 * The panel is as tall as the row it sits in, and the player list takes what
 * the blocks around it leave: `min-h-0` here lets that list shrink below its
 * own content and scroll inside itself, so **Connect** keeps the bottom edge
 * at every window height down to the 700 px minimum. A fixed cap on the list
 * did neither — it wasted the space of a tall window and overflowed a short
 * one.
 */
export function ServerDetails({
  server,
  players,
  playersLoading,
  playersFailed,
  onRetryPlayers,
  onConnect,
  canConnect,
  connecting,
  hint,
}: ServerDetailsProps) {
  const { t } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");
  const gametypes = useGametypeLabels();
  const format = useFormat();
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    void navigator.clipboard
      .writeText(server.address)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
      .finally(() => window.setTimeout(() => setCopied(false), 1_500));
  };

  return (
    <aside className="flex flex-col gap-16 w-320 shrink-0 min-h-0 rounded-lg border border-line bg-surface p-16">
      {/* --- slice: maps --- */}
      <MapPreview map={server.map} game={server.game} compact className="h-96" />

      <div className="flex flex-col gap-8">
        <ServerName
          raw={server.hostnameRaw}
          clean={server.hostnameClean}
          className="text-heading-sm text-fg"
        />
        <div className="flex flex-wrap items-center gap-6">
          <Badge tone="accent">
            {gametypes.label(server.game, server.gametype, server.gametypeLabel)}
          </Badge>
          {/* The mod folder is data: whatever the operator put in `fs_game`. */}
          <Badge>{server.modName}</Badge>
          {server.needpass ? (
            <Badge tone="danger" icon={<Lock size={12} />}>
              {t("details.password")}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-8 h-32 px-10 rounded-md bg-input border border-line">
        <span className="text-mono-sm text-fg-secondary truncate flex-1">
          {server.address}
        </span>
        <button
          type="button"
          onClick={copyAddress}
          aria-label={t("details.copyAddress")}
          className="text-fg-muted hover:text-fg transition-colors cursor-pointer"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div className="flex items-center justify-between text-body-sm text-fg-muted">
        <span className="inline-flex items-center gap-6">
          <Users size={14} />
          <span className="text-fg-secondary">
            {realPlayers(server)}/{server.maxClients}
          </span>
          {botCount(server) > 0 ? (
            <span className="text-fg-disabled">
              {t("details.bots", { count: botCount(server) })}
            </span>
          ) : null}
          {server.playersSource === "unknown" ? (
            <span className="text-fg-disabled" title={t("details.botsUnknownTitle")}>
              {t("details.botsUnknown")}
            </span>
          ) : null}
        </span>
        <Ping ms={server.pingMs} />
      </div>

      <PlayerList
        players={players}
        loading={playersLoading}
        failed={playersFailed}
        onRetry={onRetryPlayers}
        remembered={server.lastPlayers}
        rememberedAge={rememberedAge(format, server.lastPlayersAt)}
      />

      <div className="flex flex-col gap-6 mt-auto">
        <Button
          variant="primary"
          size="lg"
          block
          icon={<Play size={18} />}
          disabled={!canConnect || connecting}
          onClick={onConnect}
        >
          {connecting ? tCommon("states.starting") : t("details.connect")}
        </Button>
        {canConnect ? null : hint}
      </div>
    </aside>
  );
}

// --- slice: servers robustness ---
/**
 * How long ago a remembered player list was taken, already formatted.
 *
 * `null` for a row that has none and for a timestamp that does not parse: a
 * caption cannot say «from an unknown time ago», so the list is shown without
 * one rather than with a wrong one.
 */
function rememberedAge(
  format: ReturnType<typeof useFormat>,
  at: string | null,
): string | null {
  if (at === null) return null;
  const taken = Date.parse(at);
  if (Number.isNaN(taken)) return null;
  return format.age(Math.max(0, Math.floor((Date.now() - taken) / 1_000)));
}

/** The `getstatus` answer, the last one that arrived, or neither. */
function PlayerList({
  players,
  loading,
  failed,
  onRetry,
  remembered,
  rememberedAge,
}: {
  players: ServerPlayer[] | undefined;
  loading: boolean;
  // --- slice: servers robustness ---
  /** The live request went unanswered, retry included. */
  failed: boolean;
  /** Asks the server again, past the freshness the query would honour. */
  onRetry: () => void;
  /** The last list any scan got out of this server, from the cached row. */
  remembered: ServerPlayer[] | null;
  /** How long ago that list was taken, or `null` when there is no list. */
  rememberedAge: string | null;
}) {
  const { t } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        {[0, 1, 2].map((row) => (
          <span
            key={row}
            className="h-12 rounded-full bg-elevated animate-pulse"
            style={{ width: `${70 - row * 12}%` }}
          />
        ))}
      </div>
    );
  }

  // --- slice: servers robustness ---
  // A silent `getstatus` is not a broken server. It is shown as what it is:
  // the last list the launcher has with the time on it, or a sentence about
  // this server rather than about the network.
  if (failed) {
    // The button goes with both halves of the refusal: a server that was
    // reloading a map answers the next question, whether or not this launcher
    // happens to remember an older list for it.
    const again = (
      <Button
        size="sm"
        variant="ghost"
        icon={<RefreshCw size={14} />}
        onClick={onRetry}
        className="self-start -ml-8"
      >
        {tCommon("actions.tryAgain")}
      </Button>
    );

    if (remembered === null || remembered.length === 0) {
      return (
        <div className="flex flex-col gap-6">
          <p className="text-body-sm text-fg-muted">{t("details.playersClosed")}</p>
          {again}
        </div>
      );
    }
    const humans = remembered.filter((player) => !player.isBot);
    return (
      <div className="flex flex-col gap-6 flex-1 min-h-0 -mx-4">
        <p className="px-4 text-label-xs text-fg-disabled">
          {rememberedAge === null
            ? t("details.playersRememberedUnknown")
            : t("details.playersRemembered", { age: rememberedAge })}
        </p>
        {humans.length === 0 ? (
          <p className="px-4 text-body-sm text-fg-muted">
            {t("details.onlyBots", { count: remembered.length - humans.length })}
          </p>
        ) : (
          // The list scrolls, the button below it does not: a remembered list
          // is as long as a live one, and a button that scrolls out of the
          // panel is a button nobody finds.
          <div className="flex-1 min-h-0 overflow-y-auto">
            <PlayerRows players={humans} />
          </div>
        )}
        <div className="px-4">{again}</div>
      </div>
    );
  }

  if (players === undefined || players.length === 0) {
    return <p className="text-body-sm text-fg-muted">{t("details.noPlayers")}</p>;
  }

  // People first, bots after them, each half keeping the server's own order,
  // which is the slot order and therefore the scoreboard order.
  const humans = players.filter((player) => !player.isBot);
  const bots = players.filter((player) => player.isBot);

  if (humans.length === 0) {
    return (
      <div className="flex flex-col gap-6 flex-1 min-h-0 overflow-y-auto">
        <p className="text-body-sm text-fg-muted">
          {t("details.onlyBots", { count: bots.length })}
        </p>
        <PlayerRows players={bots} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 flex-1 min-h-0 overflow-y-auto -mx-4">
      <PlayerRows players={humans} />
      {bots.length > 0 ? (
        <>
          <p className="px-4 text-label-xs text-fg-disabled">
            {t("details.botHeading", { count: bots.length })}
          </p>
          <PlayerRows players={bots} />
        </>
      ) : null}
    </div>
  );
}

/**
 * One block of the player list.
 *
 * A bot is drawn a step quieter than a person and carries a neutral `BOT`
 * badge in place of its ping, which is the zero the badge is derived from and
 * says nothing to a reader.
 */
function PlayerRows({ players }: { players: ServerPlayer[] }) {
  const { t } = useTranslation("servers");

  return (
    <ul className="flex flex-col gap-2">
      {players.map((player, index) => (
        <li
          key={`${index}-${player.nameRaw}`}
          className={cn(
            "grid items-center gap-8 h-24 px-4 rounded-sm",
            "grid-cols-[minmax(0,1fr)_32px_44px]",
          )}
        >
          <ServerName
            raw={player.nameRaw}
            clean={player.nameClean}
            className={cn(
              "text-body-sm",
              player.isBot ? "text-fg-disabled" : "text-fg-secondary",
            )}
          />
          <span
            className={cn(
              "text-mono-xs tabular-nums text-right",
              player.isBot ? "text-fg-disabled" : "text-fg-muted",
            )}
          >
            {player.score}
          </span>
          {player.isBot ? (
            <Badge className="justify-self-end">{t("details.botBadge")}</Badge>
          ) : (
            <Ping ms={player.ping} className="justify-end" />
          )}
        </li>
      ))}
    </ul>
  );
}

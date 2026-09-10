import { Check, Copy, Lock, Play, ShieldCheck, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/format";
import type { ServerInfo, ServerPlayer } from "../../lib/ipc";
import { Badge, Button } from "../ui";
import { botCount, realPlayers } from "./filter";
import { Ping } from "./Ping";
import { ServerName } from "./ServerName";

interface ServerDetailsProps {
  server: ServerInfo;
  players: ServerPlayer[] | undefined;
  playersLoading: boolean;
  /** Why the player list is missing, when it is. */
  playersError: string | null;
  onConnect: () => void;
  /** False when there is no default client to start. */
  canConnect: boolean;
  /** True while a launch is in flight, so the button cannot start a second. */
  connecting: boolean;
  /** Shown under the button when `canConnect` is false. */
  hint?: ReactNode;
}

/** The panel to the right of the table, for the selected server. */
export function ServerDetails({
  server,
  players,
  playersLoading,
  playersError,
  onConnect,
  canConnect,
  connecting,
  hint,
}: ServerDetailsProps) {
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    void navigator.clipboard
      .writeText(server.address)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
      .finally(() => window.setTimeout(() => setCopied(false), 1_500));
  };

  return (
    <aside className="flex flex-col gap-16 w-320 shrink-0 rounded-lg border border-line bg-surface p-16">
      {/* The design puts a map image here; the launcher has no map art yet,
          so the same block carries the map name over a gradient. */}
      <div className="relative h-96 rounded-md overflow-hidden bg-app border border-line-subtle">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-br from-accent-subtle to-purple-subtle opacity-60"
        />
        <span className="absolute left-12 bottom-10 text-mono-sm text-fg">
          {server.map || "unknown map"}
        </span>
      </div>

      <div className="flex flex-col gap-8">
        <ServerName
          raw={server.hostnameRaw}
          clean={server.hostnameClean}
          className="text-heading-sm text-fg"
        />
        <div className="flex flex-wrap items-center gap-6">
          {server.trusted ? (
            <Badge tone="warm" icon={<ShieldCheck size={12} />}>
              TRUSTED
            </Badge>
          ) : null}
          <Badge tone="accent">{server.gametypeLabel}</Badge>
          <Badge>{server.game}</Badge>
          {server.needpass ? (
            <Badge tone="danger" icon={<Lock size={12} />}>
              PASSWORD
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
          aria-label="Copy address"
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
            <span className="text-fg-disabled">+{botCount(server)} bots</span>
          ) : null}
          {server.playersSource === "unknown" ? (
            <span
              className="text-fg-disabled"
              title="This server publishes no bot count and did not answer getstatus"
            >
              bots unknown
            </span>
          ) : null}
        </span>
        <Ping ms={server.pingMs} />
      </div>

      <PlayerList
        players={players}
        loading={playersLoading}
        error={playersError}
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
          {connecting ? "Starting…" : "Connect"}
        </Button>
        {canConnect ? null : hint}
      </div>
    </aside>
  );
}

/** The `getstatus` answer, or why there is none. */
function PlayerList({
  players,
  loading,
  error,
}: {
  players: ServerPlayer[] | undefined;
  loading: boolean;
  error: string | null;
}) {
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

  if (error !== null) {
    return <p className="text-body-sm text-fg-muted">{error}</p>;
  }

  if (players === undefined || players.length === 0) {
    return <p className="text-body-sm text-fg-muted">Nobody is playing.</p>;
  }

  // People first, bots after them, each half keeping the server's own order,
  // which is the slot order and therefore the scoreboard order.
  const humans = players.filter((player) => !player.isBot);
  const bots = players.filter((player) => player.isBot);

  if (humans.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-body-sm text-fg-muted">
          Nobody is playing: {bots.length} {bots.length === 1 ? "bot" : "bots"}{" "}
          {bots.length === 1 ? "is" : "are"} alone here.
        </p>
        <PlayerRows players={bots} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-h-200 overflow-y-auto -mx-4">
      <PlayerRows players={humans} />
      {bots.length > 0 ? (
        <>
          <p className="px-4 text-label-xs text-fg-disabled">
            {bots.length} {bots.length === 1 ? "BOT" : "BOTS"}
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
            <Badge className="justify-self-end">BOT</Badge>
          ) : (
            <Ping ms={player.ping} className="justify-end" />
          )}
        </li>
      ))}
    </ul>
  );
}

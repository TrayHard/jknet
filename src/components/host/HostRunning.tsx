import { Clock, Globe, Map as MapIcon, Play, RefreshCw, Share2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import { useGametypeLabels } from "../../i18n/useGameLabels";
import { hostInviteCard } from "../../lib/chat/cardDrafts";
import type { HostSession } from "../../lib/ipc";
import { useShareDialog } from "../chat/ShareToChatDialog";
import { Badge, Button } from "../ui";
import { AddressField, CopyButton } from "./CopyButton";
import {
  consoleCommand,
  countdown,
  humanCount,
  joinAddress,
  nextUtcMidnight,
  relayAddress,
  relayDown,
  secondsSince,
  secondsUntil,
} from "./hostModel";
import { Notice } from "./Notice";
import { PlayerRow } from "./PlayerRow";

interface HostRunningProps {
  session: HostSession;
  now: number;
  /** A game of this launcher runs already: **Play** would start a second one. */
  gameRunning: boolean;
  onPlay: () => void;
  playing: boolean;
  onChangeMap: () => void;
  onStop: () => void;
  stopping: boolean;
  onRetryRelay: () => void;
  retrying: boolean;
}

/**
 * The **Running** state: the server, the players on it, and how to reach it.
 *
 * Three cards, as the design has them. The relay line turns into a warning
 * with **Retry** when the relay drops, and the **Internet** row of the
 * addresses goes with it: an address that does not answer is worse than
 * none. The auto-stop line counts down only while the server is empty.
 */
export function HostRunning({
  session,
  now,
  gameRunning,
  onPlay,
  playing,
  onChangeMap,
  onStop,
  stopping,
  onRetryRelay,
  retrying,
}: HostRunningProps) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  const { t: tChat } = useTranslation("chat");
  const format = useFormat();
  const labels = useGametypeLabels();
  // --- slice: chat cards --- **Share to chat**: an invitation card of this
  // server, the session and the name alone; the service fills in the rest.
  const share = useShareDialog();
  const { settings } = session;
  const humans = humanCount(session.players);
  const isStopping = stopping || session.status === "stopping";

  const ran = secondsSince(session.readyAt ?? session.startedAt, now) ?? 0;
  const relay = relayLine(session, now);
  const autoStop = secondsUntil(session.autoStopAt, now);
  const internet = relayAddress(session);
  const password = settings.password;
  const command = consoleCommand(password, joinAddress(session));

  function relayLine(current: HostSession, at: number) {
    if (current.settings.network === "lan") return null;
    const { status, region, expiresAt, errorCode, error } = current.relay;
    if (status === "active") {
      const left = secondsUntil(expiresAt, at);
      const time = left === null ? "—" : format.elapsed(left);
      return {
        down: false,
        text:
          region === null
            ? t("running.relay.activeNoRegion", { time })
            : t("running.relay.active", { region, time }),
      };
    }
    if (status === "connecting") return { down: false, text: t("running.relay.connecting") };
    if (!relayDown(current)) return null;
    if (errorCode === "quota_active") return { down: true, text: t("running.relayDown.quotaActive") };
    if (errorCode === "quota_daily") {
      const time = new Intl.DateTimeFormat(format.locale, { timeStyle: "short" }).format(
        nextUtcMidnight(at),
      );
      return { down: true, text: t("running.relayDown.quotaDaily", { time }) };
    }
    const reason =
      errorCode === null
        ? error !== null && error.trim() !== ""
          ? error
          : t("running.relayReason.other")
        : t(`running.relayReason.${errorCode}`);
    return { down: true, text: t("running.relayDown.text", { reason }) };
  }

  return (
    <>
      <section className="flex flex-col gap-8 rounded-lg border border-line bg-surface p-16">
        <div className="flex items-center gap-12 min-w-0">
          <h2 className="text-display-md text-fg truncate" title={settings.serverName}>
            {settings.serverName}
          </h2>
          <Badge tone={isStopping ? "neutral" : "success"} className="shrink-0">
            {isStopping ? t("running.stopping") : t("running.badge")}
          </Badge>
          <span className="flex items-center gap-6 shrink-0 text-body-sm text-fg-muted">
            <Clock size={16} aria-hidden="true" />
            {format.elapsed(ran)}
          </span>
        </div>
        <p className="text-body-md text-fg-secondary">
          {t("running.details", {
            map: settings.map,
            gametype: labels.label(session.game, settings.gametype),
            players: humans,
            max: settings.maxPlayers,
          })}
        </p>
        {relay !== null && !relay.down ? (
          <p className="flex items-center gap-8 text-body-sm text-fg-secondary">
            <Globe size={16} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0">{relay.text}</span>
          </p>
        ) : null}
        {relay !== null && relay.down ? (
          <Notice
            tone="warm"
            action={
              <Button
                size="sm"
                icon={<RefreshCw size={14} className={retrying ? "animate-spin" : undefined} />}
                disabled={retrying || isStopping}
                onClick={onRetryRelay}
              >
                {tCommon("actions.retry")}
              </Button>
            }
          >
            {relay.text}
          </Notice>
        ) : null}
        {autoStop !== null && humans === 0 ? (
          <p className="flex items-center gap-8 text-body-sm text-fg-warm">
            <Clock size={16} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0">
              {session.joinedCount === 0
                ? t("running.autoStop.nobodyJoined", { time: countdown(autoStop) })
                : t("running.autoStop.empty", { time: countdown(autoStop) })}
            </span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-8 pt-8">
          <Button
            variant="primary"
            icon={<Play size={16} />}
            disabled={gameRunning || playing || isStopping}
            title={gameRunning ? t("setup.stopGameFirst") : undefined}
            onClick={onPlay}
          >
            {t("running.play")}
          </Button>
          <Button icon={<MapIcon size={16} />} disabled={isStopping} onClick={onChangeMap}>
            {t("running.changeMap")}
          </Button>
          {share.available ? (
            <Button
              icon={<Share2 size={16} />}
              disabled={isStopping}
              onClick={() => share.open({ kind: "card", card: hostInviteCard(session.id, settings.serverName) })}
            >
              {tChat("share.action")}
            </Button>
          ) : null}
          <Button
            icon={<Square size={16} />}
            disabled={isStopping}
            onClick={onStop}
            className="ml-auto"
          >
            {isStopping ? t("starting.stopping") : t("running.stop")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-8 rounded-lg border border-line bg-surface p-16">
        <h3 className="text-heading-sm text-fg">{t("running.players.title")}</h3>
        {session.players.length === 0 ? (
          <p className="text-body-sm text-fg-muted">{t("running.players.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {session.players.map((player, index) => (
              <PlayerRow key={`${index}-${player.name}`} player={player} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
        <h3 className="text-heading-sm text-fg">{t("running.join.title")}</h3>
        <div className="flex flex-col gap-8">
          {internet !== null ? (
            <AddressField label={t("running.join.internet")} value={internet} />
          ) : null}
          {session.lanAddresses.map((address) => (
            <AddressField key={address} label={t("running.join.lan")} value={address} />
          ))}
          {password !== null ? (
            <AddressField label={t("running.join.password")} value={password} />
          ) : null}
        </div>
        <div className="flex items-center gap-12">
          <CopyButton text={command} className="shrink-0">
            <span className="inline-flex items-center">{t("running.join.console")}</span>
          </CopyButton>
          <p className="flex-1 min-w-0 text-body-sm text-fg-muted">{t("running.join.consoleHint")}</p>
        </div>
      </section>
      {share.dialog}
    </>
  );
}


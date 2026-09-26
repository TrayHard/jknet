import { Copy, Map as MapIcon, Play, Server } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useGametypeLabels } from "../../../i18n/useGameLabels";
import type { MapCardFields } from "../../../lib/chat/cardDrafts";
import { useGameNames } from "../../../lib/game";
import { levelshotUrl, type HostSettings } from "../../../lib/ipc";
import {
  useChangeHostMap,
  useHostMaps,
  useHostOptions,
  useHostSession,
  useLevelshot,
  useStartHost,
} from "../../../lib/queries";
import { isHostLive } from "../../host/hostModel";
import { Button } from "../../ui";
import { ConfirmApplyDialog } from "../ConfirmApplyDialog";
import { CardShell, CardStatus } from "./CardShell";
import { copyText, useCheckedCard, useFlash } from "./useCardActions";
import type { CardViewProps } from "./withFields";

/**
 * --- slice: chat cards ---
 *
 * A map by its name inside the game.
 *
 * The picture is the levelshot out of the player's own archives, when one of
 * them has the map. While the player's private server runs in the map's game,
 * **Play on my server** changes its map; otherwise **Host on this map**
 * starts one with the last settings of the Play with friends screen and this
 * map, in a mode the map offers. Both ask first: a card never starts a server
 * or moves the players of one by itself.
 */
export function MapCardView({ card, fields }: CardViewProps<"map">) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const games = useGameNames();
  const levelshot = useLevelshot(fields.name, fields.game);
  const session = useHostSession().data ?? null;
  const check = useCheckedCard();
  const [copied, flashCopied] = useFlash();
  const [asking, setAsking] = useState<"change" | "host" | null>(null);
  const [broken, setBroken] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const running = isHostLive(session) && session.status === "running" && session.game === fields.game;
  // A server that starts, stops, or runs the other game: the card neither
  // moves it nor starts a second one.
  const blocked = isHostLive(session) && !running;
  const blockedText =
    blocked && session?.status === "running" ? t("cards.map.otherGame") : t("cards.map.busy");
  const url = levelshot.data ? levelshotUrl(levelshot.data.path) : null;
  const title = fields.title ?? fields.name;

  return (
    <>
      <CardShell
        label={t("cards.label", { kind: t("cards.kinds.map"), title })}
        media={
          <div className="flex h-120 items-center justify-center overflow-hidden border-b border-line-subtle bg-gradient-to-br from-line-strong to-accent-subtle">
            {url !== null && !broken ? (
              <img src={url} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover" />
            ) : (
              <span className="flex flex-col items-center gap-4 text-body-sm text-fg-secondary">
                <MapIcon size={20} aria-hidden="true" />
                {t("cards.map.noPicture")}
              </span>
            )}
          </div>
        }
        icon={<MapIcon size={16} />}
        title={title}
        titleText={title}
        subtitle={
          <span>
            <span className="text-mono-xs text-fg-secondary">{fields.name}</span>
            {" · "}
            {games.short(fields.game)}
          </span>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              icon={running ? <Play size={14} /> : <Server size={14} />}
              disabled={check.checking || blocked}
              onClick={() =>
                check.run(card, (clean) => {
                  if (clean.type === "map") setAsking(running ? "change" : "host");
                })
              }
            >
              {running ? t("cards.map.play") : t("cards.map.host")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={14} />}
              onClick={() => void copyText(fields.name).then((ok) => ok && flashCopied())}
            >
              {copied ? t("cards.copied") : t("cards.map.copy")}
            </Button>
          </>
        }
        status={
          check.error ? (
            <CardStatus tone="danger">{errorText(check.error)}</CardStatus>
          ) : done !== null ? (
            <CardStatus tone="success">{done}</CardStatus>
          ) : blocked ? (
            <CardStatus>{blockedText}</CardStatus>
          ) : null
        }
      />
      {asking === "change" && session !== null ? (
        <ChangeMapDialog
          fields={fields}
          gametype={session.settings.gametype}
          onClose={() => setAsking(null)}
          onDone={() => {
            setAsking(null);
            setDone(t("cards.map.changed", { map: fields.name }));
          }}
        />
      ) : null}
      {asking === "host" ? (
        <HostMapDialog
          fields={fields}
          onClose={() => setAsking(null)}
          onDone={() => {
            setAsking(null);
            setDone(t("cards.map.started", { map: fields.name }));
          }}
        />
      ) : null}
    </>
  );
}

/** **Play on my server**: the running server moves to the map, in the mode it runs. */
function ChangeMapDialog({
  fields,
  gametype,
  onClose,
  onDone,
}: {
  fields: MapCardFields;
  gametype: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const labels = useGametypeLabels();
  const change = useChangeHostMap();
  return (
    <ConfirmApplyDialog
      title={t("cards.map.changeTitle", { map: fields.name })}
      body={t("cards.map.changeBody", { mode: labels.label(fields.game, gametype) })}
      confirmLabel={t("cards.map.changeConfirm")}
      pending={change.isPending}
      error={change.error ? errorText(change.error) : null}
      onCancel={onClose}
      onConfirm={() => change.mutate({ map: fields.name, gametype }, { onSuccess: onDone })}
    />
  );
}

/**
 * **Host on this map**: the last settings of the Play with friends screen of
 * the map's game, this map, and the mode of those settings when the map
 * offers it, else the first mode it offers. A map the client of those
 * settings does not have cannot be hosted, and the dialog says so.
 */
function HostMapDialog({
  fields,
  onClose,
  onDone,
}: {
  fields: MapCardFields;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const labels = useGametypeLabels();
  const options = useHostOptions(fields.game);
  const defaults = options.data?.defaults ?? null;
  const clientId = defaults?.clientId ?? null;
  const maps = useHostMaps(clientId === "" ? null : clientId);
  const start = useStartHost();

  const map = maps.data?.find((entry) => entry.name.toLowerCase() === fields.name.toLowerCase()) ?? null;
  const client = options.data?.clients.find((entry) => entry.id === clientId) ?? null;
  const offered = (options.data?.gametypes ?? []).filter((mode) => map?.gametypes.includes(mode.id) ?? false);
  const mode = offered.find((entry) => entry.index === defaults?.gametype) ?? offered[0] ?? null;
  // A query that never runs — no client to read maps of — stays pending.
  const loading = options.isPending || (client !== null && maps.isPending);
  const ready = defaults !== null && map !== null && mode !== null && client?.canHost === true;

  const body = loading
    ? t("cards.map.hostLoading")
    : client === null || !client.canHost
      ? t("cards.map.hostNoClient")
      : map === null
        ? t("cards.map.notInstalled", { client: client.name })
        : mode === null
          ? t("cards.map.noMode")
          : t("cards.map.hostBody", { client: client.name, mode: labels.label(fields.game, mode.index) });

  const settings: HostSettings | null =
    ready && defaults !== null && map !== null && mode !== null
      ? { ...defaults, map: map.name, gametype: mode.index, inviteUserIds: [], joinAfterStart: false }
      : null;

  return (
    <ConfirmApplyDialog
      title={t("cards.map.hostTitle", { map: fields.name })}
      body={body}
      confirmLabel={t("cards.map.hostConfirm")}
      pending={start.isPending}
      disabled={settings === null}
      error={options.error ? errorText(options.error) : start.error ? errorText(start.error) : null}
      onCancel={onClose}
      onConfirm={() => {
        if (settings !== null) start.mutate(settings, { onSuccess: onDone });
      }}
    />
  );
}

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useGametypeLabels } from "../../i18n/useGameLabels";
import type { HostSession } from "../../lib/ipc";
import { useChangeHostMap, useHostOptions } from "../../lib/queries";
import { Button, Dialog, Select } from "../ui";
import { MapPicker } from "./MapPicker";

/**
 * **Stop the server?** — asked before **Stop server** when people are on it.
 *
 * The count is people, bots aside: a bot has nothing to lose.
 */
export function StopServerDialog({
  players,
  onStop,
  onClose,
  stopping,
}: {
  players: number;
  onStop: () => void;
  onClose: () => void;
  stopping: boolean;
}) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  return (
    <Dialog
      title={t("stopDialog.title")}
      body={t("stopDialog.text", { count: players })}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button variant="danger" disabled={stopping} onClick={onStop}>
            {stopping ? t("starting.stopping") : t("stopDialog.stop")}
          </Button>
        </>
      }
    />
  );
}

/**
 * **Change map**: a game type and a map of the running server's client.
 *
 * The players stay: the engine moves everyone to the new map without a
 * reconnect. The map list is the same field as on the Setup form, so a map
 * from the client's library carries its badge here too.
 */
export function ChangeMapDialog({
  session,
  onClose,
}: {
  session: HostSession;
  onClose: () => void;
}) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const labels = useGametypeLabels();
  const options = useHostOptions(session.game);
  const change = useChangeHostMap();
  const [gametype, setGametype] = useState(session.settings.gametype);
  const [map, setMap] = useState(session.settings.map);
  const onMap = useCallback((next: string) => setMap(next), []);

  const gametypes = options.data?.gametypes ?? [];
  const unchanged = gametype === session.settings.gametype && map === session.settings.map;

  return (
    <Dialog
      title={t("changeMap.title")}
      body={t("changeMap.text")}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={unchanged || map === "" || change.isPending}
            onClick={() => change.mutate({ map, gametype }, { onSuccess: onClose })}
          >
            {t("changeMap.apply")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12 pt-16">
        <label className="flex flex-col gap-6">
          <span className="text-label-xs text-fg-muted">{t("setup.gametype.label")}</span>
          <Select
            value={String(gametype)}
            onChange={(value) => setGametype(Number(value))}
            options={gametypes.map((entry) => ({
              value: String(entry.index),
              label: labels.label(session.game, entry.index, entry.label),
            }))}
            ariaLabel={t("setup.gametype.label")}
            className="w-full"
          />
        </label>
        <div className="flex flex-col gap-6">
          <span className="text-label-xs text-fg-muted">{t("setup.map.label")}</span>
          <MapPicker
            clientId={session.settings.clientId}
            gametype={gametype}
            value={map}
            onChange={onMap}
            preferred={session.settings.map}
            className="w-full"
          />
        </div>
        {change.error ? (
          <p className="text-body-sm text-fg-danger">{errorText(change.error)}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

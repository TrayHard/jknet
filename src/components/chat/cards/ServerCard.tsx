import { Copy, Lock, Play, Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useGametypeLabels } from "../../../i18n/useGameLabels";
import { useConnectClient, useGameNames } from "../../../lib/game";
import { useLaunchClient, useServerStatus } from "../../../lib/queries";
import { ColoredNickname } from "../../client/ColoredNickname";
import { Button } from "../../ui";
import { CardShell, CardStatus } from "./CardShell";
import { copyText, useCheckedCard, useFlash } from "./useCardActions";
import type { CardViewProps } from "./withFields";

/**
 * --- slice: chat cards ---
 *
 * A game server anyone can join by its address.
 *
 * The card asks the server itself how it is doing — the map, the mode, the
 * players, a password — the way the details panel of the Servers screen
 * does, so what it shows is now, not what the sender saw. **Join** starts
 * the client **Connect** would pick for that address; **Copy address** is
 * for a friend who plays without JKNet.
 */
export function ServerCardView({ card, fields }: CardViewProps<"server">) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const labels = useGametypeLabels();
  const games = useGameNames();
  const status = useServerStatus(fields.address, fields.game);
  const connectClient = useConnectClient(fields.game);
  const launch = useLaunchClient();
  const check = useCheckedCard();
  const [copied, flashCopied] = useFlash();

  const client = connectClient(fields.address);
  const info = status.data?.info ?? null;
  const map = info?.mapname ?? fields.map;
  const gametype = info?.g_gametype !== undefined ? Number(info.g_gametype) : fields.gametype;
  const humans = status.data ? status.data.players.filter((player) => !player.isBot).length : null;
  const max = info?.sv_maxclients !== undefined ? Number(info.sv_maxclients) : null;
  const needpass = info?.g_needpass === "1";

  const facts: string[] = [];
  if (map) facts.push(map);
  if (gametype !== null && Number.isFinite(gametype)) facts.push(labels.label(fields.game, gametype));
  if (humans !== null && max !== null && Number.isFinite(max)) {
    facts.push(t("cards.server.players", { players: humans, max }));
  }
  if (fields.mod) facts.push(fields.mod);

  const join = () => {
    if (client === undefined) return;
    launch.reset();
    check.run(card, (clean) => {
      if (clean.type === "server") launch.mutate({ clientId: client.id, connect: clean.fields.address });
    });
  };

  const busy = launch.isPending || check.checking;
  const failure = launch.error ?? check.error;
  const noClient = t("cards.noClient", { game: games.label(fields.game) });

  return (
    <CardShell
      label={t("cards.label", { kind: t("cards.kinds.server"), title: fields.address })}
      icon={<Server size={16} />}
      title={<ColoredNickname raw={fields.name} placeholder={fields.address} />}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-8">
          <span className="text-mono-xs text-fg-secondary">{fields.address}</span>
          {needpass ? (
            <span className="inline-flex items-center gap-4 text-fg-warm">
              <Lock size={12} aria-hidden="true" />
              {t("cards.server.password")}
            </span>
          ) : null}
        </span>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            icon={<Play size={14} />}
            disabled={client === undefined || busy}
            title={client === undefined ? noClient : undefined}
            onClick={join}
          >
            {busy ? t("cards.server.joining") : t("cards.server.join")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy size={14} />}
            onClick={() => void copyText(fields.address).then((done) => done && flashCopied())}
          >
            {copied ? t("cards.copied") : t("cards.server.copy")}
          </Button>
        </>
      }
      status={
        failure ? (
          <CardStatus tone="danger">{errorText(failure)}</CardStatus>
        ) : client === undefined ? (
          <CardStatus>{noClient}</CardStatus>
        ) : null
      }
    >
      <p className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">
        {status.isPending
          ? t("cards.server.checking")
          : status.isError
            ? t("cards.server.offline")
            : facts.join(" · ")}
      </p>
    </CardShell>
  );
}

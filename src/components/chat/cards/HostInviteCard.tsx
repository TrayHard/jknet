import { Globe, LogIn, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useGametypeLabels } from "../../../i18n/useGameLabels";
import { useChatMeId, useFriendPresence, useHostSession, useJoinHostCard } from "../../../lib/queries";
import { Button } from "../../ui";
import { useChatNames } from "../useChatText";
import { CardShell, CardStatus } from "./CardShell";
import { useCheckedCard } from "./useCardActions";
import type { CardViewProps } from "./withFields";

/**
 * --- slice: chat cards ---
 *
 * The private server its sender hosts: an invitation into it.
 *
 * The card carries no address and no password: the service wrote the host,
 * the game, the map and the mode into it from the live hosting, and **Join**
 * asks the core to go through the host's invite, or through the friends list
 * where the server is open to me (`chat_join_host_card`). Whether the server
 * still runs is read from the host's presence, which is the service's word
 * for it; a server that stopped leaves the card with nothing to join.
 */
export function HostInviteCardView({ card, fields }: CardViewProps<"hostInvite">) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const labels = useGametypeLabels();
  const names = useChatNames();
  const meId = useChatMeId();
  const presence = useFriendPresence(fields.hostId);
  const ownSession = useHostSession().data ?? null;
  const join = useJoinHostCard();
  const check = useCheckedCard();

  const mine = fields.hostId !== null && fields.hostId === meId;
  const hosting = presence?.hosting ?? null;
  const live = mine
    ? ownSession !== null && ownSession.id === fields.sessionId && ownSession.status === "running"
    : hosting !== null && hosting.sessionId === fields.sessionId;
  const hostName = fields.hostId === null ? null : names.personName(fields.hostId);
  const title = fields.name ?? (hostName === null ? t("cards.hostInvite.untitled") : t("cards.hostInvite.hostServer", { name: hostName }));

  const facts: string[] = [];
  if (hostName !== null && !mine) facts.push(t("cards.hostInvite.host", { name: hostName }));
  const map = mine ? ownSession?.settings.map ?? fields.map : hosting?.map ?? fields.map;
  if (map) facts.push(map);
  const gametype = mine ? ownSession?.settings.gametype ?? fields.gametype : hosting?.gametype ?? fields.gametype;
  const game = fields.game ?? hosting?.game ?? ownSession?.game ?? null;
  if (gametype !== null && game !== null) facts.push(labels.label(game, gametype));
  if (!mine && hosting !== null && live) {
    facts.push(t("cards.server.players", { players: hosting.players, max: hosting.maxPlayers }));
  }

  const route =
    !mine && live && hosting !== null
      ? hosting.relayAddress != null
        ? { icon: <Globe size={14} aria-hidden="true" />, text: t("cards.hostInvite.relay") }
        : hosting.lanAddresses.length > 0
          ? { icon: <Wifi size={14} aria-hidden="true" />, text: t("cards.hostInvite.lan") }
          : null
      : null;

  const onJoin = () => {
    join.reset();
    check.run(card, (clean) => {
      if (clean.type !== "hostInvite" || clean.fields.hostId === null) return;
      join.mutate({ hostId: clean.fields.hostId, sessionId: clean.fields.sessionId });
    });
  };

  const busy = join.isPending || check.checking;
  const failure = join.error ?? check.error;

  return (
    <CardShell
      label={t("cards.label", { kind: t("cards.kinds.hostInvite"), title })}
      icon={<LogIn size={16} />}
      title={title}
      titleText={title}
      subtitle={mine ? t("cards.hostInvite.mine") : t("cards.kinds.hostInvite")}
      actions={
        mine || fields.hostId === null ? null : (
          <Button
            size="sm"
            variant="primary"
            icon={<LogIn size={14} />}
            disabled={!live || busy}
            onClick={onJoin}
          >
            {busy ? t("cards.server.joining") : t("cards.hostInvite.join")}
          </Button>
        )
      }
      status={
        failure ? (
          <CardStatus tone="danger">{errorText(failure)}</CardStatus>
        ) : join.isSuccess ? (
          <CardStatus tone="success">{t("cards.hostInvite.joined")}</CardStatus>
        ) : !live ? (
          <CardStatus>{t("cards.hostInvite.stopped")}</CardStatus>
        ) : null
      }
    >
      {facts.length > 0 ? (
        <p className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">{facts.join(" · ")}</p>
      ) : null}
      {route !== null ? (
        <p className="flex items-center gap-6 text-body-sm text-fg-muted">
          {route.icon}
          {route.text}
        </p>
      ) : null}
    </CardShell>
  );
}

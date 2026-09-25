import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { HostPlayer } from "../../lib/ipc";
import { Ping } from "../servers/Ping";
import { ServerName } from "../servers/ServerName";
import { Badge } from "../ui";

/** Colour codes out of a name, for its tooltip. */
function clean(name: string): string {
  return name.replace(/\^[0-9]/g, "");
}

/**
 * The PlayerRow of the design: the name in the game's colours, the score and
 * the ping, with the **Bot** badge instead of a ping for a bot.
 *
 * The name, the score and the ping are data the player may copy, so the row
 * keeps them selectable.
 */
export function PlayerRow({ player }: { player: HostPlayer }) {
  const { t } = useTranslation("host");
  return (
    <li className="flex items-center gap-12 h-40 px-12 rounded-md">
      <span className="flex-1 min-w-0 flex items-center gap-8">
        <ServerName
          raw={player.name}
          clean={clean(player.name)}
          className="text-body-md-medium text-fg"
        />
        {player.bot ? (
          <Badge icon={<Bot size={12} />} className="shrink-0">
            {t("running.players.bot")}
          </Badge>
        ) : null}
      </span>
      <span className="w-48 shrink-0 text-right text-mono-sm text-fg-secondary tabular-nums">
        {player.score}
      </span>
      <Ping ms={player.bot ? null : player.ping} className="w-72 shrink-0 justify-end" />
    </li>
  );
}

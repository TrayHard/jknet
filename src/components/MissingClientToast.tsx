import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useGameNames } from "../lib/game";
import type { Game } from "../lib/ipc";
import { useToasts } from "./ToastsProvider";
import { Button } from "./ui";

/**
 * The search parameter that opens the New client dialog on the Clients screen.
 *
 * It lives here rather than on the screen it opens, because the toast below is
 * the thing that needs to name it and a screen importing a component is the
 * direction the imports already run.
 */
export const NEW_CLIENT_PARAM = "new";

/**
 * The search parameter that says which game the new client is for.
 *
 * Review finding (Low): the toast knows the game — it is in its own title —
 * but used to send the player to a dialog that started on the game of the
 * sidebar. A friend on a Jedi Outcast server while the sidebar shows Jedi
 * Academy is exactly the case the toast exists for, so the game travels with
 * the route.
 */
export const NEW_CLIENT_GAME_PARAM = "game";

/**
 * The toast for «you have no client of this game».
 *
 * Two screens run into the same wall: **Connect** on a server row and **Join
 * game** on a friend both need a client of the game the address belongs to, and
 * a player who owns two games can easily have one for Jedi Academy and none for
 * Jedi Outcast. The message names the game — «no client» alone would read as a
 * launcher that had forgotten the clients on the other segment — and its button
 * goes straight to the dialog that fixes it.
 *
 * A toast rather than a disabled button: the press was a reasonable thing to
 * do, and the answer is a step to take, not a refusal to explain.
 */
export function useMissingClientToast(): (game: Game) => void {
  const { t } = useTranslation("clients");
  const navigate = useNavigate();
  const toasts = useToasts();
  const { label } = useGameNames();
  const show = toasts.show;
  const dismiss = toasts.dismiss;

  return useCallback(
    (game: Game) => {
      const id = `missing-client:${game}`;
      show(id, {
        title: t("missingToast.title", { game: label(game) }),
        text: t("missingToast.text", { game: label(game) }),
        action: (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              dismiss(id);
              void navigate(
                `/clients?${NEW_CLIENT_PARAM}=1&${NEW_CLIENT_GAME_PARAM}=${game}`,
              );
            }}
          >
            {t("missingToast.action")}
          </Button>
        ),
      });
    },
    [dismiss, label, navigate, show, t],
  );
}

import { Gamepad2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// --- slice: play with friends ---
import { useErrorText } from "../i18n/errors";
import { gameFromServerAddress, resolveDefaultClientId } from "../lib/game";
import type { Invite } from "../lib/ipc";
import {
  // --- slice: play with friends ---
  useAcceptInvite,
  useDismissInvite,
  useFriendsEvents,
  useFriendsState,
  useGames,
  useOnlineConfigured,
  useRunningGame,
  useSettings,
} from "../lib/queries";
// --- slice: play with friends ---
import { useJoinToast } from "./host/joinToast";
import { useToasts } from "./ToastsProvider";
import { Button } from "./ui";

/**
 * Holds the one subscription to the `friends:*` events, and turns an
 * invitation into a toast.
 *
 * Above the router, next to `GameEventsProvider`: an invitation arrives while
 * the player is on any screen, and the answer to it — starting the game — has
 * to survive the navigation that answering it causes.
 *
 * The toasts are drawn from the invite list rather than from the arrival
 * event. The list is the state the core keeps; the event only makes it appear
 * a few seconds sooner. That way an invitation sent while the launcher was
 * closed still greets the player when it opens, and a dismissed one does not
 * come back on the next refresh.
 *
 * With the service switched off there is no list, no subscription and no toast:
 * `useFriendsEvents` and `useFriendsState` both stand down, and the invites
 * below are read as none whatever the query cache still holds.
 *
 * --- slice: play with friends ---
 * **Join** answers through `accept_invite`: the core picks the client of the
 * invite's game, finds the way to a private server — the host's network first,
 * then the relay — and passes the password. The toast that follows says which
 * way the game went.
 */
export function FriendsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("friends");
  useFriendsEvents();
  const configured = useOnlineConfigured();
  const friends = useFriendsState();
  const settings = useSettings();
  const games = useGames().data;
  const running = useRunningGame();
  const toasts = useToasts();
  const dismiss = useDismissInvite();
  // --- slice: play with friends ---
  const accept = useAcceptInvite();
  const joinToast = useJoinToast();
  const errorText = useErrorText();

  // Which invitations have a toast on screen. A ref, not state: the effect
  // below writes it on every pass and must not re-run because it did.
  const shown = useRef(new Set<string>());
  // --- slice: play with friends ---
  // Invitations answered with **Join**: the toast is gone, and the next pass
  // must not bring it back before the invitation is dismissed on the service.
  // The set is never emptied on purpose. A dismissal that fails leaves the
  // invitation on the service, and a second toast for an invitation the player
  // already answered would read as a new one; the service drops it by itself
  // ten minutes after it was made.
  const answered = useRef(new Set<string>());

  const invites = configured === false ? undefined : friends.data?.invites;
  const gameRunning = running.data != null;
  const { show, dismiss: hide } = toasts;
  const dismissInvite = dismiss.mutate;
  const acceptInvite = accept.mutateAsync;
  const document = settings.data;

  useEffect(() => {
    const pending = (invites ?? []).filter((invite) => !answered.current.has(invite.id));
    const alive = new Set(pending.map((invite) => invite.id));

    // An invitation that expired, was accepted or was dismissed elsewhere
    // takes its toast with it.
    for (const id of shown.current) {
      if (!alive.has(id)) {
        hide(toastId(id));
        shown.current.delete(id);
      }
    }

    for (const invite of pending) {
      shown.current.add(invite.id);
      // --- slice: play with friends --- the client is the default one of
      // the invite's game: a private server names it, an ordinary one is
      // read off its port.
      const game = invite.hosting?.game ?? gameFromServerAddress(invite.serverAddress, games);
      const noClient = resolveDefaultClientId(document, game) === null;
      show(toastId(invite.id), {
        title: t("invite.toast", {
          name: invite.from.displayName,
          server: where(invite),
        }),
        text: invite.message ?? undefined,
        // Closing the toast drops the invitation on the service as well, or the
        // next refresh of the list would bring the same toast straight back.
        onDismiss: () => dismissInvite(invite.id),
        action: (
          <Button
            size="sm"
            variant="primary"
            icon={<Gamepad2 size={14} />}
            disabled={noClient || gameRunning}
            title={
              noClient
                ? t("invite.noClient")
                : gameRunning
                  ? t("invite.gameRunning")
                  : t("invite.connectTo", { address: invite.serverAddress })
            }
            onClick={() => {
              // The invitation is spent whether or not the game starts: a
              // toast that stays after a failed launch cannot be told apart
              // from one that has not been answered. It is dismissed once the
              // core has answered, because the answer reads the invitation.
              answered.current.add(invite.id);
              hide(toastId(invite.id));
              shown.current.delete(invite.id);
              // A promise per answer: the callbacks of `mutate` run for the
              // last call only, and each answered invitation needs its own
              // toast and its own dismissal.
              void acceptInvite(invite.id)
                .then((result) =>
                  joinToast(result, {
                    hostName: invite.from.displayName,
                    serverName: invite.serverName,
                    hosting: invite.hosting,
                  }),
                )
                .catch((error: unknown) =>
                  show(`invite-failed:${invite.id}`, {
                    variant: "error",
                    title: t("invite.toast", {
                      name: invite.from.displayName,
                      server: where(invite),
                    }),
                    text: errorText(error),
                  }),
                )
                .finally(() => dismissInvite(invite.id));
            }}
          >
            {t("invite.join")}
          </Button>
        ),
      });
    }
  }, [
    invites,
    document,
    games,
    gameRunning,
    show,
    hide,
    dismissInvite,
    acceptInvite,
    joinToast,
    errorText,
    t,
  ]);

  return <>{children}</>;
}

/** The toast key of an invitation: one toast per invitation, ever. */
function toastId(inviteId: string): string {
  return `invite:${inviteId}`;
}

/** The server as the toast names it: the host name, or the bare address. */
function where(invite: Invite): string {
  return invite.serverName ?? invite.serverAddress;
}

import { Gamepad2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Invite } from "../lib/ipc";
import {
  useDismissInvite,
  useFriendsEvents,
  useFriendsState,
  useOnlineConfigured,
  useLaunchClient,
  useRunningGame,
  useSettings,
} from "../lib/queries";
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
 */
export function FriendsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("friends");
  useFriendsEvents();
  const configured = useOnlineConfigured();
  const friends = useFriendsState();
  const settings = useSettings();
  const running = useRunningGame();
  const toasts = useToasts();
  const dismiss = useDismissInvite();
  const launch = useLaunchClient();

  // Which invitations have a toast on screen. A ref, not state: the effect
  // below writes it on every pass and must not re-run because it did.
  const shown = useRef(new Set<string>());

  const invites = configured === false ? undefined : friends.data?.invites;
  const defaultClientId = settings.data?.defaultClientId ?? null;
  const gameRunning = running.data != null;
  const { show, dismiss: hide } = toasts;
  const dismissInvite = dismiss.mutate;
  const launchClient = launch.mutate;

  useEffect(() => {
    const pending = invites ?? [];
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
            disabled={defaultClientId === null || gameRunning}
            title={
              defaultClientId === null
                ? t("invite.noClient")
                : gameRunning
                  ? t("invite.gameRunning")
                  : t("invite.connectTo", { address: invite.serverAddress })
            }
            onClick={() => {
              if (defaultClientId === null) return;
              // The invitation is spent whether or not the game starts: a
              // toast that stays after a failed launch cannot be told apart
              // from one that has not been answered.
              dismissInvite(invite.id);
              launchClient({
                clientId: defaultClientId,
                connect: invite.serverAddress,
              });
            }}
          >
            {t("invite.join")}
          </Button>
        ),
      });
    }
  }, [invites, defaultClientId, gameRunning, show, hide, dismissInvite, launchClient, t]);

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

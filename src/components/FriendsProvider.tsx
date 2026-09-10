import { Gamepad2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type { Invite } from "../lib/ipc";
import {
  useDismissInvite,
  useFriendsEvents,
  useFriendsState,
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
 */
export function FriendsProvider({ children }: { children: ReactNode }) {
  useFriendsEvents();
  const friends = useFriendsState();
  const settings = useSettings();
  const running = useRunningGame();
  const toasts = useToasts();
  const dismiss = useDismissInvite();
  const launch = useLaunchClient();

  // Which invitations have a toast on screen. A ref, not state: the effect
  // below writes it on every pass and must not re-run because it did.
  const shown = useRef(new Set<string>());

  const invites = friends.data?.invites;
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
        title: `${invite.from.displayName} invites you to ${where(invite)}`,
        text: invite.message ?? undefined,
        // Closing the toast drops the invitation on the hub as well, or the
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
                ? "Pick a default client on the Clients screen first"
                : gameRunning
                  ? "A game is already running"
                  : `Connect to ${invite.serverAddress}`
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
            Join
          </Button>
        ),
      });
    }
  }, [invites, defaultClientId, gameRunning, show, hide, dismissInvite, launchClient]);

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

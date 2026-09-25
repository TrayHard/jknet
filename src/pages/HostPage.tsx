import { Monitor, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import { ChangeMapDialog, StopServerDialog } from "../components/host/HostDialogs";
import { HostFailed } from "../components/host/HostFailed";
import { HostRunning } from "../components/host/HostRunning";
import { HostSetup } from "../components/host/HostSetup";
import { HostStarting } from "../components/host/HostStarting";
import { HostStopped } from "../components/host/HostStopped";
import {
  formFromSettings,
  HOST_INVITE_PARAM,
  hostView,
  humanCount,
  settingsToStart,
  toggleId,
  type HostForm,
} from "../components/host/hostModel";
import { InvitePanel, type InvitePanelMode } from "../components/host/InvitePanel";
import { useNow } from "../components/host/useNow";
import { PageHeader } from "../components/PageHeader";
import { Button, EmptyState } from "../components/ui";
import { useErrorText } from "../i18n/errors";
import { newHostPassword, type Game, type HostJoinPolicy, type HostSettings } from "../lib/ipc";
import {
  useAccountState,
  useFriendsState,
  useHostInvite,
  useHostOptions,
  useHostSession,
  useJoinOwnServer,
  useOnlineConfigured,
  useOpenHostLog,
  useRetryHostRelay,
  useRunningGame,
  useSetHostJoinPolicy,
  useStartHost,
  useStopHost,
} from "../lib/queries";

/**
 * **Play with friends**: a private server on this PC, and the friends it is for.
 *
 * One screen, five cards, picked by the session the core holds: the form
 * before a start, the steps while it starts, the server while it runs, and a
 * stopped or failed server with the way back. The **Invite friends** panel on
 * the right stays through all of them; before a start it marks who gets an
 * invite once the server is ready, while the server runs it invites.
 *
 * The form lives here, not in the card, so **Back to settings** and **Change
 * settings** return to what the player typed rather than to the defaults.
 */
export function HostPage() {
  const { t } = useTranslation("host");
  const { t: tAccount } = useTranslation("account");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();

  const session = useHostSession().data ?? null;
  const options = useHostOptions();
  const account = useAccountState();
  const configured = useOnlineConfigured();
  const friendsState = useFriendsState();
  const running = useRunningGame();

  const start = useStartHost();
  const stop = useStopHost();
  const joinOwn = useJoinOwnServer();
  const setPolicy = useSetHostJoinPolicy();
  const retryRelay = useRetryHostRelay();
  const invite = useHostInvite();
  const openLog = useOpenHostLog();

  const [form, setForm] = useState<HostForm | null>(null);
  const [formGame, setFormGame] = useState<Game | null>(null);
  /** The stopped or failed session the player walked back to the form from. */
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [changingMap, setChangingMap] = useState(false);
  /** Invites this screen sent that the next `host:session` has not listed yet. */
  const [sentAt, setSentAt] = useState<Record<string, string>>({});
  /** Friends marked while the server was starting: invited once it runs. */
  const [lateMarks, setLateMarks] = useState<string[]>([]);
  /**
   * The last invite that failed. Kept here, not read off the mutation: several
   * invites can be on their way at once, and the state of the mutation is the
   * state of the last one only, so a failure followed by a success would vanish.
   */
  const [inviteFailure, setInviteFailure] = useState<unknown>(null);

  // --- the form ---------------------------------------------------------------

  // The defaults arrive with a fresh password on every read, so the form is
  // filled once per game and kept after that.
  const inviteParam = search.get(HOST_INVITE_PARAM);
  useEffect(() => {
    const data = options.data;
    if (data === undefined || (form !== null && formGame === data.game)) return;
    const next = formFromSettings(data.defaults, newHostPassword());
    if (inviteParam !== null && !next.settings.inviteUserIds.includes(inviteParam)) {
      next.settings.inviteUserIds = [...next.settings.inviteUserIds, inviteParam];
    }
    setForm(next);
    setFormGame(data.game);
    // **Host and invite** is a one-off: the mark is in the form now, and a
    // reload must not bring it back after the player took it off.
    if (inviteParam !== null) {
      setSearch(
        (current) => {
          const copy = new URLSearchParams(current);
          copy.delete(HOST_INVITE_PARAM);
          return copy;
        },
        { replace: true },
      );
    }
  }, [options.data, form, formGame, inviteParam, setSearch]);

  // --- which card -------------------------------------------------------------

  let view = hostView(session);
  if ((view === "stopped" || view === "failed") && session !== null && setupFor === session.id) {
    view = "setup";
  }
  const live = view === "starting" || view === "running";
  const now = useNow(1000, live);
  const gameRunning = running.data != null;

  // --- the account and the friends ----------------------------------------------

  const relayReason = options.data?.relay.reason ?? null;
  const serviceOff = configured === false || relayReason === "not_configured";
  const signedIn =
    account.data !== undefined
      ? account.data.onlineSignedIn
      : friendsState.data !== undefined
        ? friendsState.data.signedIn
        : relayReason !== "signed_out";
  const friends = useMemo(
    () => (friendsState.data?.signedIn ? friendsState.data.friends : []),
    [friendsState.data],
  );

  const panelMode: InvitePanelMode = serviceOff
    ? "off"
    : !signedIn
      ? "signedOut"
      : view === "running"
        ? "live"
        : "select";

  // --- friends marked while starting ---------------------------------------------

  // A friend marked on the Starting card joins the invites of the core the
  // moment the server is ready. The ref keeps one session from inviting twice
  // when a later `host:session` arrives before the invites have settled.
  const lateSentFor = useRef<string | null>(null);
  // A promise per invite rather than the callbacks of `mutate`: those run for
  // the last call only, and two quick presses would lose the first **Invited**.
  const inviteAsync = invite.mutateAsync;
  const sendInvite = useCallback(
    (userId: string) => {
      void inviteAsync({ toUserId: userId })
        .then(() => setSentAt((current) => ({ ...current, [userId]: new Date().toISOString() })))
        .catch((error: unknown) => setInviteFailure(error));
    },
    [inviteAsync],
  );
  useEffect(() => {
    if (session === null || session.status !== "running") return;
    if (lateMarks.length === 0 || lateSentFor.current === session.id) return;
    lateSentFor.current = session.id;
    const already = new Set([
      ...session.settings.inviteUserIds,
      ...session.invited.map((entry) => entry.userId),
    ]);
    for (const userId of lateMarks) {
      if (!already.has(userId)) sendInvite(userId);
    }
    setLateMarks([]);
  }, [session, lateMarks, sendInvite]);

  // --- actions ----------------------------------------------------------------------

  const updateForm = useCallback(
    (update: (current: HostForm) => HostForm) =>
      setForm((current) => (current === null ? current : update(current))),
    [],
  );

  const fallbackName = options.data?.defaults.serverName ?? "";

  const startWith = (settings: HostSettings) => {
    setLateMarks([]);
    setSentAt({});
    setInviteFailure(null);
    start.mutate(settings, { onSuccess: () => setSetupFor(null) });
  };

  const onStart = (joinAfterStart: boolean) => {
    if (form === null) return;
    startWith(settingsToStart(form, fallbackName, joinAfterStart));
  };

  /** **Start again**: the settings the server ran with, the panel's marks and door. */
  const onStartAgain = () => {
    if (session === null) return;
    startWith({
      ...session.settings,
      joinPolicy: form?.settings.joinPolicy ?? session.settings.joinPolicy,
      joinUserIds: form?.settings.joinUserIds ?? session.settings.joinUserIds,
      inviteUserIds: form?.settings.inviteUserIds ?? [],
    });
  };

  /** **Change settings** and **Back to settings**: the form, filled with the last run. */
  const backToSetup = () => {
    if (session === null) return;
    setForm((current) => ({
      ...formFromSettings(session.settings, current?.password ?? newHostPassword()),
      settings: {
        ...session.settings,
        joinPolicy: current?.settings.joinPolicy ?? session.settings.joinPolicy,
        joinUserIds: current?.settings.joinUserIds ?? session.settings.joinUserIds,
        inviteUserIds: current?.settings.inviteUserIds ?? [],
      },
    }));
    setSetupFor(session.id);
  };

  const onStop = () => {
    if (session !== null && humanCount(session.players) > 0) setConfirmStop(true);
    else stop.mutate();
  };

  const onPolicyChange = (policy: HostJoinPolicy, joinUserIds: string[]) => {
    if (panelMode === "live") {
      setPolicy.mutate({ joinPolicy: policy, joinUserIds });
      return;
    }
    setForm((current) =>
      current === null
        ? current
        : { ...current, settings: { ...current.settings, joinPolicy: policy, joinUserIds } },
    );
  };

  const lockedMarks = view === "starting" && session !== null ? session.settings.inviteUserIds : [];
  const marked = view === "starting" ? lateMarks : (form?.settings.inviteUserIds ?? []);
  const onToggleMark = (userId: string) => {
    if (view === "starting") {
      setLateMarks((current) => toggleId(current, userId));
      return;
    }
    setForm((current) =>
      current === null
        ? current
        : {
            ...current,
            settings: {
              ...current.settings,
              inviteUserIds: toggleId(current.settings.inviteUserIds, userId),
            },
          },
    );
  };

  const onInvite = (userId: string) => {
    setInviteFailure(null);
    sendInvite(userId);
  };

  const policySource =
    panelMode === "live" && session !== null ? session.settings : (form?.settings ?? null);

  // --- render ----------------------------------------------------------------------

  const header = <PageHeader title={t("title")} subtitle={t("subtitle")} />;

  if (options.isError && session === null) {
    return (
      <div className="flex flex-col h-full p-24">
        {header}
        <p className="text-body-sm text-fg-danger">{errorText(options.error)}</p>
      </div>
    );
  }

  if (view === "setup" && options.data !== undefined && options.data.clients.every((c) => !c.canHost)) {
    return (
      <div className="flex flex-col h-full p-24">
        {header}
        <div className="flex flex-1 items-center justify-center pb-48">
          <EmptyState
            icon={<Server size={24} />}
            title={t("noClient.title")}
            text={t("noClient.text")}
            action={
              <Button icon={<Monitor size={16} />} onClick={() => void navigate("/clients")}>
                {t("noClient.action")}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const actionError =
    stop.error ?? joinOwn.error ?? setPolicy.error ?? retryRelay.error ?? inviteFailure ?? null;

  let main: ReactNode = null;
  if (view === "setup") {
    main =
      options.data === undefined || form === null ? (
        <p className="text-body-sm text-fg-muted">{t("loading")}</p>
      ) : (
        <HostSetup
          options={options.data}
          form={form}
          onChange={updateForm}
          signedIn={signedIn}
          gameRunning={gameRunning}
          starting={start.isPending}
          error={start.error ? errorText(start.error) : null}
          onStart={onStart}
          onSignIn={() => void navigate("/settings?section=account")}
        />
      );
  } else if (view === "starting" && session !== null) {
    main = <HostStarting session={session} cancelling={stop.isPending} onCancel={() => stop.mutate()} />;
  } else if (view === "running" && session !== null) {
    main = (
      <HostRunning
        session={session}
        now={now}
        gameRunning={gameRunning}
        onPlay={() => joinOwn.mutate(undefined)}
        playing={joinOwn.isPending}
        onChangeMap={() => setChangingMap(true)}
        onStop={onStop}
        stopping={stop.isPending}
        onRetryRelay={() => retryRelay.mutate(undefined)}
        retrying={retryRelay.isPending}
      />
    );
  } else if (view === "stopped" && session !== null) {
    main = (
      <HostStopped
        session={session}
        onStartAgain={onStartAgain}
        onChangeSettings={backToSetup}
        starting={start.isPending}
        error={start.error ? errorText(start.error) : null}
      />
    );
  } else if (view === "failed" && session !== null) {
    main = <HostFailed session={session} onShowLog={() => openLog.mutate()} onBack={backToSetup} />;
  }

  return (
    <div className="flex flex-col h-full p-24">
      {header}
      <div className="flex flex-1 min-h-0 gap-24">
        <div className="flex flex-1 min-w-0 flex-col gap-12 overflow-y-auto">
          {main}
          {actionError !== null && view !== "setup" ? (
            <p className="text-body-sm text-fg-danger">{errorText(actionError)}</p>
          ) : null}
        </div>
        <InvitePanel
          mode={panelMode}
          friends={friends}
          policy={policySource?.joinPolicy ?? "friends"}
          joinUserIds={policySource?.joinUserIds ?? []}
          onPolicyChange={onPolicyChange}
          marked={marked}
          lockedMarks={lockedMarks}
          onToggleMark={onToggleMark}
          session={view === "running" ? session : null}
          onInvite={onInvite}
          inviting={invite.isPending ? (invite.variables?.toUserId ?? null) : null}
          sentAt={sentAt}
          onSignIn={() => void navigate("/settings?section=account")}
          offText={tAccount("notConfigured")}
          now={now}
        />
      </div>

      {confirmStop && session !== null ? (
        <StopServerDialog
          players={humanCount(session.players)}
          stopping={stop.isPending}
          onClose={() => setConfirmStop(false)}
          onStop={() => stop.mutate(undefined, { onSettled: () => setConfirmStop(false) })}
        />
      ) : null}
      {changingMap && session !== null ? (
        <ChangeMapDialog session={session} onClose={() => setChangingMap(false)} />
      ) : null}
    </div>
  );
}

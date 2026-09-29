import { AlertTriangle, Globe, LogOut, Monitor, Smartphone } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type { DeviceSession } from "../../lib/ipc";
import { useDeviceSessions, useRevokeSession } from "../../lib/queries";
import { Badge, type BadgeTone, Button, Dialog } from "../ui";
import {
  canSignOut,
  hasOthers,
  orderSessions,
  relativeAge,
  sessionIcon,
  sessionName,
  sessionTags,
  type SessionIcon,
  type SessionTag,
} from "./sessionsModel";

/** The anchor of the card: `#/settings?section=devices`. */
export const SESSIONS_SECTION_ID = "settings-devices";

const ICONS: Record<SessionIcon, typeof Monitor> = {
  launcher: Monitor,
  phone: Smartphone,
  desktop: Globe,
};

const TAG_TONES: Record<SessionTag, BadgeTone> = {
  thisDevice: "accent",
  online: "success",
  pushOn: "neutral",
};

/** What the open confirmation is about: one device, or every other one. */
type Confirming = { kind: "one"; session: DeviceSession } | { kind: "others" } | null;

interface SessionsCardProps {
  className?: string;
}

/**
 * --- slice: web app ---
 *
 * **Devices and sessions**: every launcher and browser signed in to the
 * account, and a way to sign any of them out from here.
 *
 * Shared by the launcher's Settings · Account, right under the Account card,
 * and the web app's sessions screen. Each row names the device as it named
 * itself at sign-in, says when it was last active and whether it is this
 * device, online or receiving push. Every row but this device's has **Sign
 * out**; signing out here stays in the Account card, whose button also
 * forgets the account on this machine. Both sign-outs ask first: the other
 * device loses its session without warning.
 *
 * The list is read when the card mounts and after every sign-out, not on a
 * timer: the service keeps these calls to a small budget.
 */
export function SessionsCard({ className }: SessionsCardProps) {
  const { t } = useTranslation("account");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const sessions = useDeviceSessions(true);
  const revoke = useRevokeSession();
  const [confirming, setConfirming] = useState<Confirming>(null);
  /** Why the last sign-out sent from here failed; the list's own failure is the query's. */
  const [refused, setRefused] = useState<unknown>(null);

  const rows = orderSessions(sessions.data ?? []);
  const failure =
    refused !== null
      ? { title: t("devices.failed"), detail: errorText(refused) }
      : sessions.isError
        ? { title: null, detail: errorText(sessions.error) }
        : null;

  const signOut = (target: { id: string } | { others: true }) => {
    setRefused(null);
    revoke.mutate(target, {
      onSuccess: () => setConfirming(null),
      onError: (e) => {
        setConfirming(null);
        setRefused(e);
      },
    });
  };

  return (
    <section
      id={SESSIONS_SECTION_ID}
      className={cn("rounded-lg border border-line bg-surface p-16 mb-24 scroll-mt-24", className)}
    >
      <h2 className="text-heading-sm text-fg pb-4">{t("devices.title")}</h2>
      <p className="text-body-sm text-fg-secondary">{t("devices.hint")}</p>

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mt-12"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="flex flex-col gap-2 min-w-0">
            {failure.title ? <span className="text-body-sm-medium text-fg">{failure.title}</span> : null}
            <span className="text-body-sm text-fg break-words">{failure.detail}</span>
          </span>
        </div>
      ) : null}

      {sessions.isPending && sessions.fetchStatus !== "idle" ? (
        <p className="text-body-sm text-fg-muted pt-12">{tCommon("states.loading")}</p>
      ) : (
        <ul className="flex flex-col pt-12">
          {rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              busy={revoke.isPending}
              onSignOut={() => {
                setRefused(null);
                setConfirming({ kind: "one", session });
              }}
            />
          ))}
        </ul>
      )}

      {rows.length > 0 ? (
        <div className="border-t border-line-subtle pt-12 mt-4">
          <Button
            icon={<LogOut size={16} />}
            disabled={!hasOthers(rows) || revoke.isPending}
            onClick={() => {
              setRefused(null);
              setConfirming({ kind: "others" });
            }}
          >
            {t("devices.signOutOthers")}
          </Button>
        </div>
      ) : null}

      {confirming !== null ? (
        <Dialog
          variant="danger"
          title={
            confirming.kind === "one"
              ? t("devices.confirmTitle", {
                  name: sessionName(confirming.session) ?? t("devices.unnamed"),
                })
              : t("devices.confirmOthersTitle")
          }
          body={confirming.kind === "one" ? t("devices.confirmBody") : t("devices.confirmOthersBody")}
          onClose={() => {
            if (!revoke.isPending) setConfirming(null);
          }}
          actions={
            <>
              <Button onClick={() => setConfirming(null)} disabled={revoke.isPending}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                icon={<LogOut size={16} />}
                disabled={revoke.isPending}
                onClick={() =>
                  signOut(confirming.kind === "one" ? { id: confirming.session.id } : { others: true })
                }
              >
                {revoke.isPending
                  ? t("danger.signingOut")
                  : confirming.kind === "one"
                    ? t("devices.signOut")
                    : t("devices.signOutOthers")}
              </Button>
            </>
          }
        />
      ) : null}
    </section>
  );
}

function SessionRow({
  session,
  busy,
  onSignOut,
}: {
  session: DeviceSession;
  busy: boolean;
  onSignOut: () => void;
}) {
  const { t } = useTranslation("account");
  const format = useFormat();
  const icon = sessionIcon(session);
  const Icon = ICONS[icon];
  const name = sessionName(session) ?? t("devices.unnamed");
  const age = relativeAge(session.lastUsedAt, Date.now());
  const time =
    age === null
      ? format.date(session.lastUsedAt)
      : new Intl.RelativeTimeFormat(format.locale, { numeric: "auto" }).format(-age.value, age.unit);

  return (
    <li className="flex flex-wrap items-center gap-12 py-12 border-t border-line-subtle first:border-t-0 first:pt-0">
      <span
        aria-hidden="true"
        data-icon={icon}
        className="flex items-center justify-center size-36 rounded-md bg-elevated text-fg-secondary shrink-0"
      >
        <Icon size={18} />
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-8 min-w-0">
          <span className="text-body-md-medium text-fg break-words min-w-0">{name}</span>
          {sessionTags(session).map((tag) => (
            <Badge key={tag} tone={TAG_TONES[tag]}>
              {t(`devices.${tag}`)}
            </Badge>
          ))}
        </span>
        <span className="text-body-sm text-fg-muted">{t("devices.lastActive", { time })}</span>
      </span>
      {canSignOut(session) ? (
        <Button size="sm" icon={<LogOut size={14} />} disabled={busy} onClick={onSignOut}>
          {t("devices.signOut")}
        </Button>
      ) : null}
    </li>
  );
}

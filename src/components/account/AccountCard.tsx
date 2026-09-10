import { AlertTriangle, Check, LogOut, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { onlineErrorMessage, type OnlineUser } from "../../lib/ipc";
import {
  useAccountState,
  useDeleteAccount,
  useSettings,
  useSignIn,
  useSignOut,
  useUpdateDisplayName,
  useUpdateSettings,
} from "../../lib/queries";
import { Avatar, Badge, Button, Dialog, Input } from "../ui";
import { useProviderNames } from "./provider";
import { ProviderButtons } from "./ProviderButtons";
import { WaitingForBrowser } from "./WaitingForBrowser";

/** The anchor the sidebar's user block scrolls to: `#/settings?section=account`. */
export const ACCOUNT_SECTION_ID = "settings-account";

/**
 * Settings · Account.
 *
 * Signed out, the card is the sign-in from the first run without the first
 * run. Signed in, it is the only place that owns the account: the display
 * name, which provider it came from, and the two ways out — sign out here, or
 * delete the account on the service. Both live in a danger zone at the bottom
 * because one of them cannot be undone.
 *
 * The JKNet Online address field sits under them, marked advanced. It exists
 * because the production service has no address yet: a tester points the
 * launcher at a service of their own, and the field is what makes the Developer
 * sign-in appear.
 *
 * With no service at all — a release build until the service is deployed — the
 * card is that sentence and the field, and nothing else. Sign-in buttons there
 * would every one of them end in a connection error.
 */
export function AccountCard() {
  const { t } = useTranslation("account");
  const account = useAccountState();
  const flow = useSignIn();

  const configured = account.data?.onlineConfigured ?? true;
  const user = flow.user ?? account.data?.onlineUser ?? null;
  const signedIn = flow.phase === "done" || (account.data?.onlineSignedIn ?? false);
  const waiting = flow.phase === "starting" || flow.phase === "waiting";

  return (
    <section
      id={ACCOUNT_SECTION_ID}
      className="rounded-lg border border-line bg-surface p-16 mb-24 scroll-mt-24"
    >
      <h2 className="text-heading-sm text-fg pb-4">{t("card.title")}</h2>
      <p className="text-body-sm text-fg-secondary">
        {configured ? t("card.text") : t("notConfigured")}
      </p>

      {configured ? (
        <div className="pt-16">
          {signedIn && user ? (
            <SignedIn user={user} />
          ) : waiting ? (
            <WaitingForBrowser flow={flow} />
          ) : (
            <SignedOut
              error={flow.error}
              onPick={flow.start}
              localOnline={account.data?.localOnline ?? false}
            />
          )}
        </div>
      ) : null}

      <OnlineUrlField configured={configured} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

function SignedIn({ user }: { user: OnlineUser }) {
  const { t } = useTranslation("account");
  const providers = useProviderNames();

  return (
    <>
      <div className="flex items-center gap-12">
        <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-body-md-medium text-fg truncate">
            {user.displayName}
          </span>
          <span className="text-body-sm text-fg-muted truncate">
            {providers.line(user.provider, user.providerName)}
          </span>
        </span>
        <Badge tone="success" icon={<Check size={12} />}>
          {t("card.linked", { provider: providers.label(user.provider) })}
        </Badge>
      </div>

      <DisplayNameField user={user} />
      <DangerZone />
    </>
  );
}

/**
 * The display name, saved on demand rather than on blur.
 *
 * Unlike the launch arguments next door, this write can be refused: the service
 * owns the namespace and answers `409` when the name is taken. A field that
 * saved silently on blur would report that refusal a moment after the player
 * had moved on, so the button stays.
 */
function DisplayNameField({ user }: { user: OnlineUser }) {
  const { t } = useTranslation("account");
  const { t: tCommon } = useTranslation("common");
  const rename = useUpdateDisplayName();
  const [value, setValue] = useState(user.displayName);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow the stored name: it changes when the sign-in finishes, and when
  // another screen renames the account.
  useEffect(() => {
    setValue(user.displayName);
    setError(null);
  }, [user.displayName]);

  const changed = value.trim() !== user.displayName;

  const save = () => {
    setError(null);
    setSaved(false);
    rename.mutate(value.trim(), {
      onSuccess: () => setSaved(true),
      onError: (e) => setError(onlineErrorMessage(e)),
    });
  };

  return (
    <div className="border-t border-line-subtle mt-16 pt-16">
      <label
        className="block text-label-xs text-fg-muted pb-8"
        htmlFor="account-display-name"
      >
        {t("displayName.label")}
      </label>
      <div className="flex items-start gap-8">
        <Input
          id="account-display-name"
          className="flex-1"
          value={value}
          invalid={error !== null}
          disabled={rename.isPending}
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && changed) save();
          }}
        />
        <Button disabled={!changed || rename.isPending} onClick={save}>
          {rename.isPending ? tCommon("states.saving") : tCommon("actions.save")}
        </Button>
      </div>
      <p
        className={[
          "text-body-sm pt-8",
          error ? "text-fg-danger" : "text-fg-muted",
        ].join(" ")}
        role={error ? "alert" : undefined}
      >
        {error ??
          (saved && !changed ? t("displayName.saved") : t("displayName.rules"))}
      </p>
    </div>
  );
}

/** Sign out and delete, kept together and kept last. */
function DangerZone() {
  const { t } = useTranslation("account");
  const { t: tCommon } = useTranslation("common");
  const signOut = useSignOut();
  const deleteAccount = useDeleteAccount();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-md border border-line-danger bg-danger-subtle p-12 mt-16">
      <h3 className="flex items-center gap-8 text-body-md-medium text-fg">
        <AlertTriangle size={16} className="text-fg-danger" />
        {t("danger.title")}
      </h3>

      {error ? (
        <p role="alert" className="text-body-sm text-fg-danger pt-8">
          {error}
        </p>
      ) : null}

      <div className="flex items-start justify-between gap-16 pt-12">
        <span className="flex flex-col">
          <span className="text-body-sm-medium text-fg">{t("danger.signOut")}</span>
          <span className="text-body-sm text-fg-muted">
            {t("danger.signOutText")}
          </span>
        </span>
        <Button
          icon={<LogOut size={16} />}
          disabled={signOut.isPending}
          onClick={() => {
            setError(null);
            signOut.mutate(undefined, {
              onError: (e) => setError(onlineErrorMessage(e)),
            });
          }}
        >
          {signOut.isPending ? t("danger.signingOut") : t("danger.signOut")}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-16 pt-12">
        <span className="flex flex-col">
          <span className="text-body-sm-medium text-fg">{t("danger.delete")}</span>
          <span className="text-body-sm text-fg-muted">
            {t("danger.deleteText")}
          </span>
        </span>
        <Button
          variant="danger"
          icon={<Trash2 size={16} />}
          disabled={deleteAccount.isPending}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {t("danger.delete")}
        </Button>
      </div>

      {confirming ? (
        <Dialog
          variant="danger"
          title={t("danger.confirmTitle")}
          body={t("danger.confirmBody")}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button
                onClick={() => setConfirming(false)}
                disabled={deleteAccount.isPending}
              >
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={deleteAccount.isPending}
                onClick={() =>
                  deleteAccount.mutate(undefined, {
                    onSuccess: () => setConfirming(false),
                    onError: (e) => {
                      setConfirming(false);
                      setError(onlineErrorMessage(e));
                    },
                  })
                }
              >
                {deleteAccount.isPending
                  ? tCommon("states.deleting")
                  : t("danger.confirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed out
// ---------------------------------------------------------------------------

function SignedOut({
  error,
  onPick,
  localOnline,
}: {
  error: string | null;
  onPick: ReturnType<typeof useSignIn>["start"];
  localOnline: boolean;
}) {
  return (
    <>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-warm shrink-0 mt-2" />
          <span className="text-body-sm text-fg break-words">{error}</span>
        </div>
      ) : null}
      <ProviderButtons onPick={onPick} localOnline={localOnline} />
    </>
  );
}

// ---------------------------------------------------------------------------
// JKNet Online address
// ---------------------------------------------------------------------------

/**
 * Where the launcher looks for the service.
 *
 * Advanced on purpose: nobody needs it until the production service exists, and
 * pointing the launcher elsewhere while signed in would leave a token issued
 * by one service on the requests of another. So the field refuses to save while an
 * account is signed in, and says why.
 *
 * It stays on the card while the service is switched off, because it is the only
 * way a developer or a self-hoster switches it back on without a new build.
 */
function OnlineUrlField({ configured }: { configured: boolean }) {
  const { t } = useTranslation("account");
  const { t: tCommon } = useTranslation("common");
  const settings = useSettings();
  const account = useAccountState();
  const updateSettings = useUpdateSettings();

  const stored = settings.data?.onlineUrl ?? "";
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const signedIn = account.data?.onlineSignedIn ?? false;

  useEffect(() => setValue(stored), [stored]);

  const changed = value.trim() !== stored;

  const save = () => {
    setError(null);
    updateSettings.mutate(
      { onlineUrl: value.trim() },
      { onError: (e) => setError(onlineErrorMessage(e)) },
    );
  };

  return (
    <details className="border-t border-line-subtle mt-16 pt-16">
      <summary className="flex items-center gap-8 text-body-sm-medium text-fg-secondary cursor-pointer select-none">
        <Server size={16} />
        {t("url.summary")}
      </summary>

      <div className="flex items-start gap-8 pt-12">
        <Input
          aria-label={t("url.label")}
          className="flex-1"
          value={value}
          placeholder={t("url.placeholder")}
          invalid={error !== null}
          disabled={signedIn || settings.data === undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && changed) save();
          }}
        />
        <Button
          disabled={!changed || signedIn || updateSettings.isPending}
          onClick={save}
        >
          {updateSettings.isPending
            ? tCommon("states.saving")
            : tCommon("actions.save")}
        </Button>
      </div>

      <p
        className={[
          "text-body-sm pt-8",
          error ? "text-fg-danger" : "text-fg-muted",
        ].join(" ")}
        role={error ? "alert" : undefined}
      >
        {error ??
          (signedIn
            ? t("url.signedIn")
            : configured
              ? t("url.hint")
              : t("url.notConfigured"))}
      </p>
    </details>
  );
}

import { AlertTriangle, Check, LogOut, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { hubErrorMessage, type HubUser } from "../../lib/ipc";
import {
  useAccountState,
  useDeleteAccount,
  useSettings,
  useSignIn,
  useSignOut,
  useUpdateDisplayName,
  useUpdateSettings,
} from "../../lib/queries";
import { Avatar, Badge, Button, Input } from "../ui";
import { AccountDialog } from "./AccountDialog";
import { providerLabel, providerLine } from "./provider";
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
 * delete the account on the hub. Both live in a danger zone at the bottom
 * because one of them cannot be undone.
 *
 * The Hub URL field sits under them, marked advanced. It exists because the
 * production hub has no address yet: a tester points the launcher at a hub of
 * their own, and the field is what makes the Developer sign-in appear.
 */
export function AccountCard() {
  const account = useAccountState();
  const flow = useSignIn();

  const user = flow.user ?? account.data?.hubUser ?? null;
  const signedIn = flow.phase === "done" || (account.data?.hubSignedIn ?? false);
  const waiting = flow.phase === "starting" || flow.phase === "waiting";

  return (
    <section
      id={ACCOUNT_SECTION_ID}
      className="rounded-lg border border-line bg-surface p-16 mb-24 scroll-mt-24"
    >
      <h2 className="text-heading-sm text-fg pb-4">Account</h2>
      <p className="text-body-sm text-fg-secondary">
        A JKNet account carries your friends list and your invites. It is not
        needed to play.
      </p>

      <div className="pt-16">
        {signedIn && user ? (
          <SignedIn user={user} />
        ) : waiting ? (
          <WaitingForBrowser flow={flow} />
        ) : (
          <SignedOut
            error={flow.error}
            onPick={flow.start}
            localHub={account.data?.localHub ?? false}
          />
        )}
      </div>

      <HubUrlField />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

function SignedIn({ user }: { user: HubUser }) {
  return (
    <>
      <div className="flex items-center gap-12">
        <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-body-md-medium text-fg truncate">
            {user.displayName}
          </span>
          <span className="text-body-sm text-fg-muted truncate">
            {providerLine(user.provider, user.providerName)}
          </span>
        </span>
        <Badge tone="success" icon={<Check size={12} />}>
          {providerLabel(user.provider)} linked
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
 * Unlike the launch arguments next door, this write can be refused: the hub
 * owns the namespace and answers `409` when the name is taken. A field that
 * saved silently on blur would report that refusal a moment after the player
 * had moved on, so the button stays.
 */
function DisplayNameField({ user }: { user: HubUser }) {
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
      onError: (e) => setError(hubErrorMessage(e)),
    });
  };

  return (
    <div className="border-t border-line-subtle mt-16 pt-16">
      <label
        className="block text-label-xs text-fg-muted pb-8"
        htmlFor="account-display-name"
      >
        Display name
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
          {rename.isPending ? "Saving…" : "Save"}
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
          (saved && !changed
            ? "Saved. Other players see this name."
            : "3 to 24 characters: letters, digits, spaces, _ and -.")}
      </p>
    </div>
  );
}

/** Sign out and delete, kept together and kept last. */
function DangerZone() {
  const signOut = useSignOut();
  const deleteAccount = useDeleteAccount();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-md border border-line-danger bg-danger-subtle p-12 mt-16">
      <h3 className="flex items-center gap-8 text-body-md-medium text-fg">
        <AlertTriangle size={16} className="text-fg-danger" />
        Danger zone
      </h3>

      {error ? (
        <p role="alert" className="text-body-sm text-fg-danger pt-8">
          {error}
        </p>
      ) : null}

      <div className="flex items-start justify-between gap-16 pt-12">
        <span className="flex flex-col">
          <span className="text-body-sm-medium text-fg">Sign out</span>
          <span className="text-body-sm text-fg-muted">
            Keeps the account. Your clients and library stay where they are.
          </span>
        </span>
        <Button
          icon={<LogOut size={16} />}
          disabled={signOut.isPending}
          onClick={() => {
            setError(null);
            signOut.mutate(undefined, {
              onError: (e) => setError(hubErrorMessage(e)),
            });
          }}
        >
          {signOut.isPending ? "Signing out…" : "Sign out"}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-16 pt-12">
        <span className="flex flex-col">
          <span className="text-body-sm-medium text-fg">
            Delete account data
          </span>
          <span className="text-body-sm text-fg-muted">
            Removes the account, your friends and your invites from the hub.
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
          Delete account data
        </Button>
      </div>

      {confirming ? (
        <AccountDialog
          title="Delete your JKNet account?"
          body="Your account, your friends list and your invites are removed from the hub. Your clients, your library files and your settings stay on this machine. This cannot be undone."
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button
                onClick={() => setConfirming(false)}
                disabled={deleteAccount.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={deleteAccount.isPending}
                onClick={() =>
                  deleteAccount.mutate(undefined, {
                    onSuccess: () => setConfirming(false),
                    onError: (e) => {
                      setConfirming(false);
                      setError(hubErrorMessage(e));
                    },
                  })
                }
              >
                {deleteAccount.isPending ? "Deleting…" : "Delete account"}
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
  localHub,
}: {
  error: string | null;
  onPick: ReturnType<typeof useSignIn>["start"];
  localHub: boolean;
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
      <ProviderButtons onPick={onPick} localHub={localHub} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Hub address
// ---------------------------------------------------------------------------

/**
 * Where the launcher looks for the hub.
 *
 * Advanced on purpose: nobody needs it until the production hub exists, and
 * pointing the launcher elsewhere while signed in would leave a token issued
 * by one hub on the requests of another. So the field refuses to save while an
 * account is signed in, and says why.
 */
function HubUrlField() {
  const settings = useSettings();
  const account = useAccountState();
  const updateSettings = useUpdateSettings();

  const stored = settings.data?.hubUrl ?? "";
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const signedIn = account.data?.hubSignedIn ?? false;

  useEffect(() => setValue(stored), [stored]);

  const changed = value.trim() !== stored;

  const save = () => {
    setError(null);
    updateSettings.mutate(
      { hubUrl: value.trim() },
      { onError: (e) => setError(hubErrorMessage(e)) },
    );
  };

  return (
    <details className="border-t border-line-subtle mt-16 pt-16">
      <summary className="flex items-center gap-8 text-body-sm-medium text-fg-secondary cursor-pointer select-none">
        <Server size={16} />
        Hub address (advanced)
      </summary>

      <div className="flex items-start gap-8 pt-12">
        <Input
          aria-label="Hub address"
          className="flex-1"
          value={value}
          placeholder="http://127.0.0.1:8787"
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
          {updateSettings.isPending ? "Saving…" : "Save"}
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
            ? "Sign out before pointing JKNet at another hub."
            : "An http:// or https:// address. Leave it empty to go back to the default.")}
      </p>
    </details>
  );
}

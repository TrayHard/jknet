import { AlertTriangle, Shield } from "lucide-react";
import { useState } from "react";

import { providerLine } from "../../components/account/provider";
import { ProviderButtons } from "../../components/account/ProviderButtons";
import { WaitingForBrowser } from "../../components/account/WaitingForBrowser";
import { Avatar, Button } from "../../components/ui";
import { errorMessage, ONLINE_NOT_CONFIGURED_TEXT } from "../../lib/ipc";
import { useAccountState, useSignIn, useUpdateSettings } from "../../lib/queries";
import { StepPanel } from "./StepPanel";

interface StepAccountProps {
  onBack: () => void;
  onDone: () => void;
}

/** What an account is good for. */
const BENEFITS = [
  "A friends list, with an invite that works without port forwarding.",
  "Your library and your favourite servers on every machine you play from.",
  "A name other players recognise, instead of one typed into each server.",
];

/**
 * Step 3: sign in, or do not.
 *
 * The step never blocks. Signing in is one browser round trip and the guest
 * button sits next to it the whole way through, including after a provider has
 * refused: JKHub and Discord have issued no OAuth client yet, and a player who
 * meets that on their first run must still reach the Play button.
 *
 * With no service in this build the step is one sentence and **Continue**. It
 * stays in the sequence rather than disappearing from `steps.ts`: the first
 * run is three steps in the design and in the badges, and a setup that is
 * three steps long for one player and two for another is harder to explain
 * than a step that says the feature is not open yet.
 */
export function StepAccount({ onBack, onDone }: StepAccountProps) {
  const account = useAccountState();
  const flow = useSignIn();
  const updateSettings = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);

  // --- slice: online gate ---
  const configured = account.data?.onlineConfigured ?? true;
  // The signed-in account, from this sign-in or from a previous run.
  const user = flow.user ?? account.data?.onlineUser ?? null;
  const signedIn = flow.phase === "done" || (account.data?.onlineSignedIn ?? false);
  const waiting = flow.phase === "starting" || flow.phase === "waiting";

  const finish = () => {
    setError(null);
    updateSettings.mutate(
      { onboardingCompleted: true },
      { onSuccess: () => onDone(), onError: (e) => setError(errorMessage(e)) },
    );
  };

  // --- slice: online gate ---
  // No service in this build: one sentence and one button. The provider buttons,
  // the waiting-for-browser state and the list of what an account is good for
  // all go with them — every one of them is an offer this build cannot keep.
  if (!configured) {
    return (
      <StepPanel
        step={3}
        heading="Accounts and friends come later"
        text={ONLINE_NOT_CONFIGURED_TEXT}
        error={error}
        onBack={onBack}
        footer={
          <Button
            variant="primary"
            size="lg"
            disabled={updateSettings.isPending}
            onClick={finish}
          >
            {updateSettings.isPending ? "Finishing…" : "Continue"}
          </Button>
        }
      >
        <p className="flex items-start gap-8 text-body-sm text-fg-muted">
          <Shield size={16} className="shrink-0 mt-2" />
          <span>
            Everything you have set up so far works without an account. Your
            game files, your settings and your saves stay on this machine.
          </span>
        </p>
      </StepPanel>
    );
  }

  return (
    <StepPanel
      step={3}
      heading={signedIn ? "You are signed in" : "Sign in, or play as a guest"}
      text={
        signedIn
          ? "Your friends list and your invites follow this account from now on."
          : "An account is optional. Everything you have set up so far works without one, and you can sign in later from Settings."
      }
      error={error}
      onBack={waiting ? undefined : onBack}
      footer={
        <Button
          variant={signedIn ? "primary" : "secondary"}
          size="lg"
          disabled={updateSettings.isPending || waiting}
          onClick={finish}
        >
          {updateSettings.isPending
            ? "Finishing…"
            : signedIn
              ? "Continue"
              : "Skip, play as guest"}
        </Button>
      }
    >
      {signedIn && user ? (
        <section className="flex items-center gap-12 rounded-lg border border-line bg-surface p-16">
          <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
          <span className="flex-1 min-w-0 flex flex-col">
            <span className="text-heading-sm text-fg truncate">
              {user.displayName}
            </span>
            <span className="text-body-sm text-fg-muted truncate">
              {providerLine(user.provider, user.providerName)}
            </span>
          </span>
        </section>
      ) : waiting ? (
        <WaitingForBrowser flow={flow} />
      ) : (
        <>
          {flow.error ? (
            <div
              role="alert"
              className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle p-12 mb-16"
            >
              <AlertTriangle size={16} className="text-fg-warm shrink-0 mt-2" />
              <span className="text-body-sm text-fg break-words">
                {flow.error} You can play as a guest and sign in later.
              </span>
            </div>
          ) : null}
          <ProviderButtons
            onPick={flow.start}
            busy={waiting}
            localOnline={account.data?.localOnline ?? false}
          />
        </>
      )}

      {signedIn ? null : (
        <section className="rounded-lg border border-line bg-surface p-16 mt-24">
          <h2 className="text-heading-sm text-fg">With an account</h2>
          <ul className="flex flex-col gap-8 pt-12">
            {BENEFITS.map((benefit) => (
              <li key={benefit} className="flex items-start gap-8">
                <span className="mt-8 size-6 shrink-0 rounded-full bg-accent" />
                <span className="text-body-sm text-fg-secondary">{benefit}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="flex items-start gap-8 text-body-sm text-fg-muted pt-16">
        <Shield size={16} className="shrink-0 mt-2" />
        <span>
          JKNet stores your account name and who your friends are. Your game
          files, your settings and your saves stay on this machine.
        </span>
      </p>
    </StepPanel>
  );
}

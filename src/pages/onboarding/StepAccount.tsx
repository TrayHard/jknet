import { AlertTriangle, Shield } from "lucide-react";
import { useState } from "react";

import { providerLine } from "../../components/account/provider";
import { ProviderButtons } from "../../components/account/ProviderButtons";
import { WaitingForBrowser } from "../../components/account/WaitingForBrowser";
import { Avatar, Button } from "../../components/ui";
import { errorMessage } from "../../lib/ipc";
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
 */
export function StepAccount({ onBack, onDone }: StepAccountProps) {
  const account = useAccountState();
  const flow = useSignIn();
  const updateSettings = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);

  // The signed-in account, from this sign-in or from a previous run.
  const user = flow.user ?? account.data?.hubUser ?? null;
  const signedIn = flow.phase === "done" || (account.data?.hubSignedIn ?? false);
  const waiting = flow.phase === "starting" || flow.phase === "waiting";

  const finish = () => {
    setError(null);
    updateSettings.mutate(
      { onboardingCompleted: true },
      { onSuccess: () => onDone(), onError: (e) => setError(errorMessage(e)) },
    );
  };

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
            localHub={account.data?.localHub ?? false}
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

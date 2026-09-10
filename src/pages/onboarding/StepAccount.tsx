import { MessageCircle, Shield, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { Badge, Button } from "../../components/ui";
import { ACCOUNTS_ENABLED } from "../../lib/flags";
import { errorMessage } from "../../lib/ipc";
import { useUpdateSettings } from "../../lib/queries";
import { StepPanel } from "./StepPanel";

interface StepAccountProps {
  onBack: () => void;
  onDone: () => void;
}

/** What an account will be good for, once there is one. */
const BENEFITS = [
  "A friends list, with an invite that works without port forwarding.",
  "Your library and your favourite servers on every machine you play from.",
  "A name other players recognise, instead of one typed into each server.",
];

/**
 * Step 3: sign in, or do not.
 *
 * The providers are drawn and switched off. Accounts are the one part of the
 * design with no command behind it, and cutting the step out would leave the
 * badge strip counting to two while the design counts to three — and would
 * hide from a new player that the launcher is going to have accounts at all.
 */
export function StepAccount({ onBack, onDone }: StepAccountProps) {
  const updateSettings = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);

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
      heading="Sign in, or play as a guest"
      text="An account is optional. Everything you have set up so far works without one, and you can sign in later from Settings."
      error={error}
      onBack={onBack}
      footer={
        <Button
          variant={ACCOUNTS_ENABLED ? "secondary" : "primary"}
          size="lg"
          disabled={updateSettings.isPending}
          onClick={finish}
        >
          {updateSettings.isPending ? "Finishing…" : "Skip, play as guest"}
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        {/* No handler on purpose: wiring one belongs to the change that
            flips ACCOUNTS_ENABLED and adds the command behind it. */}
        <Provider
          icon={<UserRound size={20} />}
          label="Continue with JKHub"
          note="The account most of the community already has."
        />
        <Provider
          icon={<MessageCircle size={20} />}
          label="Continue with Discord"
          note="Signs you in with the Discord you play with."
        />
      </div>

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

      <p className="flex items-start gap-8 text-body-sm text-fg-muted pt-16">
        <Shield size={16} className="shrink-0 mt-2" />
        <span>
          JKNet would store your account name and the clients you made. Your game
          files, your settings and your saves stay on this machine.
        </span>
      </p>
    </StepPanel>
  );
}

interface ProviderProps {
  icon: ReactNode;
  label: string;
  note: string;
}

/** One sign-in provider, drawn as the design has it and switched off. */
function Provider({ icon, label, note }: ProviderProps) {
  return (
    <button
      type="button"
      disabled={!ACCOUNTS_ENABLED}
      className={[
        "flex items-center gap-12 h-56 px-16 rounded-md border border-line bg-input",
        "text-left transition-colors duration-150",
        "enabled:cursor-pointer enabled:hover:bg-surface-hover",
        "disabled:cursor-not-allowed disabled:opacity-60",
      ].join(" ")}
    >
      <span className="flex items-center justify-center size-36 shrink-0 rounded-md bg-elevated text-fg-secondary">
        {icon}
      </span>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="text-body-md-medium text-fg">{label}</span>
        <span className="text-body-sm text-fg-muted truncate">{note}</span>
      </span>
      {ACCOUNTS_ENABLED ? null : <Badge tone="neutral">Soon</Badge>}
    </button>
  );
}

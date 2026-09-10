import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { errorMessage } from "../../lib/ipc";
import { useClients, useSettings } from "../../lib/queries";
import { BrandPanel } from "./BrandPanel";
import { StepAccount } from "./StepAccount";
import { StepClient } from "./StepClient";
import { StepGameFiles } from "./StepGameFiles";
import { StepPanel } from "./StepPanel";
import { initialStep, type OnboardingStep } from "./steps";

/**
 * The first run: game files, a client, an account.
 *
 * The step is not stored anywhere. It is derived once, from what is already
 * configured, so a player who closed the launcher during the download comes
 * back to the download rather than to a folder they already chose — and a
 * player who deleted their only client is sent to make another one instead of
 * to an account screen with nothing to play.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const settings = useSettings();
  const clients = useClients();
  const [step, setStep] = useState<OnboardingStep | null>(null);

  useEffect(() => {
    if (step !== null || settings.data === undefined || clients.data === undefined) {
      return;
    }
    setStep(initialStep(settings.data, clients.data));
  }, [step, settings.data, clients.data]);

  const queryError = settings.error ?? clients.error ?? null;
  const failure = queryError ? errorMessage(queryError) : null;

  return (
    <div className="flex h-full">
      <BrandPanel />
      {step === null ? (
        <Resolving error={failure} />
      ) : step === 1 ? (
        <StepGameFiles onContinue={() => setStep(2)} />
      ) : step === 2 ? (
        <StepClient onBack={() => setStep(1)} onContinue={() => setStep(3)} />
      ) : (
        <StepAccount onBack={() => setStep(2)} onDone={() => void navigate("/")} />
      )}
    </div>
  );
}

/**
 * The frame while the two queries answer, and where they stay if they cannot.
 *
 * Outside the Tauri runtime — `npm run dev` in a browser — nothing here can
 * work, so the step shows the same alert every other screen shows instead of
 * a wizard whose buttons all fail.
 */
function Resolving({ error }: { error: string | null }) {
  return (
    <StepPanel
      step={1}
      heading="Where is the game installed?"
      text="JKNet needs the folder that holds base\assets0.pk3 to assets3.pk3."
      error={error}
      footer={null}
    >
      <p className="text-body-sm text-fg-muted">
        {error ? "Restart the launcher once the problem is fixed." : "Reading your setup…"}
      </p>
    </StepPanel>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

// --- slice: i18n ---
import { useErrorText } from "../../i18n/errors";
import { useClients, useSettings } from "../../lib/queries";
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
 *
 * --- slice: servers robustness ---
 * One column, the whole window. A brand panel used to stand to the left of the
 * step with a tagline and three promises; it took 480 px away from the only
 * thing the player is here to do and told them what they had already decided
 * by installing the launcher.
 */
export function OnboardingPage() {
  const errorText = useErrorText();
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
  const failure = queryError ? errorText(queryError) : null;

  return (
    <div className="flex h-full">
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
  const { t } = useTranslation("onboarding");

  return (
    <StepPanel
      step={1}
      heading={t("resolving.heading")}
      text={t("resolving.text")}
      error={error}
      footer={null}
    >
      <p className="text-body-sm text-fg-muted">
        {error ? t("resolving.failed") : t("resolving.reading")}
      </p>
    </StepPanel>
  );
}

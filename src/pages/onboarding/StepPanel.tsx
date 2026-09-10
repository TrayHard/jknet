import { AlertTriangle, ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, StepBadges } from "../../components/ui";
import { STEP_COUNT, STEP_KEYS, type OnboardingStep } from "./steps";

interface StepPanelProps {
  step: OnboardingStep;
  heading: string;
  /** One or two sentences under the heading. */
  text: string;
  /** A message from a failed command, printed above the content. */
  error?: string | null;
  /** Left out on the first step and while a download runs. */
  onBack?: () => void;
  /** The buttons on the right of the footer. */
  footer: ReactNode;
  children: ReactNode;
}

/**
 * The right half of the first run: badges, heading, content, footer.
 *
 * Only the middle scrolls. The heading says where the player is and the footer
 * says how to leave, and neither may drift off a short window while a list of
 * game folders grows.
 */
export function StepPanel({
  step,
  heading,
  text,
  error,
  onBack,
  footer,
  children,
}: StepPanelProps) {
  const { t } = useTranslation("onboarding");
  const { t: tCommon } = useTranslation("common");

  return (
    <div className="flex-1 min-w-0 flex justify-center overflow-hidden">
      <div className="flex flex-col w-full max-w-[640px] p-32">
        <StepBadges
          steps={STEP_KEYS.map((key) => ({
            label: t(`steps.${key}`),
            done: t("panel.stepDone"),
            current: t("panel.stepCurrent"),
            upcoming: t("panel.stepUpcoming"),
          }))}
          current={step}
        />

        <h1 className="text-display-lg text-fg pt-24">{heading}</h1>
        <p className="text-body-md text-fg-secondary pt-8">{text}</p>

        <div className="flex-1 min-h-0 overflow-y-auto py-24">
          {error ? (
            <div
              role="alert"
              className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
            >
              <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
              <span className="text-body-sm text-fg break-words">{error}</span>
            </div>
          ) : null}
          {children}
        </div>

        <div className="flex items-center justify-between gap-16 border-t border-line-subtle pt-16">
          <Button
            variant="ghost"
            icon={<ChevronLeft size={16} />}
            onClick={onBack}
            disabled={onBack === undefined}
          >
            {tCommon("actions.back")}
          </Button>
          <span className="text-label-xs text-fg-muted">
            {t("panel.position", { step, total: STEP_COUNT })}
          </span>
          <div className="flex items-center gap-12">{footer}</div>
        </div>
      </div>
    </div>
  );
}

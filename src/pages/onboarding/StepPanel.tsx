import { AlertTriangle, ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, StepBadges } from "../../components/ui";
import { STEP_COUNT, STEP_KEYS, type OnboardingStep } from "./steps";

// --- slice: servers robustness ---
/**
 * How wide the step may grow, whatever the window does.
 *
 * The window minimum is 1100 px, and 32 px of padding on each side leaves
 * 1036 px of it. 760 px is a readable measure for the heading and the sentence
 * under it, and keeps the two ends of a game-folder row within one glance; the
 * rest of the window is margin.
 */
const CONTENT_WIDTH = 760;

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
 * One step of the first run: badges, heading, content, footer.
 *
 * Only the middle scrolls. The heading says where the player is and the footer
 * says how to leave, and neither may drift off a short window while a list of
 * game folders grows.
 *
 * --- slice: servers robustness ---
 * The column is centred in the whole window now that nothing stands beside it,
 * and capped at [`CONTENT_WIDTH`]: a line of text that runs the full width of a
 * 1280 px window is a line nobody finishes reading, and a list of game folders
 * that wide puts the path and the badge at opposite ends of the screen.
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
      <div
        className="flex flex-col w-full p-32"
        style={{ maxWidth: CONTENT_WIDTH }}
      >
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

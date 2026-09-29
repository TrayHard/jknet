import { Share, Smartphone, SquarePlus, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

const STEPS: ReadonlyArray<{ key: "iosStep1" | "iosStep2" | "iosStep3"; icon: LucideIcon }> = [
  { key: "iosStep1", icon: Share },
  { key: "iosStep2", icon: SquarePlus },
  { key: "iosStep3", icon: Smartphone },
];

/**
 * The steps that put JKNet on an iPhone's Home Screen, and why: push
 * reaches an iPhone or iPad only in the app opened from there, iOS 16.4 or
 * later. Shown by Settings · Install and, in place of the switch, by
 * Settings · Notifications.
 */
export function HomeScreenSteps() {
  const { t } = useTranslation("web");
  const headingId = useId();
  return (
    <section
      data-testid="ios-install"
      aria-labelledby={headingId}
      className="flex flex-col gap-12 rounded-lg border border-line-warm bg-warm-subtle p-16"
    >
      <div className="flex items-start gap-12">
        <span className="flex size-36 shrink-0 items-center justify-center rounded-md bg-elevated text-fg-warm">
          <Smartphone size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h3 id={headingId} className="text-heading-sm text-fg">
            {t("install.homeScreen")}
          </h3>
          <p className="text-body-sm text-fg-secondary">{t("install.iosPush")}</p>
        </div>
      </div>
      <ol className="flex flex-col gap-8">
        {STEPS.map(({ key, icon: Icon }, index) => (
          <li key={key} className="flex items-center gap-12 text-body-md text-fg">
            <span
              aria-hidden="true"
              className="flex size-24 shrink-0 items-center justify-center rounded-full bg-elevated text-label-xs text-fg-secondary"
            >
              {index + 1}
            </span>
            <Icon size={16} className="shrink-0 text-fg-secondary" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t(`install.${key}`)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

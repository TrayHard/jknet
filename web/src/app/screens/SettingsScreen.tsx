import { Bell, ChevronRight, Download, Info, Languages, MonitorSmartphone, Shield, UserRound, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Select } from "../../../../src/components/ui/index.ts";
import { isLanguage, LANGUAGES } from "../../../../src/i18n/languages.ts";
import { cn } from "../../../../src/lib/format.ts";
import { useUpdateSettings } from "../../../../src/lib/queries.ts";
import { changeWebLanguage } from "../../i18n.ts";
import { useWebCore } from "../CoreContext.tsx";

type Page = "account" | "notifications" | "privacy" | "sessions" | "install" | "about";

const PAGES: ReadonlyArray<{ page: Page; icon: LucideIcon }> = [
  { page: "account", icon: UserRound },
  { page: "notifications", icon: Bell },
  { page: "privacy", icon: Shield },
  { page: "sessions", icon: MonitorSmartphone },
  { page: "install", icon: Download },
  { page: "about", icon: Info },
];

/**
 * The settings menu: one row per page, and the language of the app, which
 * switches at once and is remembered on this device.
 */
export function SettingsScreen({ current }: { current?: string }) {
  const { t, i18n } = useTranslation("web");
  const update = useUpdateSettings();
  const core = useWebCore();

  // Push notifications of this device follow the language too.
  const pick = (value: string) => {
    if (!isLanguage(value)) return;
    void changeWebLanguage(value).then(() => {
      update.mutate({ language: value });
      void core.push.setLocale(value);
    });
  };

  return (
    <div className="flex flex-col gap-16 px-8 pb-24">
      <nav aria-label={t("settings.title")} className="flex flex-col gap-2">
        {PAGES.map(({ page, icon: Icon }) => {
          const active = current === page;
          return (
            <Link
              key={page}
              to={`/settings/${page}`}
              data-page={page}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-56 items-center gap-12 rounded-[10px] px-12 transition-colors duration-100",
                active ? "bg-selected-overlay" : "hover:bg-hover-overlay",
              )}
            >
              <span
                className={cn(
                  "flex size-40 shrink-0 items-center justify-center rounded-[10px]",
                  active ? "bg-accent-subtle text-fg-accent" : "bg-elevated text-fg-secondary",
                )}
              >
                <Icon size={18} />
              </span>
              <span className="min-w-0 flex-1 truncate text-body-md-medium text-fg">{t(`settings.${page}`)}</span>
              <ChevronRight size={16} className="text-fg-secondary" />
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-8 px-12">
        <span className="flex items-center gap-8 text-label-xs uppercase text-fg-secondary">
          <Languages size={14} />
          {t("settings.language")}
        </span>
        <Select
          value={isLanguage(i18n.language) ? i18n.language : "en"}
          onChange={pick}
          ariaLabel={t("settings.language")}
          options={LANGUAGES.map((language) => ({ value: language.id, label: language.nativeName }))}
        />
      </div>
    </div>
  );
}

import { AlertTriangle, CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import type { CommunityNotifications } from "../../lib/ipc";
import { useSettings, useUpdateSettings } from "../../lib/queries";
import { Toggle } from "../ui";

/** The anchor of the card: `#/settings?section=events`. */
export const COMMUNITY_NOTIFICATIONS_SECTION_ID = "settings-community-notifications";

const DEFAULTS: Required<CommunityNotifications> = { newEvents: true, reminders: true, news: true, os: true };

/**
 * --- slice: community events ---
 *
 * **Community notifications**: whether a new event of a followed community,
 * the reminder 15 minutes before an answered event and the news of a
 * followed community reach the player, and whether they show as a Windows
 * notification while the launcher is minimized or in the tray. Each switch writes itself alone into
 * `settings.json`; the core reads them when a frame arrives
 * (`community_events::decide`). A change and a cancellation of an event the
 * player answered have no switch: they always come.
 */
export function CommunityNotificationsCard() {
  const { t } = useTranslation("events");
  const errorText = useErrorText();
  const settings = useSettings();
  const update = useUpdateSettings();
  const current = { ...DEFAULTS, ...(settings.data?.communityNotifications ?? {}) };
  const pending = update.isPending ? update.variables?.communityNotifications : undefined;
  const value = (key: keyof CommunityNotifications) => pending?.[key] ?? current[key];
  const rows: Array<{ key: keyof CommunityNotifications; label: string; help: string }> = [
    { key: "newEvents", label: t("settings.newEvents"), help: t("settings.newEventsHelp") },
    // --- slice: community news ---
    { key: "news", label: t("settings.news"), help: t("settings.newsHelp") },
    { key: "reminders", label: t("settings.reminders"), help: t("settings.remindersHelp") },
    { key: "os", label: t("settings.windows"), help: t("settings.windowsHelp") },
  ];

  return (
    <section
      id={COMMUNITY_NOTIFICATIONS_SECTION_ID}
      aria-labelledby={`${COMMUNITY_NOTIFICATIONS_SECTION_ID}-title`}
      className="mb-24 flex flex-col gap-12 rounded-lg border border-line bg-surface p-16"
    >
      <h2 id={`${COMMUNITY_NOTIFICATIONS_SECTION_ID}-title`} className="flex items-center gap-8 text-heading-sm text-fg">
        <CalendarDays size={16} className="text-fg-accent" aria-hidden="true" />
        {t("settings.title")}
      </h2>
      {rows.map((row) => (
        <div key={row.key} className="flex items-start gap-16">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-body-md-medium text-fg">{row.label}</span>
            <p className="text-body-sm text-fg-secondary">{row.help}</p>
          </div>
          <Toggle
            checked={value(row.key)}
            disabled={settings.data === undefined || update.isPending}
            label={row.label}
            onChange={(next) => update.mutate({ communityNotifications: { [row.key]: next } })}
          />
        </div>
      ))}
      <p className="text-body-sm text-fg-secondary">{t("settings.changes")}</p>
      {update.error ? (
        <p role="alert" className="flex items-start gap-8 text-body-sm text-fg-danger">
          <AlertTriangle size={16} className="mt-1 shrink-0" aria-hidden="true" />
          <span>{errorText(update.error)}</span>
        </p>
      ) : null}
    </section>
  );
}

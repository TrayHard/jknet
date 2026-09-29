import { CalendarDays, History } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Page, PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui";
import { useFormat } from "../i18n/useFormat";
import {
  CHANGELOG_RELEASES,
  LATEST_CHANGELOG_RELEASE,
} from "../lib/changelog";

/** A chronological, offline copy of the launcher's release history. */
export function ChangelogPage() {
  const { t } = useTranslation("changelog");
  const format = useFormat();

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="relative max-w-840">
        <div
          aria-hidden="true"
          className="absolute left-7 top-8 bottom-8 w-px bg-line-subtle"
        />
        <div className="flex flex-col gap-20">
          {CHANGELOG_RELEASES.filter((release) => release.items.length > 0).map((release) => {
            const unreleased = release.version === null;
            const latest = release === LATEST_CHANGELOG_RELEASE;
            const headingId = `changelog-${release.key}`;

            return (
              <article
                key={release.key}
                aria-labelledby={headingId}
                className="relative pl-28"
              >
                <span
                  aria-hidden="true"
                  className={
                    unreleased
                      ? "absolute left-0 top-20 size-16 rounded-full border-4 border-app bg-accent"
                      : "absolute left-2 top-20 size-12 rounded-full border-3 border-app bg-elevated"
                  }
                />
                <div
                  className={
                    unreleased
                      ? "rounded-lg border border-line-focus bg-surface p-20"
                      : "rounded-lg border border-line bg-surface p-20"
                  }
                >
                  <div className="flex flex-wrap items-start justify-between gap-12 pb-16">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-8 pb-4">
                        <History size={18} className="shrink-0 text-fg-accent" />
                        <h2 id={headingId} className="text-heading-md text-fg">
                          {unreleased
                            ? t("upcomingTitle")
                            : t("versionTitle", { version: release.version })}
                        </h2>
                      </div>
                      <p className="flex items-center gap-6 text-body-sm text-fg-muted">
                        {release.date === null ? null : (
                          <CalendarDays size={14} aria-hidden="true" />
                        )}
                        {release.date === null
                          ? t("upcomingHint", {
                              version: LATEST_CHANGELOG_RELEASE.version,
                            })
                          : t("releaseDate", { date: format.date(release.date) })}
                      </p>
                    </div>
                    <Badge tone={unreleased ? "accent" : latest ? "success" : "neutral"}>
                      {unreleased
                        ? t("badges.inDevelopment")
                        : latest
                          ? t("badges.latest")
                          : t("badges.release")}
                    </Badge>
                  </div>

                  <ul className="flex flex-col gap-10">
                    {release.items.map((key) => (
                      <li key={key} className="flex items-start gap-10 text-body-md text-fg-secondary">
                        <span
                          aria-hidden="true"
                          className="mt-9 size-4 shrink-0 rounded-full bg-accent"
                        />
                        <span>{t(key)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </Page>
  );
}

import { EyeOff, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Avatar, Badge, Button } from "../ui";
import { Failure, LinkButton, Panel, PanelHead } from "./bits";
import { daysSince, joinNames } from "./format";
import { useCommunityPlatform } from "./platform";
import type { CommunityRegular, CommunityRegulars } from "./types";
import type { Remote } from "./useRemote";

/** How many faces the overview shows. */
const PREVIEW = 8;
/** How many rows the tab shows before **Show all**. */
const FIRST_ROWS = 12;

/** A face, ringed in the accent when the player is a friend of the reader. */
function Face({ regular, size }: { regular: CommunityRegular; size: "md" | "lg" }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full",
        regular.friend && "ring-2 ring-line-accent ring-offset-2 ring-offset-surface",
      )}
    >
      <Avatar name={regular.user.displayName} src={regular.user.avatarUrl} size={size} />
    </span>
  );
}

/** The regular players of the overview: eight faces, the total and the friends among them. */
export function RegularsPreview({ remote, onAll }: { remote: Remote<CommunityRegulars>; onAll: () => void }) {
  const { t, i18n } = useTranslation("community");
  const data = remote.data;
  const friends = (data?.regulars ?? []).filter((regular) => regular.friend).map((regular) => regular.user.displayName);
  return (
    <Panel labelledBy="community-regulars">
      <PanelHead
        id="community-regulars"
        title={t("regulars.title")}
        end={data && data.total > 0 ? <LinkButton onClick={onAll}>{t("regulars.all", { count: data.total })}</LinkButton> : null}
      />
      {remote.error && !data ? (
        <Failure error={remote.error} onRetry={remote.reload} />
      ) : !data ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {t("common.loading")}
        </p>
      ) : data.regulars.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t("regulars.empty")}</p>
      ) : (
        <ul className="grid grid-cols-4 gap-8">
          {data.regulars.slice(0, PREVIEW).map((regular) => (
            <li key={regular.user.id} className="flex min-w-0 flex-col items-center gap-4 text-center">
              <Face regular={regular} size="md" />
              <span className="max-w-full truncate text-body-sm-medium text-fg" title={regular.user.displayName}>
                {regular.user.displayName}
              </span>
              <span className="text-body-sm text-fg-secondary">{t("regulars.days", { count: regular.days })}</span>
            </li>
          ))}
        </ul>
      )}
      {friends.length > 0 ? (
        <p className="flex items-start gap-8 text-body-sm text-fg-secondary">
          <Users size={16} className="mt-1 shrink-0 text-fg-muted" aria-hidden="true" />
          <span>{t("regulars.friends", { names: joinNames(friends.slice(0, 5), i18n.language) })}</span>
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * When a regular last played, in words: yesterday, three days ago. The
 * service counts complete days only, so the latest day is yesterday; a day
 * that reads as today — a service from before that rule — says yesterday
 * too, and the page never tells anyone who is playing right now.
 */
function lastPlayed(t: (key: string, options?: Record<string, unknown>) => string, day: string): string {
  const days = daysSince(day);
  if (days === null) return day;
  if (days <= 1) return t("players.yesterday");
  return t("players.daysAgo", { count: days });
}

/**
 * The **Players** tab: every regular player the service lists, the rule
 * that makes one, and where a player hides themselves from the list.
 */
export function PlayersTab({ remote }: { remote: Remote<CommunityRegulars> }) {
  const { t } = useTranslation("community");
  const loose = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const platform = useCommunityPlatform();
  const [all, setAll] = useState(false);
  const data = remote.data;

  if (remote.error && !data) return <Failure error={remote.error} onRetry={remote.reload} />;
  if (!data) {
    return (
      <p role="status" className="text-body-sm text-fg-muted">
        {t("common.loading")}
      </p>
    );
  }

  const rows = all ? data.regulars : data.regulars.slice(0, FIRST_ROWS);
  const widest = Math.max(1, data.windowDays);
  return (
    <div className="flex flex-col gap-12">
      <p className="text-body-md text-fg-secondary">
        {t("players.lead", { count: data.total, days: data.minDays, minutes: data.minMinutesPerDay, window: data.windowDays })}
      </p>
      {data.regulars.length === 0 ? (
        <Panel>
          <p className="text-body-sm text-fg-secondary">{t("players.empty")}</p>
        </Panel>
      ) : (
        <div role="table" aria-label={t("regulars.title")} className="flex flex-col rounded-lg border border-line bg-surface p-8">
          <div
            role="row"
            className="grid min-h-32 grid-cols-[minmax(0,1fr)_minmax(96px,280px)_168px] items-center gap-16 border-b border-line-subtle px-12 text-label-xs text-fg-secondary @max-[640px]/community:grid-cols-[minmax(0,1fr)_auto]"
          >
            <span role="columnheader">{t("players.player")}</span>
            <span role="columnheader">{t("players.days", { window: data.windowDays })}</span>
            <span role="columnheader" className="@max-[640px]/community:hidden">
              {t("players.last")}
            </span>
          </div>
          {rows.map((regular) => (
            <div
              role="row"
              key={regular.user.id}
              className="grid min-h-48 grid-cols-[minmax(0,1fr)_minmax(96px,280px)_168px] items-center gap-16 rounded-md px-12 py-6 hover:bg-hover-overlay @max-[640px]/community:grid-cols-[minmax(0,1fr)_auto]"
            >
              <span role="cell" className="flex min-w-0 items-center gap-12">
                <Face regular={regular} size="md" />
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-2">
                    <span className="min-w-0 text-body-md-medium text-fg [overflow-wrap:anywhere]">{regular.user.displayName}</span>
                    {regular.friend ? <Badge tone="accent">{t("players.friend")}</Badge> : null}
                  </span>
                  <span className="hidden text-body-sm text-fg-secondary @max-[640px]/community:inline">
                    {lastPlayed(loose, regular.lastPlayed)}
                  </span>
                </span>
              </span>
              <span role="cell" className="flex items-center gap-12">
                <span className="h-6 flex-1 overflow-hidden rounded-full bg-elevated @max-[640px]/community:hidden" aria-hidden="true">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${Math.min(100, Math.round((regular.days / widest) * 100))}%` }}
                  />
                </span>
                <span className="min-w-24 text-right text-body-sm-medium tabular-nums text-fg">{regular.days}</span>
              </span>
              <span role="cell" className="text-body-sm text-fg-secondary @max-[640px]/community:hidden">
                {lastPlayed(loose, regular.lastPlayed)}
              </span>
            </div>
          ))}
          {data.regulars.length > FIRST_ROWS ? (
            <div className="flex justify-center pt-8">
              <Button size="sm" variant="ghost" wrap aria-expanded={all} onClick={() => setAll((value) => !value)}>
                {all ? t("players.collapse") : t("players.showAll", { count: data.regulars.length })}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {data.total > data.regulars.length ? (
        <p className="text-body-sm text-fg-secondary">{t("players.limit", { shown: data.regulars.length, total: data.total })}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-12 gap-y-8 rounded-lg border border-dashed border-line-strong px-16 py-12 text-body-sm text-fg-secondary">
        <EyeOff size={16} className="shrink-0" aria-hidden="true" />
        {platform.openPrivacySettings ? (
          <>
            <span className="min-w-0 flex-1 basis-[240px]">{t("players.privacy")}</span>
            <LinkButton onClick={platform.openPrivacySettings}>{t("players.privacyLink")}</LinkButton>
          </>
        ) : (
          <span className="min-w-0 flex-1 basis-[240px]">{t("players.privacyLauncher")}</span>
        )}
      </div>
    </div>
  );
}

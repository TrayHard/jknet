/**
 * **Upcoming events** on Home, as the design's G1 draws it: the three
 * soonest events the player answered «going» or «maybe» or that the
 * communities they follow announced, each a row that opens the event, and
 * **Calendar** beside the heading.
 *
 * Like the server blocks of Home, the card draws nothing when it has no
 * rows: a guest, or a player with no answers and no subscriptions with
 * events, keeps the screen they had.
 */

import { Bell, Check, ChevronRight, CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Badge } from "../ui";
import { CommunityLogo } from "../community/bits";
import { useCommunityPlatform } from "../community/platform";
import { useRemote } from "../community/useRemote";
import { DateTile, EventLink, useNow } from "./bits";
import { usePlaceText } from "./EventItems";
import { useEventFormat } from "./format";
import { DAY, homeEvents, HOUR } from "./logic";
import { useEventsApi } from "./platform";

export function HomeEventsCard({ className }: { className?: string }) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const api = useEventsApi();
  const format = useEventFormat();
  const place = usePlaceText();
  const now = useNow(60_000);
  const account = platform.signedIn ? platform.accountId ?? "account" : null;
  const hour = Math.floor(now / HOUR);
  const remote = useRemote(account ? `home-events:${account}:${platform.game ?? "*"}:${hour}` : null, async () => {
    const range = { from: new Date(now - HOUR).toISOString(), to: new Date(now + 31 * DAY).toISOString(), game: platform.game ?? null };
    const [all, following] = await Promise.all([
      api.calendar({ ...range, scope: "all" }),
      api.calendar({ ...range, scope: "following" }),
    ]);
    return { all: all.events, following: following.events };
  });
  if (!remote.data) return null;
  const rows = homeEvents(remote.data.all, remote.data.following, now);
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="home-events-title" className={cn("flex flex-col gap-8", className)}>
      <div className="flex items-center justify-between gap-12">
        <h2 id="home-events-title" className="text-label-xs text-fg-muted">
          {t("home.title")}
        </h2>
        <EventLink route={{ view: "calendar" }} className="inline-flex items-center gap-2 text-body-sm-medium text-fg-accent hover:underline hover:underline-offset-2">
          {t("home.calendar")}
          <ChevronRight size={14} aria-hidden="true" />
        </EventLink>
      </div>
      <ul className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface">
        {rows.map(({ event, reason }) => {
          const start = Date.parse(event.startsAt);
          return (
            <li key={event.id} className="border-t border-line-subtle first:border-t-0">
              <EventLink
                route={{ view: "event", id: event.id }}
                ariaLabel={t("home.rowAria", { title: event.title, when: format.dayTime(start) })}
                className="group grid min-h-52 grid-cols-[36px_minmax(0,1fr)_auto_auto_16px] items-center gap-16 px-16 py-6 transition-colors hover:bg-hover-overlay @max-[640px]/page:grid-cols-[36px_minmax(0,1fr)_16px]"
              >
                <DateTile weekday={format.weekday(start)} day={format.dayNumber(start)} tone={reason === "following" ? "neutral" : "warm"} size="sm" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-body-md-medium text-fg transition-colors group-hover:text-fg-accent">{event.title}</span>
                  <span className="flex min-w-0 items-center gap-6 text-body-sm text-fg-secondary">
                    <CommunityLogo card={event.community} size="sm" />
                    <span className="truncate">{t("card.communityPlace", { community: event.community.name, place: place(event) })}</span>
                  </span>
                </span>
                <span className="flex flex-col items-end @max-[640px]/page:hidden">
                  <span className="text-mono-sm text-fg">{format.time(start)}</span>
                  <span className="text-[11px] leading-[16px] text-fg-secondary">{format.relativeDay(start, now)}</span>
                </span>
                <span className="justify-self-end @max-[640px]/page:hidden">
                  {reason === "going" ? (
                    <Badge tone="warm" icon={<Check size={12} aria-hidden="true" />}>
                      {t("home.going")}
                    </Badge>
                  ) : reason === "maybe" ? (
                    <Badge icon={<CircleHelp size={12} aria-hidden="true" />}>{t("home.maybe")}</Badge>
                  ) : (
                    <Badge icon={<Bell size={12} aria-hidden="true" />}>{t("home.following")}</Badge>
                  )}
                </span>
                <ChevronRight size={16} aria-hidden="true" className="text-fg-muted" />
              </EventLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

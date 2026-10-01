/**
 * The events of one community on its page, as the design's B3 draws them:
 * the block **Upcoming events** of the overview and the tab **Events** with
 * the upcoming events and the past ones.
 *
 * The calendar answers at most 62 days at once, so the tab reads the next 62
 * days and the last 62: an event planned further ahead shows when its day
 * comes closer, and the page says how many are beyond.
 */

import { CalendarDays, Clock, Pencil, Plus, Server, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Badge, Button } from "../ui";
import { LinkButton, Panel, PanelHead, Failure } from "../community/bits";
import { useCommunityPlatform } from "../community/platform";
import type { Community } from "../community/types";
import { useRemote } from "../community/useRemote";
import { DateTile, EventLink, KindBadge, RsvpControl, useNow } from "./bits";
import { EventRow, FriendsGoing, useCountsText, usePlaceText } from "./EventItems";
import { useEventFormat } from "./format";
import { answersOpen, byStart, DAY, isFull, splitByTime } from "./logic";
import { useEventsApi, useOptionalEventsPlatform } from "./platform";
import type { EventCard } from "./types";
import { useAnswer } from "./useAnswer";

/** How far the tab reads, each way: the longest range the calendar answers. */
const WINDOW = 62 * DAY;

/** The upcoming events of a community, the next 62 days. */
function useUpcoming(community: Community, enabled: boolean, now: number) {
  const platform = useCommunityPlatform();
  const api = useEventsApi();
  const account = platform.signedIn ? platform.accountId ?? "account" : "guest";
  // The hour, not the minute: the key moves rarely, and a read is not repeated every tick.
  const hour = Math.floor(now / (60 * 60 * 1000));
  return useRemote(enabled ? `community-events:${community.id}:${account}:${hour}` : null, async () => {
    const from = new Date(now - 60 * 1000).toISOString();
    const to = new Date(now + WINDOW - 2 * 60 * 1000).toISOString();
    const answer = await api.calendar({ from, to, community: community.id });
    return answer.events.filter((event) => Date.parse(event.endsAt) > now).sort(byStart);
  });
}

/** The block of the overview: the soonest event in full, the next two as rows. */
export function UpcomingEventsPanel({ community, onAll }: { community: Community; onAll: () => void }) {
  const { t } = useTranslation("events");
  const events = useOptionalEventsPlatform();
  const now = useNow(60_000);
  const enabled = events !== null && community.counts.upcomingEvents > 0;
  const upcoming = useUpcoming(community, enabled, now);
  const { busyId, error, answer } = useAnswer((next) =>
    upcoming.set((current) => current?.map((event) => (event.id === next.id ? next : event))),
  );
  if (!enabled) return null;
  const list = (upcoming.data ?? []).slice(0, 3);
  if (upcoming.data && list.length === 0) return null;
  const [first, ...rest] = list;
  return (
    <Panel labelledBy="community-upcoming-events">
      <PanelHead id="community-upcoming-events" title={t("community.upcomingTitle")} end={<LinkButton onClick={onAll}>{t("community.allEvents")}</LinkButton>} />
      {upcoming.error && !upcoming.data ? <Failure error={upcoming.error} onRetry={upcoming.reload} /> : null}
      {!upcoming.data && !upcoming.error ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {t("common.loading")}
        </p>
      ) : null}
      {first ? (
        <FeaturedEvent
          event={first}
          now={now}
          busy={busyId === first.id}
          error={error?.id === first.id ? error.text : null}
          onAnswer={(value) => answer(first, value)}
        />
      ) : null}
      {rest.map((event) => (
        <MiniEvent key={event.id} event={event} now={now} />
      ))}
    </Panel>
  );
}

/** The soonest event of the overview: the tile, the kind and time, the title, the places, the friends and the answer. */
function FeaturedEvent({
  event,
  now,
  busy,
  error,
  onAnswer,
}: {
  event: EventCard;
  now: number;
  busy: boolean;
  error: string | null;
  onAnswer: (value: "going" | "maybe" | null) => void;
}) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const format = useEventFormat();
  const place = usePlaceText();
  const counts = useCountsText();
  const start = Date.parse(event.startsAt);
  const going = event.viewer?.rsvp === "going";
  return (
    <div className="flex gap-16 @max-[560px]/community:flex-col">
      <DateTile weekday={format.weekday(start)} day={format.dayNumber(start)} month={format.monthShort(start)} tone={going ? "warm" : "neutral"} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-12">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-8 text-body-sm-medium text-fg-warm">
            <KindBadge kind={event.kind} />
            <span>{format.range(event.startsAt, event.endsAt)}</span>
            {event.status === "cancelled" ? <Badge tone="danger">{t("card.cancelled")}</Badge> : null}
          </div>
          <h3 className="text-heading-md [overflow-wrap:anywhere]">
            <EventLink route={{ view: "event", id: event.id }} className="text-fg hover:text-fg-accent">
              {event.title}
            </EventLink>
          </h3>
          <p className="flex items-center gap-6 text-body-sm text-fg-secondary">
            <Server size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
            <span className="[overflow-wrap:anywhere]">{place(event)}</span>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-16 border-y border-line-subtle py-10 @max-[560px]/community:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-6">
            <span className="text-label-xs text-fg-muted">{event.capacity !== null ? t("community.places") : t("community.answers")}</span>
            <span className="text-body-sm-medium text-fg">{counts(event, now)}</span>
            {event.capacity !== null ? (
              <span aria-hidden="true" className="h-4 overflow-hidden rounded-full bg-elevated">
                <span className="block h-full rounded-full bg-warm" style={{ width: `${Math.min(100, (event.counts.going / event.capacity) * 100)}%` }} />
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <span className="text-label-xs text-fg-muted">{t("community.friends")}</span>
            {platform.signedIn ? (
              (event.viewer?.friendsGoing.length ?? 0) > 0 ? (
                <FriendsGoing event={event} />
              ) : (
                <span className="text-body-sm text-fg-secondary">{t("community.noFriends")}</span>
              )
            ) : (
              <span className="text-body-sm text-fg-secondary">{t("community.friendsSignIn")}</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-8">
          {answersOpen(event, now) ? (
            platform.signedIn ? (
              <RsvpControl event={event} busy={busy} onAnswer={onAnswer} className="w-[288px] max-w-full" />
            ) : (
              <Button size="sm" wrap onClick={platform.signIn}>
                {t("rsvp.signInShort")}
              </Button>
            )
          ) : null}
          <EventLink
            route={{ view: "event", id: event.id }}
            className="inline-flex min-h-28 items-center rounded-sm border border-line bg-surface px-12 py-4 text-body-sm-medium text-fg select-none hover:bg-surface-hover pointer-coarse:min-h-44"
          >
            {t("community.details")}
          </EventLink>
        </div>
        {isFull(event) && event.viewer?.rsvp !== "going" && answersOpen(event, now) ? <p className="text-body-sm text-fg-warm">{t("rsvp.fullNote")}</p> : null}
        {error ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A later event of the overview, as one row. */
function MiniEvent({ event, now }: { event: EventCard; now: number }) {
  const format = useEventFormat();
  const counts = useCountsText();
  const place = usePlaceText();
  const start = Date.parse(event.startsAt);
  const going = event.viewer?.rsvp === "going";
  return (
    <div className="flex items-center gap-12 border-t border-line-subtle pt-12">
      <DateTile weekday={format.weekday(start)} day={format.dayNumber(start)} month={format.monthShort(start)} tone={going ? "warm" : "neutral"} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <EventLink route={{ view: "event", id: event.id }} className="w-fit max-w-full text-body-md-medium text-fg hover:text-fg-accent [overflow-wrap:anywhere]">
          {event.title}
        </EventLink>
        <span className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">
          {format.range(event.startsAt, event.endsAt)} · {place(event)}
        </span>
      </div>
      <span className="shrink-0 text-body-sm text-fg-secondary">{counts(event, now)}</span>
    </div>
  );
}

/** The tab **Events** of a community: upcoming first, then the past ones. */
export function CommunityEventsTab({ community, organizer }: { community: Community; organizer: boolean }) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const events = useOptionalEventsPlatform();
  const api = useEventsApi();
  const now = useNow(60_000);
  const account = platform.signedIn ? platform.accountId ?? "account" : "guest";
  const hour = Math.floor(now / (60 * 60 * 1000));
  const remote = useRemote(events ? `community-events-all:${community.id}:${account}:${hour}` : null, async () => {
    const [later, before] = await Promise.all([
      api.calendar({ from: new Date(now - 60 * 1000).toISOString(), to: new Date(now + WINDOW - 2 * 60 * 1000).toISOString(), community: community.id }),
      api.calendar({ from: new Date(now - WINDOW + 2 * 60 * 1000).toISOString(), to: new Date(now).toISOString(), community: community.id }),
    ]);
    const byId = new Map<string, EventCard>();
    for (const event of [...before.events, ...later.events]) byId.set(event.id, event);
    return [...byId.values()];
  });
  const { busyId, error, answer } = useAnswer((next) => remote.set((current) => current?.map((event) => (event.id === next.id ? next : event))));
  if (events === null) return null;

  const { upcoming, past } = splitByTime(remote.data ?? [], now);
  const beyond = Math.max(0, community.counts.upcomingEvents - upcoming.filter((event) => event.status === "scheduled").length);
  const editAction = (event: EventCard) =>
    organizer ? (
      <Button size="sm" variant="ghost" wrap icon={<Pencil size={14} />} onClick={() => events.navigate({ view: "edit", id: event.id })}>
        {t("community.edit")}
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-wrap items-center gap-12">
        <h2 className="min-w-0 flex-1 text-heading-sm text-fg">{t("community.upcoming")}</h2>
        <Button wrap icon={<CalendarDays size={16} />} onClick={() => events.navigate({ view: "calendar" })}>
          {t("community.calendar")}
        </Button>
        {organizer ? (
          <Button variant="primary" wrap icon={<Plus size={16} />} onClick={() => events.navigate({ view: "new", communityId: community.id })}>
            {t("community.create")}
          </Button>
        ) : null}
      </div>
      {remote.error && !remote.data ? <Failure error={remote.error} onRetry={remote.reload} /> : null}
      {!remote.data && !remote.error ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {t("common.loading")}
        </p>
      ) : null}
      {remote.data ? (
        upcoming.length > 0 ? (
          <div className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-lg border border-line bg-surface">
            {upcoming.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                now={now}
                tile
                showCommunity={false}
                busy={busyId === event.id}
                error={error?.id === event.id ? error.text : null}
                onAnswer={(value) => answer(event, value)}
                actions={editAction(event)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-12 rounded-lg border border-dashed border-line p-16">
            <p className="text-body-sm text-fg-secondary">{organizer ? t("community.noUpcomingOrganizer") : t("community.noUpcoming")}</p>
          </div>
        )
      ) : null}
      {beyond > 0 && remote.data ? (
        <p className="flex items-center gap-6 text-body-sm text-fg-secondary">
          <Clock size={14} aria-hidden="true" className="text-fg-muted" />
          {t("community.beyond", { count: beyond })}
        </p>
      ) : null}

      <h2 className="pt-8 text-heading-sm text-fg">{t("community.past")}</h2>
      {remote.data ? (
        past.length > 0 ? (
          <div className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-lg border border-dashed border-line">
            {past.map((event) => (
              <PastRow key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <p className="text-body-sm text-fg-secondary">{t("community.noPast")}</p>
        )
      ) : null}
    </div>
  );
}

/** A past event: the tile, the kind and the day, the title and how many went. */
function PastRow({ event }: { event: EventCard }) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const start = Date.parse(event.startsAt);
  return (
    <article className="flex items-center gap-16 px-16 py-12">
      <DateTile weekday={format.weekday(start)} day={format.dayNumber(start)} month={format.monthShort(start)} tone="past" size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-8 text-body-sm text-fg-secondary">
          <KindBadge kind={event.kind} />
          <span>{format.day(start)}</span>
          {event.status === "cancelled" ? <Badge tone="danger">{t("card.cancelled")}</Badge> : <Badge>{t("card.over")}</Badge>}
        </div>
        <EventLink
          route={{ view: "event", id: event.id }}
          className={cn("w-fit max-w-full text-body-md-medium hover:text-fg-accent [overflow-wrap:anywhere]", event.status === "cancelled" ? "text-fg-secondary line-through" : "text-fg")}
        >
          {event.title}
        </EventLink>
        <span className="flex items-center gap-6 text-body-sm text-fg-secondary">
          <Users size={14} aria-hidden="true" className="text-fg-muted" />
          {t("counts.went", { count: event.counts.going })}
        </span>
      </div>
    </article>
  );
}

/**
 * An event as the lists of the events screens draw it: the card of the
 * calendar's day panel, the row of the agenda and of a community's events,
 * and the lines they share — the time, the place, the answers and the
 * friends who go.
 */

import { ArrowRight, ChevronRight, Clock, Server, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Badge } from "../ui";
import { joinNames } from "../community/format";
import { useCommunityPlatform } from "../community/platform";
import { CommunityLogo } from "../community/bits";
import { DateTile, EventLink, KindBadge, RsvpControl, useKindName } from "./bits";
import { useEventFormat } from "./format";
import { answersOpen, eventPhase, isFull, offsetMinutes } from "./logic";
import type { EventCard, RsvpStatus } from "./types";

/** Where an event takes place, as a line says it. */
export function usePlaceText(): (event: Pick<EventCard, "server" | "address">) => string {
  const { t } = useTranslation("events");
  return (event) => {
    if (event.server) {
      // A server without a label goes by its address, said once.
      if (event.server.label.trim() === "") return t("place.server", { name: event.server.address });
      return t("place.serverAt", { name: event.server.label, address: event.server.address });
    }
    if (event.address) return t("place.address", { address: event.address });
    return t("place.offline");
  };
}

/** The answers as a line: `18 of 32 places · 7 maybe`, `9 going · 4 maybe`, `Over · 26 went`. */
export function useCountsText(): (event: EventCard, now: number) => string {
  const { t } = useTranslation("events");
  return (event, now) => {
    if (eventPhase(event, now) === "ended") return t("counts.went", { count: event.counts.going });
    const head =
      event.capacity !== null
        ? t("counts.places", { going: event.counts.going, count: event.capacity })
        : t("counts.going", { count: event.counts.going });
    return event.counts.maybe > 0 ? t("counts.withMaybe", { head, maybe: t("counts.maybe", { count: event.counts.maybe }) }) : head;
  };
}

/** The friends of the reader who answered «going»: `Jan and Rosh of your friends are going`. */
export function FriendsGoing({ event, className }: { event: EventCard; className?: string }) {
  const { t, i18n } = useTranslation("events");
  const friends = event.viewer?.friendsGoing ?? [];
  if (friends.length === 0) return null;
  const names = friends.slice(0, 3).map((friend) => friend.displayName);
  const rest = friends.length - names.length;
  const listed = rest > 0 ? t("friends.andMore", { names: names.join(", "), count: rest }) : joinNames(names, i18n.language);
  return (
    <span className={cn("text-body-sm text-fg-secondary", className)}>{t("friends.going", { names: listed, count: friends.length })}</span>
  );
}

/** The organizer's time when it differs from the reader's at the start: `19:00 by the organizer's time (America/New_York)`. */
export function OrganizerTime({ event, className }: { event: EventCard; className?: string }) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const start = Date.parse(event.startsAt);
  if (!event.timezone || event.timezone === format.zone) return null;
  let differs = false;
  try {
    differs = offsetMinutes(start, event.timezone) !== offsetMinutes(start, format.zone);
  } catch {
    return null;
  }
  if (!differs) return null;
  return (
    <span className={cn("text-body-sm text-fg-secondary", className)}>
      {t("card.organizerTime", { time: format.time(start, event.timezone), zone: event.timezone })}
    </span>
  );
}

/** One line with an icon of the card: the time, the place, the answers. */
function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-8 text-body-sm text-fg-secondary">
      <span className="mt-1 shrink-0 text-fg-muted" aria-hidden="true">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/** The marks of an event's state: cancelled, live, over, full. */
export function StateBadges({ event, now }: { event: EventCard; now: number }) {
  const { t } = useTranslation("events");
  const phase = eventPhase(event, now);
  return (
    <>
      {phase === "cancelled" ? <Badge tone="danger">{t("card.cancelled")}</Badge> : null}
      {phase === "live" ? <Badge tone="accent">{t("card.live")}</Badge> : null}
      {phase === "ended" ? <Badge>{t("card.over")}</Badge> : null}
      {phase === "upcoming" && isFull(event) ? <Badge tone="danger">{t("card.full")}</Badge> : null}
    </>
  );
}

/** What the reader may do about an answer: the control, or the line that says why not. */
function AnswerArea({
  event,
  now,
  busy,
  error,
  size,
  onAnswer,
}: {
  event: EventCard;
  now: number;
  busy: boolean;
  error: string | null;
  size: "sm" | "md";
  onAnswer: (value: RsvpStatus | null) => void;
}) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  if (!answersOpen(event, now)) return null;
  if (!platform.signedIn) {
    return (
      <button
        type="button"
        onClick={platform.signIn}
        className="w-fit cursor-pointer rounded-sm text-left text-body-sm-medium text-fg-accent hover:underline"
      >
        {t("rsvp.signInShort")}
      </button>
    );
  }
  const full = isFull(event) && event.viewer?.rsvp !== "going";
  return (
    <div className="flex flex-col gap-4">
      <RsvpControl event={event} busy={busy} size={size} onAnswer={onAnswer} />
      {full ? <p className="text-body-sm text-fg-warm">{t("rsvp.fullNote")}</p> : null}
      {error ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** An event in the day panel of the calendar: the community, the title, the lines, the answer and **Open event**. */
export function DayPanelCard({
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
  onAnswer: (value: RsvpStatus | null) => void;
}) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const place = usePlaceText();
  const counts = useCountsText();
  return (
    <article className="flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
      <div className="flex min-w-0 items-center gap-8 text-body-sm-medium text-fg-secondary">
        <CommunityLogo card={event.community} size="sm" />
        <span className="min-w-0 truncate" title={event.community.name}>
          {event.community.name}
        </span>
      </div>
      <div className="flex flex-col items-start gap-6">
        <EventLink route={{ view: "event", id: event.id }} className="text-heading-sm text-fg hover:text-fg-accent [overflow-wrap:anywhere]">
          {event.title}
        </EventLink>
        <div className="flex flex-wrap gap-6">
          <KindBadge kind={event.kind} />
          <StateBadges event={event} now={now} />
        </div>
      </div>
      <div className="flex flex-col gap-6">
        <Line icon={<Clock size={14} />}>
          <span className="text-body-sm-medium text-fg">{format.hours(event.startsAt, event.endsAt)}</span>
          <OrganizerTime event={event} />
        </Line>
        <Line icon={<Server size={14} />}>{place(event)}</Line>
        <Line icon={<Users size={14} />}>
          <span className="text-body-sm-medium text-fg">{counts(event, now)}</span>
          <FriendsGoing event={event} />
        </Line>
      </div>
      <AnswerArea event={event} now={now} busy={busy} error={error} size="md" onAnswer={onAnswer} />
      <EventLink
        route={{ view: "event", id: event.id }}
        className="inline-flex min-h-28 w-full items-center justify-center gap-6 rounded-sm border border-line bg-surface px-12 py-4 text-body-sm-medium text-fg select-none hover:bg-surface-hover pointer-coarse:min-h-44"
      >
        {t("calendar.openEvent")}
        <ArrowRight size={14} aria-hidden="true" />
      </EventLink>
    </article>
  );
}

/**
 * An event as a row: the agenda of the calendar and the list of a
 * community. The date tile is warm when the reader goes.
 */
export function EventRow({
  event,
  now,
  busy,
  error,
  onAnswer,
  showCommunity = true,
  tile = false,
  actions,
}: {
  event: EventCard;
  now: number;
  busy: boolean;
  error: string | null;
  onAnswer: (value: RsvpStatus | null) => void;
  /** The community's name under the title: off on the community's own page. */
  showCommunity?: boolean;
  /** A tile of the day before the row: on a community's page. */
  tile?: boolean;
  /** More buttons beside **Open**: the organizer's **Edit**. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const place = usePlaceText();
  const counts = useCountsText();
  const kindName = useKindName();
  const start = Date.parse(event.startsAt);
  const phase = eventPhase(event, now);
  const going = event.viewer?.rsvp === "going";
  return (
    <article
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-16 gap-y-8 px-16 py-12",
        "@max-[640px]/community:items-start",
        phase === "ended" && "opacity-80",
      )}
    >
      {tile ? (
        <DateTile
          weekday={format.weekday(start)}
          day={format.dayNumber(start)}
          month={format.monthShort(start)}
          tone={phase === "ended" ? "past" : going ? "warm" : "neutral"}
          size="lg"
        />
      ) : null}
      <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-2">
        <span className="flex flex-wrap items-center gap-6 text-body-sm text-fg-secondary">
          {tile ? (
            <span className="text-body-sm-medium text-fg">{format.range(event.startsAt, event.endsAt)}</span>
          ) : (
            <span className="text-mono-sm text-fg">{format.hours(event.startsAt, event.endsAt)}</span>
          )}
          <span aria-hidden="true">·</span>
          <span>{kindName(event.kind)}</span>
          <StateBadges event={event} now={now} />
        </span>
        <EventLink
          route={{ view: "event", id: event.id }}
          className={cn(
            "w-fit max-w-full text-body-md-medium hover:text-fg-accent [overflow-wrap:anywhere]",
            phase === "cancelled" ? "text-fg-secondary line-through" : "text-fg",
          )}
        >
          {event.title}
        </EventLink>
        <span className="flex min-w-0 items-center gap-6 text-body-sm text-fg-secondary">
          {showCommunity ? (
            <>
              <CommunityLogo card={event.community} size="sm" />
              <span className="min-w-0 truncate">{t("card.communityPlace", { community: event.community.name, place: place(event) })}</span>
            </>
          ) : (
            <span className="min-w-0 [overflow-wrap:anywhere]">{place(event)}</span>
          )}
        </span>
        <FriendsGoing event={event} />
      </div>
      <div className="flex w-[248px] max-w-full shrink-0 flex-col items-stretch gap-4 @max-[640px]/community:w-full">
        <AnswerArea event={event} now={now} busy={busy} error={error} size="sm" onAnswer={onAnswer} />
        <span className="text-right text-body-sm text-fg-secondary @max-[640px]/community:text-left">{counts(event, now)}</span>
        {actions ? <div className="flex flex-wrap justify-end gap-8">{actions}</div> : null}
      </div>
      <EventLink
        route={{ view: "event", id: event.id }}
        ariaLabel={t("calendar.openEventAria", { title: event.title })}
        title={t("calendar.openEvent")}
        className="inline-flex size-36 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-hover-overlay hover:text-fg pointer-coarse:size-44"
      >
        <ChevronRight size={18} aria-hidden="true" />
      </EventLink>
    </article>
  );
}

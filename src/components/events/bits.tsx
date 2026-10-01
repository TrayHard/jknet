/**
 * The small pieces the events screens share: the kind of an event, its
 * cover, the tile of its day, the chip of its community, the control of an
 * answer, a ticking clock and the sentence of a refusal.
 */

import {
  CalendarDays,
  Check,
  Drama,
  GraduationCap,
  PartyPopper,
  Swords,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Badge } from "../ui";
import { blobUrl } from "../community/api";
import { CommunityLogo, hueStyle, RouteLink } from "../community/bits";
import { useFailureText } from "../community/errors";
import { useCommunityPlatform } from "../community/platform";
import { eventFailureKind } from "./api";
import { canGo } from "./logic";
import { isDeclined } from "./declined";
import { useEventsPlatform, type EventsRoute } from "./platform";
import type { EventCard, EventCommunityRef, RsvpStatus } from "./types";
import "./events.css";

/** The icon of each kind; an unknown kind reads as `other`. */
const KIND_ICONS: Record<string, LucideIcon> = {
  tournament: Trophy,
  fun: PartyPopper,
  training: GraduationCap,
  clanwar: Swords,
  rp: Drama,
  other: CalendarDays,
};

/** The name of a kind in the reader's language. */
export function useKindName(): (kind: string) => string {
  const { t } = useTranslation("events");
  const loose = t as unknown as (key: string) => string;
  return useCallback((kind: string) => loose(`kinds.${kind in KIND_ICONS ? kind : "other"}`), [loose]);
}

/** The kind of an event as a badge with its icon. A tournament is warm, as the design marks it. */
export function KindBadge({ kind, className }: { kind: string; className?: string }) {
  const name = useKindName();
  const Icon = KIND_ICONS[kind] ?? CalendarDays;
  return (
    <Badge tone={kind === "tournament" ? "warm" : "neutral"} icon={<Icon size={12} aria-hidden="true" />} className={className}>
      {name(kind)}
    </Badge>
  );
}

/** The cover of an event: its picture, or the pattern of its community's hue. */
export function EventCover({
  event,
  className,
  dim = false,
}: {
  event: Pick<EventCard, "cover" | "communityId">;
  className?: string;
  dim?: boolean;
}) {
  const { t } = useTranslation("events");
  const { apiBase } = useCommunityPlatform();
  const [broken, setBroken] = useState(false);
  const url = blobUrl(apiBase, event.cover);
  const shown = url !== null && !broken;
  return (
    <div
      className={cn("relative overflow-hidden", shown ? "bg-elevated" : "jkc-cover", dim && "jke-dim", className)}
      style={hueStyle(event.communityId)}
      role="img"
      aria-label={t("page.cover")}
    >
      {shown ? <img src={url} alt="" className="absolute inset-0 size-full object-cover" onError={() => setBroken(true)} /> : null}
    </div>
  );
}

/** The tile of a day: the weekday over the number, warm for the reader's own events. */
export function DateTile({
  weekday,
  day,
  month,
  tone = "neutral",
  size = "md",
}: {
  weekday: string;
  day: number;
  month?: string;
  tone?: "neutral" | "warm" | "past";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 flex-col items-center justify-center rounded-md border select-none",
        size === "sm" && "h-40 w-36",
        size === "md" && "h-56 w-48",
        size === "lg" && "h-64 w-56",
        tone === "warm" ? "border-transparent bg-warm-subtle" : "border-line bg-input",
      )}
    >
      <span className={cn("text-label-xs normal-case", tone === "warm" ? "text-fg-warm" : "text-fg-secondary")}>{weekday}</span>
      <span
        className={cn(
          "font-display font-semibold tabular-nums",
          size === "sm" ? "text-[16px] leading-[20px]" : size === "md" ? "text-[20px] leading-[24px]" : "text-[24px] leading-[28px]",
          tone === "past" ? "text-fg-secondary" : "text-fg",
        )}
      >
        {day}
      </span>
      {month ? <span className={cn("text-label-xs normal-case", tone === "warm" ? "text-fg-warm" : "text-fg-secondary")}>{month}</span> : null}
    </span>
  );
}

/** The community of an event: its logo and name, a link to its page. */
export function CommunityChip({ community, className }: { community: EventCommunityRef; className?: string }) {
  return (
    <RouteLink
      route={{ view: "community", id: community.id, tab: "overview" }}
      className={cn(
        "inline-flex min-h-28 max-w-full min-w-0 items-center gap-8 rounded-full border border-line bg-surface py-2 pr-12 pl-4 text-body-sm-medium text-fg hover:border-line-strong hover:bg-surface-hover",
        className,
      )}
    >
      <CommunityLogo card={{ id: community.id, name: community.name, logo: community.logo }} size="sm" className="rounded-full" />
      <span className="min-w-0 truncate" title={community.name}>
        {community.name}
      </span>
    </RouteLink>
  );
}

/** A link to a route of the events screens: a plain click moves within the host. */
export function EventLink({
  route,
  className,
  children,
  ariaLabel,
  title,
}: {
  route: EventsRoute;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
  title?: string;
}) {
  const platform = useEventsPlatform();
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    platform.navigate(route);
  };
  return (
    <a href={platform.href(route)} onClick={follow} className={className} aria-label={ariaLabel} title={title}>
      {children}
    </a>
  );
}

/** The moment now, moving every `every` milliseconds while the screen is open. */
export function useNow(every = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/**
 * The sentence of a refused read or write of an events screen: the codes the
 * events contract adds — a full event, a cancelled or ended one, a change
 * made meanwhile, the limit of upcoming events, a field the service refused
 * — and the sentences of the community screens for everything else.
 */
export function useEventFailureText(): (error: unknown) => string {
  const { t } = useTranslation("events");
  const community = useFailureText();
  return useCallback(
    (error: unknown) => {
      const kind = eventFailureKind(error);
      if (kind === "other") return community(error);
      return t(`errors.${kind}`);
    },
    [t, community],
  );
}

/** The three answers: **Going**, **Maybe**, **Not going**. */
export function RsvpControl({
  event,
  busy,
  disabled = false,
  size = "md",
  onAnswer,
  className,
}: {
  event: Pick<EventCard, "id" | "capacity" | "counts" | "viewer" | "title">;
  busy: boolean;
  disabled?: boolean;
  size?: "sm" | "md";
  onAnswer: (answer: RsvpStatus | null) => void;
  className?: string;
}) {
  const { t } = useTranslation("events");
  // «Not going» shows chosen only after the reader pressed it: the service keeps no such answer.
  const current = event.viewer?.rsvp ?? (isDeclined(event.id) ? "no" : null);
  const goingOpen = canGo(event);
  const options: Array<{ id: RsvpStatus | "no"; label: string; key: string }> = [
    { id: "going", label: t("rsvp.going"), key: "going" },
    { id: "maybe", label: t("rsvp.maybe"), key: "maybe" },
    { id: "no", label: t("rsvp.no"), key: "no" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t("rsvp.labelOf", { title: event.title })}
      aria-busy={busy || undefined}
      className={cn("flex gap-2 rounded-md border border-line bg-input p-2", className)}
    >
      {options.map((option) => {
        const on = current === option.id;
        const off = disabled || busy || (option.id === "going" && !goingOpen);
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off}
            title={option.id === "going" && !goingOpen ? t("rsvp.fullTitle") : undefined}
            onClick={() => {
              if (!on) onAnswer(option.id === "no" ? null : option.id);
            }}
            className={cn(
              "inline-flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-6 rounded-sm whitespace-nowrap select-none transition-colors",
              size === "sm" ? "min-h-24 px-8 py-2 text-body-sm-medium" : "min-h-30 px-8 py-4 text-body-sm-medium",
              "pointer-coarse:min-h-44",
              on && option.id === "going" && "bg-warm-subtle text-fg-warm",
              on && option.id === "maybe" && "bg-selected-overlay text-fg",
              on && option.id === "no" && "bg-selected-overlay text-fg-secondary",
              !on && "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
              "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-fg-disabled",
              on && "disabled:bg-selected-overlay",
            )}
          >
            {on && option.id === "going" ? <Check size={size === "sm" ? 12 : 14} strokeWidth={2.5} aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A small hue dot of a community, for a list that names many. */
export function HueDot({ communityId }: { communityId: string }) {
  return <span aria-hidden="true" className="jke-dot inline-block size-8 shrink-0 rounded-full" style={hueStyle(communityId)} />;
}

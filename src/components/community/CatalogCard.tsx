import { BadgeCheck, Gamepad2, Globe, Server, Sparkles, UserCheck, Bell } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Badge } from "../ui";
import { CommunityCover, CommunityLogo, LiveDot, RouteLink, TagChip } from "./bits";
import { CardFollowButton } from "./FollowControl";
import { formatCount, GAME_NAMES } from "./format";
import type { CommunityCard } from "./types";

/**
 * A community in the catalogue, as the design's A1 draws it: the cover with
 * the languages and region and the marks on it, the logo rising over its
 * edge, the name with the owner's check, the tagline, the tags, the numbers
 * and, at the foot, the games and **Follow**.
 *
 * The name is the link and its box covers the card, so the whole card
 * opens the page; the follow button sits above that box and stays a button.
 */
export function CatalogCard({
  card,
  following,
  busy,
  selected,
  onToggleFollow,
}: {
  card: CommunityCard;
  following: boolean;
  busy: boolean;
  selected: boolean;
  onToggleFollow: () => void;
}) {
  const { t, i18n } = useTranslation("community");
  const loose = t as unknown as (key: string) => string;
  const locale = [
    card.languages.map((code) => code.toUpperCase()).join(" · "),
    card.region ? loose(`regions.${card.region}`) : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const online = typeof card.counts.online === "number" ? card.counts.online : null;
  const games = card.games.map((game) => GAME_NAMES[game]).join(" · ");
  const servers = card.servers.length;

  return (
    <article
      className={cn(
        "@container/card relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface transition-colors hover:border-line-strong hover:bg-surface-hover",
        selected ? "border-line-accent" : "border-line",
      )}
    >
      <div className="relative h-56 shrink-0">
        <CommunityCover card={card} className="absolute inset-0" />
        {/* The languages keep their pill whole; marks that do not fit beside
            it move under it, still on the right, clear of the logo. */}
        <div className="absolute inset-x-8 top-8 flex flex-wrap items-start gap-4">
          {locale !== "" ? (
            <span
              className="inline-flex min-h-20 max-w-full shrink-0 items-center gap-4 rounded-full bg-scrim px-8 py-2 text-label-xs normal-case tracking-normal text-fg"
              title={t("card.locale")}
            >
              <Globe size={12} className="shrink-0 text-fg-secondary" aria-hidden="true" />
              <span className="truncate">{locale}</span>
            </span>
          ) : null}
          <span className="ml-auto flex min-w-0 flex-wrap justify-end gap-4">
            {card.featured ? (
              <Badge tone="purple" icon={<Sparkles size={12} />}>
                {t("badges.featured")}
              </Badge>
            ) : null}
            {!card.verified ? <Badge tone="warm">{t("badges.unverified")}</Badge> : null}
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-8 px-16 pb-16">
        {/* A card narrower than 320 px (a phone, the list pane of the web app) puts the name
            under the logo: beside it the name would break after nearly every word. */}
        <div className="-mt-24 flex min-w-0 items-start gap-12 @max-[320px]/card:flex-col @max-[320px]/card:gap-8">
          <CommunityLogo card={card} size="xl" className="shadow-[0_0_0_3px_var(--color-bg-surface)]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-28 @max-[320px]/card:w-full @max-[320px]/card:pt-0">
            <h3 className="flex min-w-0 items-center gap-6 text-heading-sm text-fg">
              <RouteLink
                route={{ view: "community", id: card.id, tab: "overview" }}
                className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-border-focus)]"
                title={card.name}
                current={selected}
              >
                {card.name}
              </RouteLink>
              {card.verified ? (
                <BadgeCheck size={16} className="shrink-0 text-fg-success" aria-label={t("badges.verified")} role="img" />
              ) : null}
            </h3>
            {card.tagline ? (
              <p className="line-clamp-2 text-body-sm text-fg-secondary [overflow-wrap:anywhere]" title={card.tagline}>
                {card.tagline}
              </p>
            ) : null}
          </div>
        </div>
        {card.tags.length > 0 ? (
          <div className="flex flex-wrap gap-4">
            {card.tags.map((tag) => (
              <TagChip key={tag}>{loose(`tagNames.${tag}`)}</TagChip>
            ))}
          </div>
        ) : null}
        <dl className="mt-auto grid grid-cols-3 gap-8 border-t border-line-subtle pt-12">
          <Stat
            icon={<Bell size={12} aria-hidden="true" className="text-fg-muted" />}
            value={formatCount(card.counts.followers, i18n.language)}
            label={t("stats.followers", { count: card.counts.followers })}
          />
          <Stat
            icon={<UserCheck size={12} aria-hidden="true" className="text-fg-muted" />}
            value={formatCount(card.counts.regulars, i18n.language)}
            label={t("card.regulars", { count: card.counts.regulars })}
          />
          {online !== null ? (
            <Stat icon={<LiveDot state={online > 0 ? "live" : "off"} />} value={formatCount(online, i18n.language)} label={t("stats.online")} />
          ) : (
            <Stat
              icon={<Server size={12} aria-hidden="true" className="text-fg-muted" />}
              value={formatCount(servers, i18n.language)}
              label={t("stats.servers", { count: servers })}
            />
          )}
        </dl>
        <div className="flex items-center gap-12 border-t border-line-subtle pt-12">
          <span className="flex min-w-0 flex-1 items-center gap-6 text-body-sm text-fg-secondary">
            <Gamepad2 size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
            <span className="min-w-0 truncate">{games !== "" ? games : t("card.noServers")}</span>
          </span>
          <CardFollowButton following={following} busy={busy} onToggle={onToggleFollow} />
        </div>
      </div>
    </article>
  );
}

function Stat({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse">
      <dt className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">
        {label}
      </dt>
      <dd className="flex items-center gap-6 text-heading-sm tabular-nums text-fg">
        {icon}
        {value}
      </dd>
    </div>
  );
}

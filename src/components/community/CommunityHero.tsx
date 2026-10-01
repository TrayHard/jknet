import { Clock, Crown, ExternalLink, Gamepad2, Globe, Languages, MapPin, MessageCircle, Pencil, Share2, Sparkles, Trophy, UserCheck, Bell } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Badge, Button } from "../ui";
import { CommunityCover, CommunityLogo, LiveDot, Notice, TagChip, useCopy } from "./bits";
import { FollowControl } from "./FollowControl";
import { formatCount, formatHours, GAME_NAMES, isHttps, LANGUAGE_NAMES, roundHours } from "./format";
import { useCommunityPlatform } from "./platform";
import type { Community } from "./types";

export interface HeroProps {
  community: Community;
  /** People on the servers now, when the host or the service knows. */
  online: number | null;
  /** The place in the top of the week, while the community is in it. */
  rank: number | null;
  /** Player-hours of the last 7 days, when the service counts them. */
  playerHours: number | null;
  organizer: boolean;
  /** Discord said the invite is not valid: a player gets no button that leads nowhere. */
  discordBroken: boolean;
  followBusy: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  onNotify: (notify: boolean) => void;
  onEdit: () => void;
}

/**
 * The hero of a community page, as the design's B2 draws it: the cover, the
 * logo over its edge, the name with the **JKNet community** mark, the
 * tagline, the games, languages, region, owner and tags, the actions —
 * **Follow** with its bell, Discord, the website, **Share** and, for an
 * organizer, **Edit page**, or **Manage on the website** where the host only
 * reads — and the numbers along the bottom. A number the
 * service does not count yet is left out rather than drawn as a zero.
 */
export function CommunityHero({
  community,
  online,
  rank,
  playerHours,
  organizer,
  discordBroken,
  followBusy,
  onFollow,
  onUnfollow,
  onNotify,
  onEdit,
}: HeroProps) {
  const { t, i18n } = useTranslation("community");
  const loose = t as unknown as (key: string) => string;
  const platform = useCommunityPlatform();
  const { copied, failed, copy } = useCopy();
  const link = platform.pageUrl(community.id);
  const language = i18n.language;

  const share = () => {
    if (platform.share) platform.share(community);
    else copy(link);
  };

  const stats: { key: string; value: string; label: ReactNode }[] = [
    {
      key: "followers",
      value: formatCount(community.counts.followers, language),
      label: (
        <>
          <Bell size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
          {t("stats.followers", { count: community.counts.followers })}
        </>
      ),
    },
    {
      key: "regulars",
      value: formatCount(community.counts.regulars, language),
      label: (
        <>
          <UserCheck size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
          {t("stats.regulars", { count: community.counts.regulars })}
        </>
      ),
    },
  ];
  if (online !== null) {
    stats.push({
      key: "online",
      value: formatCount(online, language),
      label: (
        <>
          <LiveDot state="live" pulse />
          {t("stats.online")}
        </>
      ),
    });
  }
  if (rank !== null) {
    stats.push({
      key: "rank",
      value: t("stats.rankValue", { rank }),
      label: (
        <>
          <Trophy size={14} className="shrink-0 text-fg-warm" aria-hidden="true" />
          {t("stats.rank")}
        </>
      ),
    });
  }
  if (playerHours !== null) {
    stats.push({
      key: "hours",
      value: formatHours(playerHours, language),
      label: (
        <>
          <Clock size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
          {t("stats.playerHours", { count: roundHours(playerHours) })}
        </>
      ),
    });
  }

  const languages = community.languages.map((code) => LANGUAGE_NAMES[code] ?? code.toUpperCase());
  const games = community.games.map((game) => GAME_NAMES[game]);

  return (
    <section aria-labelledby="community-name" className="rounded-lg border border-line bg-surface">
      <CommunityCover card={community} className="h-152 rounded-t-[11px]" label={t("card.cover", { name: community.name })} />
      <div className="flex flex-col gap-16 px-24 pb-20 @max-[560px]/community:px-16">
        <div className="flex items-start gap-20 @max-[560px]/community:flex-col @max-[560px]/community:gap-8">
          <CommunityLogo card={community} size="hero" className="-mt-48 shadow-[0_0_0_4px_var(--color-bg-surface)]" />
          <div className="flex min-w-0 flex-1 flex-col gap-4 pt-16 @max-[560px]/community:pt-0">
            <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
              {/* A phone sets a long name a size smaller (display-md), so it does not break after every word. */}
              <h1
                id="community-name"
                className="min-w-0 text-display-lg text-fg [overflow-wrap:anywhere] @max-[560px]/community:text-[length:22px] @max-[560px]/community:leading-[28px]"
              >
                {community.name}
              </h1>
              {community.featured ? (
                <Badge tone="purple" icon={<Sparkles size={12} />}>
                  {t("badges.featured")}
                </Badge>
              ) : null}
            </div>
            {community.tagline ? <p className="text-body-md text-fg-secondary [overflow-wrap:anywhere]">{community.tagline}</p> : null}
            <div className="flex flex-wrap items-center gap-x-16 gap-y-8 pt-6 text-body-sm text-fg-secondary">
              {games.length > 0 ? (
                <Meta icon={<Gamepad2 size={14} />} label={t("page.games")}>
                  {games.join(" · ")}
                </Meta>
              ) : null}
              {languages.length > 0 ? (
                <Meta icon={<Languages size={14} />} label={t("page.languages")}>
                  {languages.join(", ")}
                </Meta>
              ) : null}
              {community.region ? (
                <Meta icon={<MapPin size={14} />} label={t("page.region")}>
                  {loose(`regions.${community.region}`)}
                </Meta>
              ) : null}
              {community.owner ? (
                <Meta icon={<Crown size={14} />}>{t("page.owner", { name: community.owner.displayName })}</Meta>
              ) : (
                <Meta icon={<Crown size={14} />} warm>
                  {t("page.noOwner")}
                </Meta>
              )}
              {community.tags.length > 0 ? (
                <span className="flex flex-wrap gap-6" aria-label={t("page.tags")}>
                  {community.tags.map((tag) => (
                    <TagChip key={tag} outlined>
                      {loose(`tagNames.${tag}`)}
                    </TagChip>
                  ))}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-8">
          <FollowControl
            following={community.viewer?.following ?? false}
            notify={community.viewer?.notify ?? false}
            busy={followBusy}
            onFollow={onFollow}
            onUnfollow={onUnfollow}
            onNotify={onNotify}
          />
          {isHttps(community.discord) && !(discordBroken && !organizer) ? (
            <Button wrap icon={<MessageCircle size={16} />} onClick={() => platform.openExternal(community.discord)}>
              Discord
            </Button>
          ) : null}
          {isHttps(community.website) ? (
            <Button wrap icon={<Globe size={16} />} onClick={() => platform.openExternal(community.website)}>
              {t("page.website")}
            </Button>
          ) : null}
          <Button wrap icon={<Share2 size={16} />} onClick={share}>
            {platform.shareLabel ?? t("page.share")}
          </Button>
          {organizer && platform.canManage ? (
            <Button wrap icon={<Pencil size={16} />} className="ml-auto @max-[560px]/community:ml-0" onClick={onEdit}>
              {t("page.edit")}
            </Button>
          ) : organizer && platform.manageUrl ? (
            <Button
              wrap
              icon={<ExternalLink size={16} />}
              className="ml-auto @max-[560px]/community:ml-0"
              onClick={() => platform.openExternal(platform.manageUrl!(community.id))}
            >
              {t("manage.onWebsite")}
            </Button>
          ) : null}
        </div>
        {copied === link ? <Notice tone="success">{t("page.shared")}</Notice> : null}
        {failed === link ? <Notice tone="danger">{t("page.shareFailed", { link })}</Notice> : null}
      </div>

      <dl
        aria-label={t("stats.numbers")}
        className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px overflow-hidden rounded-b-[11px] border-t border-line-subtle bg-line-subtle"
      >
        {stats.map((stat) => (
          <div key={stat.key} className="flex min-w-0 flex-col-reverse justify-end gap-2 bg-surface px-24 pt-14 pb-16 @max-[560px]/community:px-16">
            <dt className="flex items-center gap-6 text-body-sm text-fg-secondary">{stat.label}</dt>
            <dd className="text-display-md tabular-nums text-fg">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Meta({ icon, children, warm = false, label }: { icon: ReactNode; children: ReactNode; warm?: boolean; label?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-6", warm && "text-fg-warm")} title={label}>
      <span className={cn("shrink-0", warm ? "text-fg-warm" : "text-fg-muted")} aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}

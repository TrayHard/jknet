import { ArrowLeft, ChevronRight, Plus, SearchX } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Tabs } from "../servers/Tabs";
import { Button, EmptyState } from "../ui";
import { ActivityPanel } from "./Activity";
import { AdminStrip } from "./AdminStrip";
import { isNotFound } from "./api";
import { Failure, LinkButton, Notice, Panel, PanelHead, RouteLink } from "./bits";
import { ClaimPanel } from "./ClaimPanel";
import { CommunityHero } from "./CommunityHero";
import { CommunityMarkdown } from "./CommunityMarkdown";
import { botShows, DiscordCard } from "./DiscordCard";
import { useFailureText } from "./errors";
import { orderedServers } from "./format";
import { ManageSummary } from "./ManageSummary";
import { NewsPanel, NewsTab, useNews } from "./News";
import { useCommunityApi, useCommunityPlatform, type ManageSection, type PageTab } from "./platform";
import { PlayPanel } from "./PlayPanel";
import { PlayersTab, RegularsPreview } from "./Regulars";
import { onlineCount, useLiveStatuses } from "./ServerBlock";
import { FilesCard, LinksCard } from "./SideCards";
// --- slice: community events ---
import { CommunityEventsTab, UpcomingEventsPanel } from "../events/CommunityEvents";
import { useOptionalEventsPlatform } from "../events/platform";
import type { Community } from "./types";
import { useAction, useRemote } from "./useRemote";

/**
 * How often a page that knows its servers only from the service's poll reads
 * itself again. The service polls every 5 minutes; a page read every two and
 * a half is never more than one poll behind.
 */
const PAGE_REFRESH_MS = 150_000;

/**
 * A community page, as the design's B3 draws it: the hero of B2, then the
 * tabs of B1 — **Overview**, **Servers**, **Events** where the host draws
 * events, **Players**, **News** and, for an organizer, **Manage**, which
 * sums the page up and leads to the management screen.
 *
 * The overview puts the upcoming events, the description, the news and
 * «When people play here» on the left and, on the right, **Play** with the
 * servers and the way in, Discord, the regular players, the recommended
 * files and the links. **Servers** splits **Play** in two and carries the
 * claim of a server for a page that has no owner yet.
 */
export function CommunityView({ id, tab: asked }: { id: string; tab: PageTab }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  // --- slice: community events --- the tab and the block draw where the host gives events.
  const eventsHost = useOptionalEventsPlatform();
  const { t: tEvents } = useTranslation("events");
  const account = platform.signedIn ? platform.accountId ?? "account" : "guest";

  const page = useRemote(`page:${id}:${account}`, () => api.get(id));
  const community = page.data;
  const players = useRemote(community ? `players:${id}:${account}` : null, () => api.players(id));
  const viewer = community?.viewer ?? null;
  const organizer = viewer !== null && (viewer.role !== null || viewer.isAdmin);
  // Every page reads its card: the JKNet bot may read a server the page has no invite to.
  const discord = useRemote(community ? `discord:${id}:${account}:${community.discord}` : null, () => api.discord(id));
  const activity = useRemote(community && community.servers.length > 0 ? `activity:${id}` : null, () => api.activity(id));
  const news = useNews(id, community !== undefined, account);
  // A post that comes out while the page is open joins its news.
  const subscribePosts = platform.subscribePosts;
  const refreshNews = news.refresh;
  useEffect(() => subscribePosts?.((communityId) => (communityId === id ? refreshNews() : undefined)), [subscribePosts, id, refreshNews]);
  const manager = organizer && platform.canManage;
  const tab: PageTab = asked === "manage" && !manager ? "overview" : asked;
  const claimable = community !== undefined && platform.canManage && community.ownerId === null && !organizer;
  const me = useRemote(claimable && platform.signedIn && tab === "servers" ? `me:${account}` : null, () => api.me());

  const servers = community ? orderedServers(community) : [];
  const live = useLiveStatuses(servers);
  // The website and the web app see a server through the service's poll alone, which the page carries: an open page reads itself again.
  const pollOnly = platform.serverStatus === undefined && servers.length > 0;
  const reloadPage = page.reload;
  useEffect(() => {
    if (!pollOnly) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") reloadPage();
    }, PAGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [pollOnly, reloadPage]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rulesOpen, setRulesOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const follow = useAction();
  const rulesId = useId();

  // A page opened from another starts at its first server, with nothing said.
  useEffect(() => {
    setSelectedId(null);
    setExpanded({});
    setNotice(null);
    setError(null);
  }, [id]);

  const selected = servers.find((server) => server.id === selectedId)?.id ?? servers[0]?.id ?? null;
  const isExpanded = (serverId: string) => expanded[serverId] ?? (tab === "servers" || serverId === selected);
  const toggle = (serverId: string) => setExpanded((current) => ({ ...current, [serverId]: !isExpanded(serverId) }));
  const go = (next: PageTab) => platform.navigate({ view: "community", id, tab: next });

  const rank = typeof community?.rank === "number" ? community.rank : null;
  // The launcher's own answers are fresher than the service's poll; the website and the web app have the poll alone.
  const online = onlineCount(live) ?? (typeof community?.counts.online === "number" ? community.counts.online : null);

  const onFollow = () =>
    follow.run(
      async () => {
        setError(null);
        page.set(await api.follow(id));
      },
      (reason) => setError(failure(reason)),
    );
  const onUnfollow = () =>
    follow.run(
      async () => {
        setError(null);
        await api.unfollow(id);
        page.set(
          (current) =>
            current && {
              ...current,
              viewer: current.viewer && { ...current.viewer, following: false, notify: false },
              counts: { ...current.counts, followers: Math.max(0, current.counts.followers - 1) },
            },
        );
      },
      (reason) => setError(failure(reason)),
    );
  const onNotify = (value: boolean) =>
    follow.run(
      async () => {
        setError(null);
        page.set(await api.follow(id, value));
      },
      (reason) => setError(failure(reason)),
    );
  /** The management screen, scrolled to a section: **Edit page**, **Fix the link**, **Add server**. */
  const manage = (section?: ManageSection) => platform.navigate({ view: "manage", id, section });
  const edit = () => manage("profile");
  const verified = (next: Community) => {
    if (next.id !== id) {
      platform.navigate({ view: "community", id: next.id, tab: "servers" });
      return;
    }
    page.set(next);
    me.reload();
    setNotice(t("claim.approved"));
  };

  const back = (
    <RouteLink
      route={{ view: "catalog", tab: "catalog" }}
      className="-ml-6 flex w-fit min-h-28 items-center gap-6 rounded-sm py-4 pr-10 pl-6 text-body-sm-medium text-fg-secondary hover:bg-hover-overlay hover:text-fg"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t("page.back")}
    </RouteLink>
  );

  if (!community) {
    return (
      <div className="flex flex-col gap-16">
        {platform.embedded ? null : back}
        {page.error ? (
          isNotFound(page.error) ? (
            <EmptyState
              icon={<SearchX size={24} />}
              title={t("page.notFoundTitle")}
              text={t("page.notFound")}
              action={
                <Button wrap onClick={() => platform.navigate({ view: "catalog", tab: "catalog" })}>
                  {t("page.back")}
                </Button>
              }
            />
          ) : (
            <Failure error={page.error} onRetry={page.reload} />
          )
        ) : (
          <p role="status" className="text-body-sm text-fg-muted">
            {t("common.loading")}
          </p>
        )}
      </div>
    );
  }

  const tabs = [
    { id: "overview" as const, label: t("tabs.overview") },
    { id: "servers" as const, label: t("tabs.servers"), count: servers.length },
    ...(eventsHost ? [{ id: "events" as const, label: tEvents("title"), count: community.counts.upcomingEvents }] : []),
    { id: "players" as const, label: t("tabs.players"), count: community.counts.regulars },
    // The count is exact only while every post came on the first page.
    { id: "news" as const, label: t("tabs.news"), count: news.remote.data && !news.hasMore ? news.posts.length : undefined },
    ...(manager ? [{ id: "manage" as const, label: t("tabs.manage") }] : []),
  ];

  const playProps = {
    community,
    servers,
    live,
    selectedId: selected,
    onSelect: setSelectedId,
    isExpanded,
    onToggle: toggle,
    organizer,
  };

  return (
    <div className="flex flex-col gap-16">
      {platform.embedded ? null : back}
      <CommunityHero
        community={community}
        online={online}
        rank={rank}
        organizer={organizer}
        discordBroken={discord.data?.inviteStatus === "invalid"}
        followBusy={follow.busy}
        onFollow={() => void onFollow()}
        onUnfollow={() => void onUnfollow()}
        onNotify={(value) => void onNotify(value)}
        onEdit={edit}
      />
      {viewer?.isAdmin && platform.canManage ? (
        <AdminStrip community={community} onChanged={(next) => page.set(next)} onOwner={() => manage("admin")} />
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <Tabs
        tabs={tabs}
        value={tab}
        onChange={go}
        className="overflow-x-auto pb-px [scrollbar-width:none]"
      />

      {tab === "overview" ? (
        <div className="grid grid-cols-[minmax(0,1fr)_352px] items-start gap-16 @max-[900px]/community:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-16">
            <UpcomingEventsPanel community={community} onAll={() => go("events")} />
            <Panel labelledBy="community-about">
              <PanelHead
                id="community-about"
                title={t("about.title")}
                end={manager ? <LinkButton onClick={edit}>{t("about.edit")}</LinkButton> : null}
              />
              {community.description.trim() !== "" ? (
                <CommunityMarkdown text={community.description} />
              ) : (
                <p className="text-body-sm text-fg-secondary">{t("about.empty")}</p>
              )}
              {community.rules.trim() !== "" ? (
                <>
                  <button
                    type="button"
                    aria-expanded={rulesOpen}
                    aria-controls={rulesOpen ? rulesId : undefined}
                    onClick={() => setRulesOpen((value) => !value)}
                    className="-ml-4 inline-flex min-h-28 w-fit cursor-pointer items-center gap-6 rounded-sm py-4 pr-8 pl-4 text-body-sm-medium text-fg hover:bg-hover-overlay"
                  >
                    <ChevronRight
                      size={16}
                      aria-hidden="true"
                      className={cn("text-fg-secondary transition-transform", rulesOpen && "rotate-90")}
                    />
                    {t("about.rules")}
                  </button>
                  {rulesOpen ? (
                    <div id={rulesId}>
                      <CommunityMarkdown className="jkc-md-rules" text={community.rules} />
                    </div>
                  ) : null}
                </>
              ) : null}
            </Panel>
            <NewsPanel news={news} organizer={manager && platform.renderNewsComposer !== undefined} onAll={() => go("news")} />
            <ActivityPanel remote={activity} />
          </div>
          <div className="flex min-w-0 flex-col gap-16">
            <PlayPanel {...playProps} mode="overview" />
            {community.discord.trim() !== "" || botShows(discord.data?.bot) ? (
              <DiscordCard
                community={community}
                info={discord.data}
                organizer={organizer}
                onFix={manager ? () => manage("links") : undefined}
                onBot={manager ? () => manage("bot") : undefined}
              />
            ) : null}
            <RegularsPreview remote={players} onAll={() => go("players")} />
            {platform.renderFiles ? platform.renderFiles(community) : <FilesCard community={community} />}
            <LinksCard community={community} discordBroken={discord.data?.inviteStatus === "invalid" && !organizer} />
          </div>
        </div>
      ) : null}

      {tab === "servers" ? (
        <div className="flex flex-col gap-16">
          <div className="flex flex-wrap items-center gap-x-16 gap-y-8">
            <p className="min-w-0 flex-1 basis-[320px] text-body-md text-fg-secondary">
              {t("servers.lead", { count: servers.length })}
              {organizer ? ` ${t("servers.organizerLead")}` : ""}
            </p>
            {manager ? (
              <Button wrap icon={<Plus size={16} />} onClick={() => manage("servers")}>
                {t("manage.servers.add")}
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_352px] items-start gap-16 @max-[900px]/community:grid-cols-1">
            <PlayPanel {...playProps} mode="servers" />
            <div className="flex min-w-0 flex-col gap-16">
              <PlayPanel {...playProps} mode="join" />
              {claimable ? (
                <ClaimPanel
                  servers={servers}
                  preferred={selected}
                  claims={me.data?.serverClaims ?? []}
                  onVerified={verified}
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "events" ? <CommunityEventsTab community={community} organizer={manager} /> : null}

      {tab === "players" ? <PlayersTab remote={players} /> : null}

      {tab === "news" ? <NewsTab community={community} news={news} organizer={manager} /> : null}

      {tab === "manage" && manager ? <ManageSummary community={community} discord={discord.data} onOpen={(section) => manage(section)} /> : null}
    </div>
  );
}

import { Bell, BellOff, ChevronDown, ChevronUp, Eye, Globe2, LogIn, Plus, Search, Settings2, SearchX, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Tabs } from "../servers/Tabs";
import { Badge, Button, EmptyState, Input, Select } from "../ui";
import { AdminReviews } from "./AdminReviews";
import {
  CATALOG_SORTS,
  COMMUNITY_LANGUAGES,
  COMMUNITY_REGIONS,
  COMMUNITY_TAGS,
  type CatalogQuery,
} from "./api";
import { CommunityLogo, Failure, hueStyle, LinkButton, Notice, RouteLink } from "./bits";
import { CatalogCard } from "./CatalogCard";
import { catalogRemedy, catalogVisibility, inCatalog } from "./catalogVisibility";
import { CreateDialog } from "./CreateDialog";
import { useFailureText } from "./errors";
import { formatCount, GAME_NAMES, LANGUAGE_NAMES } from "./format";
import { useCommunityApi, useCommunityPlatform, type CatalogTab } from "./platform";
import type { CommunityCard, CommunityRankingEntry, FollowedCommunity, MyCommunity } from "./types";
import { useAction, useRemote } from "./useRemote";

/** Cards a page of the catalogue asks for, and how many **Show more** adds. */
const PAGE = 60;
/** Tags shown before **More**. */
const FIRST_TAGS = 8;

/** What **Publish in the catalog** of a row of My communities came to. */
interface MineNotice {
  tone: "success" | "info";
  text: string;
}

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * The catalogue of communities, as the design's A1 draws it: the tabs
 * **Catalog**, **My communities** and **Following**; the top communities
 * while the service ranks them; the search, the language, the region and
 * the order; the tags; the cards.
 *
 * The game is the host's: the launcher's switch in the sidebar. A host
 * without one — the website, the web app — offers both games in a list of
 * its own.
 */
export function CommunityCatalog({ tab, selectedId }: { tab: CatalogTab; selectedId?: string }) {
  const { t } = useTranslation("community");
  const loose = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const account = platform.signedIn ? platform.accountId ?? "account" : "guest";

  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [tag, setTag] = useState<string | null>(null);
  const [language, setLanguage] = useState("");
  const [region, setRegion] = useState("");
  const [sort, setSort] = useState("featured");
  const [game, setGame] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [moreTags, setMoreTags] = useState(false);
  const [rankOpen, setRankOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [mineNotice, setMineNotice] = useState<MineNotice | null>(null);
  const action = useAction();

  const query: CatalogQuery = {
    game: platform.game ?? (game === "ja" || game === "jo" ? game : null),
    tag,
    language: language || null,
    region: region || null,
    q,
    sort,
    limit,
  };
  const queryKey = JSON.stringify(query);
  const filtersActive = tag !== null || language !== "" || region !== "" || q !== "" || game !== "";
  const catalog = useRemote(tab === "catalog" ? `catalog:${account}:${queryKey}` : null, () => api.catalog(query));
  // An empty catalogue with no filter on tells an administrator where the
  // pages without an owner are published, so it asks who the reader is too:
  // on a host that manages, the only one with **Publish in the catalog**.
  const emptyCatalog =
    platform.canManage && tab === "catalog" && catalog.data !== undefined && catalog.data.communities.length === 0 && !filtersActive;
  const ranking = useRemote(tab === "catalog" ? `ranking:${platform.game ?? ""}` : null, () => api.ranking());
  const following = useRemote(platform.signedIn ? `following:${account}` : null, () => api.following());
  const me = useRemote(platform.signedIn && (tab === "mine" || emptyCatalog) ? `me:${account}` : null, () => api.me());
  const reviews = useRemote(platform.canManage && me.data?.isAdmin && tab === "mine" ? `reviews:${account}` : null, () =>
    api.reviews(),
  );

  // A new filter starts from the first page.
  useEffect(() => setLimit(PAGE), [q, tag, language, region, sort, game, platform.game]);
  // What a publication came to belongs to the moment: another tab or account starts without it.
  useEffect(() => setMineNotice(null), [tab, account]);

  // --- slice: communities --- the launcher's server panel asks for the page
  // of a server: the community that has it opens, or the dialog to create one.
  const seedDone = useRef(false);
  useEffect(() => {
    const seed = platform.seed;
    if (!seed || seedDone.current) return;
    seedDone.current = true;
    api
      .catalog({ q: seed.address, limit: 20 })
      .then((found) => {
        const match = found.communities.find((card) =>
          card.servers.some((server) => server.address === seed.address && server.game === seed.game),
        );
        if (match) platform.navigate({ view: "community", id: match.id, tab: "overview" });
        else setCreateOpen(true);
      })
      .catch(() => setCreateOpen(true));
  }, [api, platform]);

  const followed = useMemo(() => new Map((following.data?.communities ?? []).map((item) => [item.id, item])), [following.data]);

  const toggleFollow = (card: CommunityCard) => {
    const on = followed.has(card.id);
    setToggling(card.id);
    void action
      .run(
        async () => {
          setError(null);
          if (on) {
            await api.unfollow(card.id);
            following.set((current) => current && { communities: current.communities.filter((item) => item.id !== card.id) });
            catalog.set((current) => current && bump(current, card.id, -1));
          } else {
            const page = await api.follow(card.id);
            following.set((current) => ({
              communities: [
                { ...page, notify: page.viewer?.notify ?? true, followedAt: new Date().toISOString() },
                ...(current?.communities ?? []).filter((item) => item.id !== card.id),
              ],
            }));
            catalog.set((current) => current && replaceCount(current, card.id, page.counts.followers));
          }
        },
        (reason) => setError(failure(reason)),
      )
      .finally(() => setToggling(null));
  };

  /**
   * **Publish in the catalog** of a row of My communities: an administrator
   * lists a page without an owner, as the switch of the administration does.
   * The row changes at once; then both lists read the service again — the
   * catalogue reads itself anew whenever its tab opens.
   */
  const publish = (card: MyCommunity) => {
    setPublishing(card.id);
    void action
      .run(
        async () => {
          setError(null);
          setMineNotice(null);
          const page = await api.admin(card.id, { listed: true });
          me.set(
            (current) =>
              current && {
                ...current,
                communities: current.communities.map((item) => (item.id === card.id ? { ...item, listed: page.listed } : item)),
              },
          );
          setMineNotice(
            inCatalog(page)
              ? { tone: "success", text: t("mine.published", { name: page.name }) }
              : { tone: "info", text: t("mine.publishedHidden", { name: page.name }) },
          );
          me.reload();
          catalog.reload();
        },
        (reason) => setError(failure(reason)),
      )
      .finally(() => setPublishing(null));
  };

  const reset = () => {
    setTag(null);
    setLanguage("");
    setRegion("");
    setSearch("");
    setGame("");
  };

  const tabs = [
    { id: "catalog" as const, label: t("tabs.catalog"), count: catalog.data?.total },
    { id: "mine" as const, label: t("tabs.mine"), count: platform.signedIn ? me.data?.communities.length : undefined },
    { id: "following" as const, label: t("tabs.following"), count: platform.signedIn ? following.data?.communities.length : undefined },
  ];

  const visibleTags = COMMUNITY_TAGS.filter((code, index) => index < FIRST_TAGS || moreTags || code === tag);
  const hiddenTags = COMMUNITY_TAGS.length - FIRST_TAGS;
  const cards = catalog.data?.communities ?? [];
  // The top is of every game; the catalogue of one game shows its places there, numbered as the service ranks them.
  const topEntries = (ranking.data ?? []).filter(
    (entry) => !query.game || entry.community.games.length === 0 || entry.community.games.includes(query.game),
  );

  return (
    <div className="flex flex-col">
      {platform.embedded ? null : (
        <div className="flex flex-wrap items-start gap-16 pb-24">
          <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-4">
            <h1 className="text-display-lg text-fg">{t("title")}</h1>
            <p className="text-body-md text-fg-secondary">{t("subtitle")}</p>
          </div>
          {platform.canManage ? (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-8 pt-4">
              <Button variant="primary" wrap icon={<Plus size={16} />} onClick={() => (platform.signedIn ? setCreateOpen(true) : platform.signIn())}>
                {t("catalog.create")}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {/* The tabs wrap on a narrow page instead of scrolling sideways: a phone shows every tab. */}
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={(next) => platform.navigate({ view: "catalog", tab: next })}
        className="flex-wrap pb-px"
      />

      {error ? (
        <div className="pt-16">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}

      {tab === "catalog" ? (
        <div className="flex flex-col gap-24 pt-24">
          {topEntries.length > 0 ? (
            <TopCommunities entries={topEntries} open={rankOpen} onToggle={() => setRankOpen((value) => !value)} />
          ) : null}

          <section aria-label={t("catalog.filters")} className="flex flex-col gap-12">
            <div className="flex flex-wrap items-center gap-8">
              <Input
                icon={<Search size={16} />}
                className="w-[320px] @max-[720px]/community:w-full"
                aria-label={t("catalog.search")}
                placeholder={t("catalog.searchPlaceholder")}
                value={search}
                maxLength={100}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Select
                label={t("catalog.language")}
                ariaLabel={t("catalog.language")}
                value={language}
                onChange={setLanguage}
                options={[
                  { value: "", label: t("catalog.anyLanguage") },
                  ...COMMUNITY_LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] ?? code })),
                ]}
              />
              <Select
                label={t("catalog.region")}
                ariaLabel={t("catalog.region")}
                value={region}
                onChange={setRegion}
                options={[
                  { value: "", label: t("catalog.anyRegion") },
                  ...COMMUNITY_REGIONS.map((code) => ({ value: code, label: loose(`regions.${code}`) })),
                ]}
              />
              {platform.game === undefined ? (
                <Select
                  label={t("catalog.game")}
                  ariaLabel={t("catalog.game")}
                  value={game}
                  onChange={setGame}
                  options={[
                    { value: "", label: t("catalog.anyGame") },
                    { value: "ja", label: GAME_NAMES.ja },
                    { value: "jo", label: GAME_NAMES.jo },
                  ]}
                />
              ) : null}
              <div className="ml-auto @max-[720px]/community:ml-0">
                <Select
                  label={t("catalog.sort")}
                  ariaLabel={t("catalog.sort")}
                  value={sort}
                  onChange={setSort}
                  options={CATALOG_SORTS.map((key) => ({ value: key, label: loose(`sort.${key}`) }))}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-x-16 gap-y-8">
              <div role="group" aria-label={t("catalog.tags")} className="flex min-w-0 flex-1 flex-wrap gap-8">
                <Chip on={tag === null} onClick={() => setTag(null)}>
                  {t("catalog.allTags")}
                </Chip>
                {visibleTags.map((code) => (
                  <Chip key={code} on={tag === code} onClick={() => setTag(tag === code ? null : code)}>
                    {loose(`tagNames.${code}`)}
                  </Chip>
                ))}
                <Chip dashed on={false} expanded={moreTags} onClick={() => setMoreTags((value) => !value)}>
                  {moreTags ? t("catalog.fewerTags") : t("catalog.moreTags", { count: hiddenTags })}
                </Chip>
              </div>
              {catalog.data ? (
                <span aria-live="polite" className="inline-flex min-h-28 shrink-0 items-center text-body-sm text-fg-secondary">
                  {cards.length < catalog.data.total
                    ? t("catalog.shown", { shown: cards.length, total: catalog.data.total })
                    : t("catalog.found", { count: catalog.data.total })}
                </span>
              ) : null}
            </div>
          </section>

          {catalog.error && !catalog.data ? (
            <Failure error={catalog.error} onRetry={catalog.reload} />
          ) : !catalog.data ? (
            <p role="status" className="text-body-sm text-fg-muted">
              {t("common.loading")}
            </p>
          ) : cards.length === 0 ? (
            filtersActive ? (
              <EmptyState
                icon={<SearchX size={24} />}
                title={t("catalog.noResults")}
                text={t("catalog.noResultsHint")}
                action={
                  <Button size="sm" wrap onClick={reset}>
                    {t("catalog.reset")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Globe2 size={24} />}
                title={t("catalog.empty")}
                text={t("catalog.emptyHint")}
                action={
                  <>
                    {/* An administrator's pages without an owner stay out until they are listed:
                        the line leads to the rows that list them. */}
                    {platform.canManage && me.data?.isAdmin ? (
                      <p className="max-w-[420px] text-body-sm text-fg-muted">
                        <Trans
                          t={t}
                          i18nKey="catalog.emptyAdmin"
                          components={[
                            <RouteLink
                              route={{ view: "catalog", tab: "mine" }}
                              className="text-fg-accent hover:underline hover:underline-offset-2"
                            >
                              {null}
                            </RouteLink>,
                          ]}
                        />
                      </p>
                    ) : null}
                    {platform.canManage ? (
                      <Button
                        variant="primary"
                        wrap
                        icon={<Plus size={16} />}
                        onClick={() => (platform.signedIn ? setCreateOpen(true) : platform.signIn())}
                      >
                        {t("catalog.create")}
                      </Button>
                    ) : null}
                  </>
                }
              />
            )
          ) : (
            <>
              <div className="grid grid-cols-3 gap-16 @max-[960px]/community:grid-cols-2 @max-[600px]/community:grid-cols-1">
                {cards.map((card) => (
                  <CatalogCard
                    key={card.id}
                    card={card}
                    following={followed.has(card.id)}
                    busy={toggling === card.id}
                    selected={card.id === selectedId}
                    onToggleFollow={() => toggleFollow(card)}
                  />
                ))}
              </div>
              {cards.length < catalog.data.total ? (
                <div className="flex justify-center">
                  <Button wrap disabled={catalog.loading} onClick={() => setLimit((value) => value + PAGE)}>
                    {t("common.more")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : tab === "mine" ? (
        <MineTab
          signedIn={platform.signedIn}
          loading={me.loading}
          error={me.error}
          onRetry={me.reload}
          communities={me.data?.communities ?? null}
          isAdmin={me.data?.isAdmin ?? false}
          onCreate={() => setCreateOpen(true)}
          reviews={platform.canManage && me.data?.isAdmin ? <AdminReviews remote={reviews} /> : null}
          notice={mineNotice}
          publishing={publishing}
          onPublish={publish}
        />
      ) : (
        <FollowingTab
          loading={following.loading}
          error={following.error}
          onRetry={following.reload}
          items={following.data?.communities ?? null}
          onChanged={(next) => following.set({ communities: next })}
        />
      )}

      {createOpen ? <CreateDialog seed={platform.seed} onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}

function bump(page: { communities: CommunityCard[]; total: number }, id: string, delta: number) {
  return {
    ...page,
    communities: page.communities.map((card) =>
      card.id === id ? { ...card, counts: { ...card.counts, followers: Math.max(0, card.counts.followers + delta) } } : card,
    ),
  };
}

function replaceCount(page: { communities: CommunityCard[]; total: number }, id: string, followers: number) {
  return {
    ...page,
    communities: page.communities.map((card) => (card.id === id ? { ...card, counts: { ...card.counts, followers } } : card)),
  };
}

/** A tag of the filter: pressed while it filters. */
function Chip({
  on,
  onClick,
  children,
  dashed = false,
  expanded,
}: {
  on: boolean;
  onClick: () => void;
  children: string;
  dashed?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={expanded === undefined ? on : undefined}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-28 cursor-pointer items-center gap-6 rounded-full border px-12 py-4 text-body-sm-medium transition-colors pointer-coarse:min-h-44",
        dashed && "border-dashed",
        on
          ? "border-line-accent bg-accent-subtle text-fg-accent"
          : "border-line bg-input text-fg-secondary hover:border-line-strong hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The top communities in the service's order, as the design's A1 draws its
 * top: three places on a podium, the rest on request. A bar measures a
 * place's followers against the most followed place shown.
 */
function TopCommunities({ entries, open, onToggle }: { entries: CommunityRankingEntry[]; open: boolean; onToggle: () => void }) {
  const { t, i18n } = useTranslation("community");
  const most = Math.max(1, ...entries.map((entry) => entry.followers));
  const share = (entry: CommunityRankingEntry) => `${Math.round((entry.followers / most) * 100)}%`;
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3, 10);
  return (
    <section aria-labelledby="community-top" className="flex flex-col gap-12">
      <div className="flex min-h-28 flex-wrap items-baseline gap-x-12 gap-y-4">
        <h2 id="community-top" className="text-heading-sm text-fg">
          {t("top.title")}
        </h2>
        {rest.length > 0 ? (
          <LinkButton onClick={onToggle} className="ml-auto self-center">
            {open ? t("top.collapse") : t("top.full")}
            {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </LinkButton>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-16 @max-[760px]/community:grid-cols-1">
        {podium.map((entry) => (
          <RouteLink
            key={entry.community.id}
            route={{ view: "community", id: entry.community.id, tab: "overview" }}
            ariaLabel={t("top.place", { rank: entry.rank, name: entry.community.name })}
            className="flex min-w-0 flex-col gap-12 rounded-lg border border-line bg-surface p-16 transition-colors hover:border-line-strong hover:bg-surface-hover"
          >
            <span className="flex min-w-0 items-center gap-12">
              <span className={cn("min-w-32 shrink-0 text-display-md tabular-nums", entry.rank === 1 ? "text-fg-warm" : "text-fg-secondary")}>
                {t("top.rank", { rank: entry.rank })}
              </span>
              <CommunityLogo card={entry.community} size="lg" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-md-medium text-fg">{entry.community.name}</span>
                <span className="text-body-sm text-fg-secondary">
                  <b className="font-semibold text-fg tabular-nums">{formatCount(entry.followers, i18n.language)}</b>{" "}
                  {t("stats.followers", { count: entry.followers })}
                </span>
              </span>
            </span>
            <span className="h-4 overflow-hidden rounded-full bg-elevated" aria-hidden="true" style={hueStyle(entry.community.id)}>
              <span className="jkc-hue-bar block h-full rounded-full" style={{ width: share(entry) }} />
            </span>
          </RouteLink>
        ))}
      </div>
      {open && rest.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-8">
          {rest.map((entry) => (
            <RouteLink
              key={entry.community.id}
              route={{ view: "community", id: entry.community.id, tab: "overview" }}
              className="grid min-h-40 grid-cols-[32px_24px_minmax(0,1fr)_minmax(80px,240px)_auto] items-center gap-12 rounded-md px-8 py-4 hover:bg-hover-overlay"
            >
              <span className="text-heading-sm tabular-nums text-fg-secondary">{t("top.rank", { rank: entry.rank })}</span>
              <CommunityLogo card={entry.community} size="sm" />
              <span className="truncate text-body-sm-medium text-fg">{entry.community.name}</span>
              <span className="h-4 overflow-hidden rounded-full bg-elevated" aria-hidden="true" style={hueStyle(entry.community.id)}>
                <span className="jkc-hue-bar block h-full rounded-full" style={{ width: share(entry) }} />
              </span>
              <span className="text-right text-body-sm tabular-nums text-fg-secondary">
                {formatCount(entry.followers, i18n.language)}
                <span className="sr-only"> {t("stats.followers", { count: entry.followers })}</span>
              </span>
            </RouteLink>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A row of **My communities** and **Following**: the logo, the name, a line
 * under it, the actions, and a `note` across the foot of the row when it has
 * more to say: why the catalogue leaves the community out, and the way in.
 */
function Row({
  card,
  badge,
  sub,
  note,
  actions,
}: {
  card: CommunityCard;
  badge?: React.ReactNode;
  sub: string;
  note?: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-16 rounded-lg border border-line bg-surface p-16">
      <CommunityLogo card={card} size="xl" />
      <div className="flex min-w-0 flex-1 basis-[220px] flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-8">
          <RouteLink
            route={{ view: "community", id: card.id, tab: "overview" }}
            className="min-w-0 text-heading-sm text-fg [overflow-wrap:anywhere] hover:text-fg-accent"
          >
            {card.name}
          </RouteLink>
          {badge}
        </div>
        <span className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">{sub}</span>
      </div>
      <div className="flex flex-wrap items-center gap-8">{actions}</div>
      {/* The whole width under the logo's column: the reason keeps to one line, and the actions above stay
          where the other rows have theirs. */}
      {note ? (
        <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-16 gap-y-8 border-t border-line-subtle pt-12 pl-64 @max-[560px]/community:pl-0">
          {note}
        </div>
      ) : null}
    </div>
  );
}

function MineTab({
  signedIn,
  loading,
  error,
  onRetry,
  communities,
  isAdmin,
  onCreate,
  reviews,
  notice,
  publishing,
  onPublish,
}: {
  signedIn: boolean;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  communities: MyCommunity[] | null;
  isAdmin: boolean;
  onCreate: () => void;
  reviews: React.ReactNode;
  /** What the last **Publish in the catalog** came to. */
  notice: MineNotice | null;
  /** The community being published, while it is. */
  publishing: string | null;
  onPublish: (card: MyCommunity) => void;
}) {
  const { t, i18n } = useTranslation("community");
  const platform = useCommunityPlatform();

  /** Why the catalogue leaves `card` out and what brings it in, or nothing while it lists it. */
  const catalogNote = (card: MyCommunity) => {
    const visibility = catalogVisibility(card);
    const remedy = catalogRemedy(visibility, { admin: isAdmin, canManage: platform.canManage });
    if (visibility.inCatalog) return { remedy, note: undefined };
    const why =
      visibility.gaps.length > 1 ? t("mine.why.both") : visibility.gaps[0] === "unlisted" ? t("mine.why.unlisted") : t("mine.why.noServer");
    const fix = remedy === "claim" ? t("mine.fix.claim") : remedy === "verify" ? t("mine.fix.verify") : null;
    return { remedy, note: fix ? `${why} ${fix}` : why };
  };
  if (!signedIn) {
    return (
      <EmptyState
        className="mt-24"
        icon={<LogIn size={24} />}
        title={t("mine.signInTitle")}
        text={t("mine.signInText")}
        action={
          <Button variant="primary" wrap onClick={platform.signIn}>
            {t("common.signIn")}
          </Button>
        }
      />
    );
  }
  if (error && communities === null) return <Failure className="mt-24" error={error} onRetry={onRetry} />;
  if (communities === null) {
    return (
      <p role="status" className="pt-24 text-body-sm text-fg-muted">
        {loading ? t("common.loading") : ""}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-16 pt-24">
      {reviews}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {communities.length === 0 ? (
        <EmptyState
          icon={<Users size={24} />}
          title={t("mine.emptyTitle")}
          text={t("mine.emptyText")}
          action={
            platform.canManage ? (
              <Button variant="primary" wrap icon={<Plus size={16} />} onClick={onCreate}>
                {t("catalog.create")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-8">
            {communities.map((card) => {
              const owner = card.owner ? t("mine.owner", { name: card.owner.displayName }) : t("mine.noOwner");
              const role =
                card.role === "owner" ? t("roles.owner") : card.role === "editor" ? t("roles.editor") : isAdmin ? t("roles.admin") : t("roles.creator");
              const { remedy, note } = catalogNote(card);
              return (
                <Row
                  key={card.id}
                  card={card}
                  badge={
                    <>
                      <Badge tone={card.role === "owner" ? "success" : card.role === "editor" ? "accent" : card.role ? "neutral" : "warm"}>{role}</Badge>
                      {note !== undefined ? <Badge tone="neutral">{t("mine.notInCatalog")}</Badge> : null}
                    </>
                  }
                  sub={[
                    owner,
                    t("card.servers", { count: card.servers.length }),
                    t("stats.followersCount", { count: card.counts.followers, formatted: formatCount(card.counts.followers, i18n.language) }),
                  ].join(" · ")}
                  note={
                    note === undefined ? undefined : (
                      <>
                        <span className="min-w-0 flex-1 basis-[240px] text-body-sm text-fg-secondary [overflow-wrap:anywhere]">{note}</span>
                        {remedy === "publish" ? (
                          <Button size="sm" wrap icon={<Eye size={14} />} disabled={publishing !== null} onClick={() => onPublish(card)}>
                            {t("manage.strip.publish")}
                          </Button>
                        ) : null}
                      </>
                    )
                  }
                  actions={
                    <>
                      <Button wrap onClick={() => platform.navigate({ view: "community", id: card.id, tab: "overview" })}>
                        {t("mine.open")}
                      </Button>
                      {platform.canManage && (card.role !== null || isAdmin) ? (
                        <Button
                          variant="primary"
                          wrap
                          icon={<Settings2 size={16} />}
                          onClick={() => platform.navigate({ view: "manage", id: card.id })}
                        >
                          {t("mine.manage")}
                        </Button>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </div>
          <p className="text-body-sm text-fg-secondary">{isAdmin ? t("mine.noteAdmin") : t("mine.note")}</p>
        </>
      )}
    </div>
  );
}

function FollowingTab({
  loading,
  error,
  onRetry,
  items,
  onChanged,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  items: FollowedCommunity[] | null;
  onChanged: (next: FollowedCommunity[]) => void;
}) {
  const { t, i18n } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const [problem, setProblem] = useState<string | null>(null);

  if (!platform.signedIn) {
    return (
      <EmptyState
        className="mt-24"
        icon={<LogIn size={24} />}
        title={t("following.signInTitle")}
        text={t("following.signInText")}
        action={
          <Button variant="primary" wrap onClick={platform.signIn}>
            {t("common.signIn")}
          </Button>
        }
      />
    );
  }
  if (error && items === null) return <Failure className="mt-24" error={error} onRetry={onRetry} />;
  if (items === null) {
    return (
      <p role="status" className="pt-24 text-body-sm text-fg-muted">
        {loading ? t("common.loading") : ""}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        className="mt-24"
        icon={<Bell size={24} />}
        title={t("following.emptyTitle")}
        text={t("following.emptyText")}
        action={
          <Button wrap onClick={() => platform.navigate({ view: "catalog", tab: "catalog" })}>
            {t("following.openCatalog")}
          </Button>
        }
      />
    );
  }

  const bell = (item: FollowedCommunity) =>
    action.run(
      async () => {
        setProblem(null);
        const page = await api.follow(item.id, !item.notify);
        onChanged(items.map((entry) => (entry.id === item.id ? { ...entry, notify: page.viewer?.notify ?? !item.notify } : entry)));
      },
      (reason) => setProblem(failure(reason)),
    );
  const unfollow = (item: FollowedCommunity) =>
    action.run(
      async () => {
        setProblem(null);
        await api.unfollow(item.id);
        onChanged(items.filter((entry) => entry.id !== item.id));
      },
      (reason) => setProblem(failure(reason)),
    );

  return (
    <div className="flex flex-col gap-16 pt-24">
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <div className="flex flex-col gap-8">
        {items.map((item) => {
          const label = item.notify ? t("follow.notifyOn") : t("follow.notifyOff");
          return (
            <Row
              key={item.id}
              card={item}
              sub={[
                t("stats.followersCount", { count: item.counts.followers, formatted: formatCount(item.counts.followers, i18n.language) }),
                item.notify ? t("following.notifyOn") : t("following.notifyOff"),
              ].join(" · ")}
              actions={
                <>
                  <Button
                    className={cn("w-36 px-0!", item.notify && "border-line-accent! bg-accent-subtle! text-fg-accent!")}
                    aria-pressed={item.notify}
                    aria-label={label}
                    title={label}
                    disabled={action.busy}
                    onClick={() => void bell(item)}
                  >
                    {item.notify ? <Bell size={16} /> : <BellOff size={16} />}
                  </Button>
                  <Button wrap onClick={() => platform.navigate({ view: "community", id: item.id, tab: "overview" })}>
                    {t("common.open")}
                  </Button>
                  <Button variant="ghost" wrap disabled={action.busy} onClick={() => void unfollow(item)}>
                    {t("follow.unfollow")}
                  </Button>
                </>
              }
            />
          );
        })}
      </div>
      <p className="text-body-sm text-fg-secondary">{t("following.note")}</p>
    </div>
  );
}

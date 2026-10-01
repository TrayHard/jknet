import { Newspaper, Pencil, Pin, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Avatar, Badge, Button, Dialog } from "../ui";
import { Failure, LinkButton, Notice, Panel, PanelHead } from "./bits";
import { CommunityMarkdown } from "./CommunityMarkdown";
import { useFailureText } from "./errors";
import { headline, mergePosts, orderPosts, overviewPosts, pinnedCount, plainText } from "./posts";
import { useCommunityApi, useCommunityPlatform } from "./platform";
import type { Community, CommunityPost, CommunityPosts } from "./types";
import { useAction, useRemote, type Remote } from "./useRemote";

/** The news of a page as the overview and the tab share them. */
export interface News {
  remote: Remote<CommunityPosts>;
  /** The posts read so far, in the service's order. */
  posts: CommunityPost[];
  /** More posts are older than the last one read. */
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
  moreError: unknown;
  /** A post went out or changed: the list takes it in its place. */
  upsert: (post: CommunityPost) => void;
  remove: (postId: string) => void;
  /**
   * A post came out elsewhere: the first page is read again and joins what
   * the list holds, the older pages read so far and the cursor kept.
   */
  refresh: () => void;
}

/**
 * The news of the community `id`: the first page — the pinned posts and the
 * 20 newest others — when the page opens, and the older ones a page at a
 * time on **Show more**, by the cursor the service names. A post written or
 * changed here takes its place in the list without a new read.
 */
export function useNews(id: string, enabled: boolean, account: string): News {
  const api = useCommunityApi();
  const remote = useRemote<CommunityPosts>(enabled ? `posts:${id}:${account}` : null, () => api.posts(id));
  const more = useAction();
  const [moreError, setMoreError] = useState<unknown>(null);
  const set = remote.set;

  const loadMore = useCallback(() => {
    const next = remote.data?.next;
    if (!next) return;
    setMoreError(null);
    void more.run(
      async () => {
        const page = await api.posts(id, { before: next });
        set((current) => current && { posts: mergePosts(current.posts, page.posts), next: page.next });
      },
      (reason) => setMoreError(reason),
    );
  }, [api, id, more, remote.data?.next, set]);

  const upsert = useCallback(
    (post: CommunityPost) => set((current) => current && { ...current, posts: mergePosts(current.posts.filter((item) => item.id !== post.id), [post]) }),
    [set],
  );
  const remove = useCallback(
    (postId: string) => set((current) => current && { ...current, posts: current.posts.filter((item) => item.id !== postId) }),
    [set],
  );

  // A refresh that answers after the page or the reader changed is dropped.
  const asking = `${id}:${account}`;
  const asked = useRef(asking);
  asked.current = asking;
  const loaded = remote.data !== undefined;
  const reload = remote.reload;
  const refresh = useCallback(() => {
    if (!enabled) return;
    // Nothing read yet, or the read failed: the whole read again.
    if (!loaded) {
      reload();
      return;
    }
    const round = asking;
    api.posts(id).then(
      (page) => {
        if (asked.current !== round) return;
        // The cursor stays: it points past the oldest post read, and the posts after it are still to come.
        set((current) => current && { posts: mergePosts(current.posts, page.posts), next: current.next });
      },
      () => undefined,
    );
  }, [api, asking, enabled, id, loaded, reload, set]);

  return {
    remote,
    posts: remote.data ? orderPosts(remote.data.posts) : [],
    hasMore: Boolean(remote.data?.next),
    loadMore,
    loadingMore: more.busy,
    moreError,
    upsert,
    remove,
    refresh,
  };
}

/** The day of a post in the reader's language: «29 September», with the year when it is not this one. */
function useDayText(): (iso: string) => string {
  const { i18n } = useTranslation("community");
  const language = i18n.language;
  return useCallback(
    (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      const thisYear = date.getFullYear() === new Date().getFullYear();
      try {
        return new Intl.DateTimeFormat(language, thisYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" }).format(date);
      } catch {
        return date.toISOString().slice(0, 10);
      }
    },
    [language],
  );
}

/** The full moment of a post, for the title of its day. */
function useMomentText(): (iso: string) => string {
  const { i18n } = useTranslation("community");
  return useCallback(
    (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      try {
        return new Intl.DateTimeFormat(i18n.language, { dateStyle: "long", timeStyle: "short" }).format(date);
      } catch {
        return iso;
      }
    },
    [i18n.language],
  );
}

/** «Kyle · 29 September»: who wrote a post and when. */
function useMeta(): (post: CommunityPost) => string {
  const { t } = useTranslation("community");
  const day = useDayText();
  return (post) => t("news.meta", { author: post.author?.displayName ?? t("news.formerOrganizer"), date: day(post.createdAt) });
}

function PinnedBadge() {
  const { t } = useTranslation("community");
  return (
    <Badge tone="warm" icon={<Pin size={12} />}>
      {t("news.pinned")}
    </Badge>
  );
}

/**
 * **News** of the overview, as the design's B3 draws it: the newest pinned
 * post with the start of its text, then the two newest others by their
 * lines, and **All news**. Hidden while the community has no news, except
 * for an organizer, who gets the way to the first post.
 */
export function NewsPanel({ news, organizer, onAll }: { news: News; organizer: boolean; onAll: () => void }) {
  const { t } = useTranslation("community");
  const meta = useMeta();
  const moment = useMomentText();
  const data = news.remote.data;
  if (news.remote.error && !data) return null;
  if (!data) return null;
  const shown = overviewPosts(news.posts);
  if (shown.length === 0 && !organizer) return null;
  return (
    <Panel labelledBy="community-news">
      <PanelHead
        id="community-news"
        title={t("news.title")}
        end={<LinkButton onClick={onAll}>{shown.length === 0 ? t("news.write") : t("news.all")}</LinkButton>}
      />
      {shown.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t("news.emptyOrganizer")}</p>
      ) : (
        shown.map((post, index) => (
          <article key={post.id} className={cn("flex min-w-0 flex-col gap-4", index > 0 && "border-t border-line-subtle pt-12")}>
            <div className="flex flex-wrap items-center gap-8">
              {post.pinned ? <PinnedBadge /> : null}
              <span className="text-body-sm text-fg-secondary" title={moment(post.createdAt)}>
                {meta(post)}
              </span>
            </div>
            <h3 className="text-body-md-medium text-fg [overflow-wrap:anywhere]">
              <button type="button" onClick={onAll} className="cursor-pointer text-left hover:text-fg-accent">
                {headline(post)}
              </button>
            </h3>
            {post.pinned && post.title.trim() !== "" ? (
              <p className="line-clamp-2 text-body-sm text-fg-secondary [overflow-wrap:anywhere]">{plainText(post.body)}</p>
            ) : null}
          </article>
        ))
      )}
    </Panel>
  );
}

/**
 * The **News** tab: the composer of an organizer on top, then the posts —
 * the pinned first, then the newest — and **Show more** while older ones
 * remain. An organizer changes a post in the composer and deletes it after
 * a question.
 */
export function NewsTab({ community, news, organizer }: { community: Community; news: News; organizer: boolean }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const meta = useMeta();
  const moment = useMomentText();
  const [editing, setEditing] = useState<CommunityPost | null>(null);
  const [deleting, setDeleting] = useState<CommunityPost | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const remove = useAction();
  const composerRef = useRef<HTMLDivElement>(null);
  const canWrite = organizer && platform.canManage && platform.renderNewsComposer !== undefined;
  const data = news.remote.data;

  // A notice of success goes after a while; a failure stays until the next action.
  useEffect(() => {
    if (notice?.tone !== "success") return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const edit = (post: CommunityPost) => {
    setNotice(null);
    setEditing(post);
    requestAnimationFrame(() => composerRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const confirmDelete = () => {
    const post = deleting;
    if (!post) return;
    void remove.run(
      async () => {
        await api.removePost(post.id);
        news.remove(post.id);
        if (editing?.id === post.id) setEditing(null);
        setDeleting(null);
        setNotice({ tone: "success", text: t("news.deleted") });
      },
      (reason) => {
        setDeleting(null);
        setNotice({ tone: "danger", text: t("news.deleteFailed", { reason: failure(reason) }) });
      },
    );
  };

  return (
    <div className="flex flex-col gap-16">
      {canWrite ? (
        <div ref={composerRef} className="scroll-mt-16">
          {platform.renderNewsComposer!({
            community,
            editing,
            pinned: pinnedCount(news.posts),
            onSaved: (post, created) => {
              news.upsert(post);
              setEditing(null);
              setNotice({ tone: "success", text: created ? t("news.published") : t("news.saved") });
            },
            onCancel: () => setEditing(null),
          })}
        </div>
      ) : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      {news.remote.error && !data ? <Failure error={news.remote.error} onRetry={news.remote.reload} /> : null}
      {!data && !news.remote.error ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {t("common.loading")}
        </p>
      ) : null}

      {data && news.posts.length === 0 ? (
        <Panel>
          <p className="flex items-start gap-8 text-body-sm text-fg-secondary">
            <Newspaper size={16} className="mt-1 shrink-0 text-fg-muted" aria-hidden="true" />
            <span>{canWrite ? t("news.emptyOrganizer") : t("news.empty")}</span>
          </p>
        </Panel>
      ) : null}

      {news.posts.map((post) => {
        const tools = platform.canManage && post.viewer?.canEdit === true;
        return (
          <Panel key={post.id} as="article" labelledBy={post.title.trim() !== "" ? `community-post-${post.id}` : undefined} className={cn("gap-8", editing?.id === post.id && "border-line-accent")}>
            <div className="flex min-h-28 items-center gap-8">
              <Avatar name={post.author?.displayName ?? "?"} src={post.author?.avatarUrl ?? null} size="sm" />
              <span className="min-w-0 text-body-sm text-fg-secondary [overflow-wrap:anywhere]" title={moment(post.createdAt)}>
                {meta(post)}
              </span>
              {post.pinned ? <PinnedBadge /> : null}
              {tools ? (
                <span className="ml-auto flex shrink-0 gap-2">
                  <ToolButton label={t("news.edit")} onClick={() => edit(post)}>
                    <Pencil size={16} />
                  </ToolButton>
                  <ToolButton label={t("news.delete")} onClick={() => setDeleting(post)}>
                    <Trash2 size={16} />
                  </ToolButton>
                </span>
              ) : null}
            </div>
            {post.title.trim() !== "" ? (
              <h3 id={`community-post-${post.id}`} className="text-heading-sm text-fg [overflow-wrap:anywhere]">
                {post.title}
              </h3>
            ) : null}
            <CommunityMarkdown text={post.body} />
          </Panel>
        );
      })}

      {news.moreError ? <Failure error={news.moreError} onRetry={news.loadMore} /> : null}
      {news.hasMore ? (
        <div className="flex justify-center">
          <Button wrap disabled={news.loadingMore} onClick={news.loadMore}>
            {news.loadingMore ? t("common.loading") : t("common.more")}
          </Button>
        </div>
      ) : null}

      {deleting ? (
        <Dialog
          variant="danger"
          title={t("news.deleteTitle")}
          body={t("news.deleteText", { title: headline(deleting) })}
          onClose={() => setDeleting(null)}
          actions={
            <>
              <Button variant="ghost" wrap onClick={() => setDeleting(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" wrap disabled={remove.busy} onClick={confirmDelete}>
                {t("news.deleteConfirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

/** An icon button of a post: **Edit**, **Delete**. */
function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-28 cursor-pointer items-center justify-center rounded-sm text-fg-secondary select-none hover:bg-hover-overlay hover:text-fg pointer-coarse:size-44"
    >
      {children}
    </button>
  );
}

/**
 * The computations of the news of a community, free of React and of any
 * host: the order of the posts, the pages put together, the posts of the
 * overview, the line a post is named by, and the checks of the composer.
 *
 * Pure, so `posts.test.mjs` checks it under `node --test`. The screens that
 * draw the news are `News.tsx` and the composer `manage/NewsComposer.tsx`.
 */

import type { CommunityPost } from "./types";

/** The longest title of a post, one line. */
export const MAX_POST_TITLE = 100;
/** The longest text of a post, Markdown. */
export const MAX_POST_BODY = 4000;
/** The most posts a community pins. */
export const MAX_PINNED = 3;
/** How long the line a post is named by may grow before it is cut. */
export const HEADLINE_CHARS = 90;

/** Characters as a person counts them: «ё» is one, an emoji is one. */
export function chars(text: string): number {
  return Array.from(text).length;
}

/**
 * The service's order: the pinned posts first, then the others, the newest
 * first in each, two of the same second by their ids, the latest first.
 */
export function orderPosts(posts: readonly CommunityPost[]): CommunityPost[] {
  const later = (a: CommunityPost, b: CommunityPost) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1);
  return [...posts].sort((a, b) => (a.pinned === b.pinned ? later(a, b) : a.pinned ? -1 : 1));
}

/** Two lists of posts as one, a post they share once in its newer form, in the service's order. */
export function mergePosts(current: readonly CommunityPost[], incoming: readonly CommunityPost[]): CommunityPost[] {
  const byId = new Map<string, CommunityPost>();
  for (const post of current) byId.set(post.id, post);
  for (const post of incoming) {
    const known = byId.get(post.id);
    if (known === undefined || known.revision <= post.revision) byId.set(post.id, post);
  }
  return orderPosts([...byId.values()]);
}

/**
 * The posts of the overview, as the design's B3 shows them: the newest
 * pinned post, then the two newest of the others.
 */
export function overviewPosts(posts: readonly CommunityPost[]): CommunityPost[] {
  const ordered = orderPosts(posts);
  const pinned = ordered.filter((post) => post.pinned).slice(0, 1);
  const others = ordered.filter((post) => !post.pinned).slice(0, 2);
  return [...pinned, ...others];
}

/**
 * Markdown as plain text on one line: the marks of headings, quotes, lists,
 * emphasis and code go, a link and a picture leave their text, the lines
 * join with spaces. Close enough for the line of a post in a list; the page
 * of the post draws the Markdown itself.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text cut to `max` characters, with an ellipsis when it was longer. */
export function cut(text: string, max: number): string {
  const letters = Array.from(text);
  return letters.length <= max ? text : `${letters.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The line a post is named by in a list: its title, else the start of its text. */
export function headline(post: Pick<CommunityPost, "title" | "body">): string {
  const title = post.title.trim();
  return title !== "" ? title : cut(plainText(post.body), HEADLINE_CHARS);
}

/** What the composer finds wrong before it sends a post. */
export interface PostProblems {
  title?: "tooLong" | "oneLine";
  body?: "required" | "tooLong";
}

/** The checks of the service, made before a request: a title of one line, a text of 1 to 4000 characters. */
export function postProblems(title: string, body: string): PostProblems {
  const problems: PostProblems = {};
  if (/[\r\n]/.test(title)) problems.title = "oneLine";
  else if (chars(title.trim()) > MAX_POST_TITLE) problems.title = "tooLong";
  const text = body.trim();
  if (text === "") problems.body = "required";
  else if (chars(text) > MAX_POST_BODY) problems.body = "tooLong";
  return problems;
}

/** How many posts a list pins. */
export function pinnedCount(posts: readonly CommunityPost[]): number {
  return posts.filter((post) => post.pinned).length;
}

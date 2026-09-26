/**
 * Who may do what in a group or a server chat, and what an answer of the
 * service means.
 *
 * --- slice: chat groups ---
 *
 * The service decides every one of these again; the rules here only keep the
 * interface from offering what it would refuse. A group has one owner, its
 * creator until they leave: only the owner renames it (D5), removes members
 * and changes «New members see history» (D1); any member adds their own
 * friends, and a friend who asks first gets an invitation instead. When the
 * owner leaves, the member who joined earliest takes over (D4); the last
 * member leaving deletes the group. A server chat is owned by its host, who
 * changes the history setting on the Play with friends screen, and a guest
 * may leave it (D9).
 *
 * Pure functions: `groups.test.mjs` runs them under `node --test`.
 */

import type {
  ChatAddResult,
  ChatMember,
  ChatRefusalReason,
  Conversation,
  Friend,
  OnlineUser,
} from "../ipc";
import { fold } from "./conversation.ts";

/** The most members a group holds, the owner included. */
export const GROUP_MAX_MEMBERS = 20;

/** The longest group name the service keeps, in characters. */
export const GROUP_TITLE_MAX = 64;

/** Whether I own the conversation: the owner of a group, the host of a server chat. */
export function ownsConversation(conversation: Conversation, meId: string | null): boolean {
  if (meId === null) return false;
  if (conversation.kind === "server") return (conversation.server?.hostId ?? conversation.ownerId) === meId;
  return conversation.kind === "group" && conversation.ownerId === meId;
}

/** **Rename**: the owner of a group only (D5). */
export function canRename(conversation: Conversation, meId: string | null): boolean {
  return conversation.kind === "group" && ownsConversation(conversation, meId);
}

/**
 * The switch «New members see history» in the group info: the owner of a
 * group only. A server chat's switch lives on the Play with friends screen.
 */
export function canChangeHistory(conversation: Conversation, meId: string | null): boolean {
  return conversation.kind === "group" && ownsConversation(conversation, meId);
}

/**
 * **Add friends**: any member of a group while its members leave room. The
 * invitations still waiting for an answer may have taken that room already;
 * only the service's answer tells (see `groupRoom`).
 */
export function canAddMembers(conversation: Conversation): boolean {
  return conversation.kind === "group" && groupRoom(conversation) > 0;
}

/** **Remove from group**: the owner removes anybody but themselves. */
export function canRemoveMember(conversation: Conversation, meId: string | null, userId: string): boolean {
  if (conversation.kind === "direct" || userId === meId) return false;
  if (!ownsConversation(conversation, meId)) return false;
  const owner = conversation.kind === "server" ? (conversation.server?.hostId ?? conversation.ownerId) : conversation.ownerId;
  return userId !== owner && conversation.members.some((member) => member.user.id === userId);
}

/**
 * How many more members a group takes at most; a new group counts me already.
 *
 * The service counts a seat for every member and for every invitation still
 * waiting for an answer, and a conversation does not say how many of those
 * it has. So for an existing group this is an upper bound: a pick past it is
 * refused for sure, a pick within it may still be refused as `full`, which
 * `outOfRoom` then reads. A new group has no invitations yet, so its room is
 * exact.
 */
export function groupRoom(conversation: Conversation | null): number {
  const members = conversation === null ? 1 : conversation.members.length;
  return Math.max(0, GROUP_MAX_MEMBERS - members);
}

/** The id of the owner, whoever owns a group or hosts a server chat. */
export function ownerIdOf(conversation: Conversation): string | null {
  if (conversation.kind === "server") return conversation.server?.hostId ?? conversation.ownerId;
  return conversation.ownerId;
}

function joinedAt(member: ChatMember): number {
  const at = Date.parse(member.joinedAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/** Earliest first; the id breaks a tie, as the service's order would. */
function byJoin(a: ChatMember, b: ChatMember): number {
  const diff = joinedAt(a) - joinedAt(b);
  if (diff !== 0) return diff;
  return a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0;
}

/** The members as the group info lists them: the owner first, then in the order they joined. */
export function orderMembers(conversation: Conversation): ChatMember[] {
  const owner = ownerIdOf(conversation);
  return conversation.members.slice().sort((a, b) => {
    if (a.user.id === owner && b.user.id !== owner) return -1;
    if (b.user.id === owner && a.user.id !== owner) return 1;
    return byJoin(a, b);
  });
}

/** What my leaving does to the conversation. */
export type LeaveOutcome =
  /** I am the last member: the group goes, with its history. */
  | { kind: "delete" }
  /** I own the group: the member who joined earliest becomes its owner (D4). */
  | { kind: "handover"; next: OnlineUser }
  /** I host the server chat: leaving ends it for everybody in it. */
  | { kind: "end" }
  /** I just leave. */
  | { kind: "leave" };

export function leaveOutcome(conversation: Conversation, meId: string | null): LeaveOutcome {
  const rest = conversation.members.filter((member) => member.user.id !== meId);
  if (conversation.kind === "server") return ownsConversation(conversation, meId) ? { kind: "end" } : { kind: "leave" };
  if (rest.length === 0) return { kind: "delete" };
  if (ownsConversation(conversation, meId)) {
    const next = rest.slice().sort(byJoin)[0];
    return { kind: "handover", next: next.user };
  }
  return { kind: "leave" };
}

/** How the picker orders friends: in a game, online, offline; then by name. */
const PRESENCE_RANK: Record<string, number> = { in_game: 0, online: 1, offline: 2 };

/**
 * The friends a picker offers: everybody not in `exclude`, whose name holds
 * the query (case and accents ignored), the ones who are around first.
 */
export function pickCandidates(friends: Friend[], exclude: ReadonlySet<string>, query: string): Friend[] {
  const needle = fold(query.trim());
  return friends
    .filter((friend) => !exclude.has(friend.user.id))
    .filter((friend) => needle === "" || fold(friend.user.displayName).includes(needle))
    .sort((a, b) => {
      const rank = (PRESENCE_RANK[a.presence.status] ?? 3) - (PRESENCE_RANK[b.presence.status] ?? 3);
      if (rank !== 0) return rank;
      return a.user.displayName.localeCompare(b.user.displayName, undefined, { sensitivity: "base" });
    });
}

/** The answer of a create or an add, sorted for the sentence that reports it. */
export interface AddOutcome {
  added: string[];
  invited: string[];
  /** The ids refused, by reason, reasons in a fixed order. */
  refused: Array<{ reason: ChatRefusalReason; userIds: string[] }>;
}

const REFUSAL_ORDER: ChatRefusalReason[] = ["full", "too_many_groups", "cooldown", "not_friend", "member"];

export function addOutcome(result: ChatAddResult): AddOutcome {
  const refused: AddOutcome["refused"] = [];
  for (const reason of REFUSAL_ORDER) {
    const userIds = result.refused.filter((entry) => entry.reason === reason).map((entry) => entry.userId);
    if (userIds.length > 0) refused.push({ reason, userIds });
  }
  // A reason this launcher does not know yet goes last, under its own name.
  const known = new Set<string>(REFUSAL_ORDER);
  for (const entry of result.refused) {
    if (known.has(entry.reason)) continue;
    const bucket = refused.find((group) => group.reason === entry.reason);
    if (bucket) bucket.userIds.push(entry.userId);
    else refused.push({ reason: entry.reason, userIds: [entry.userId] });
  }
  return { added: result.added.slice(), invited: result.invited.slice(), refused };
}

/** Whether an answer changed anything: somebody was added or invited. */
export function addedAnybody(outcome: AddOutcome): boolean {
  return outcome.added.length > 0 || outcome.invited.length > 0;
}

/**
 * Whether an answer turned somebody away for want of room. The service fills
 * the seats in the order of the request and refuses the rest as `full`, so
 * such an answer leaves the group without a free seat, whatever its member
 * count says: the invitations still waiting for an answer hold the others.
 */
export function outOfRoom(outcome: AddOutcome): boolean {
  return outcome.refused.some((group) => group.reason === "full");
}

/**
 * The server chat of a hosted session: the conversation whose server names
 * that session, hosted by me when `meId` is given. The core opens it after
 * the first heartbeat that carries the hosting, and opens a new one — a new
 * id — when the service ended it while the server still runs, so a window
 * finds it by the session every time rather than keeping its id.
 */
export function serverChatOf(
  conversations: Conversation[],
  sessionId: string,
  meId: string | null = null,
): Conversation | null {
  const wanted = sessionId.toLowerCase();
  return (
    conversations.find(
      (conversation) =>
        conversation.kind === "server" &&
        conversation.server !== null &&
        conversation.server.sessionId.toLowerCase() === wanted &&
        (meId === null || conversation.server.hostId === meId),
    ) ?? null
  );
}

/**
 * The web core's answer to every command of `lib/ipc.ts`.
 *
 * One `switch`, one command per case, the arguments under the names the IPC
 * wrappers send. Three kinds of answer:
 *
 * - implemented: the account, the settings, the friends and the chat here;
 *   the catalogs, push and the sessions join as their slices land;
 * - neutral: read-only launcher state whose empty answer is true in a
 *   browser (`neutral.ts`), counted in `stats.neutral`;
 * - refused with `needs_launcher`: anything that needs the game, local files
 *   or a native window, and anything unknown, counted in `stats.refused`.
 *   A refusal during e2e is a gating bug in the component that called.
 */

import type { ChatCore } from "./chat/index.ts";
import { needsLauncher, signedOut } from "./errors.ts";
import type { FriendsCore } from "./friends.ts";
import { neutralAnswer } from "./neutral.ts";
import type { Session } from "./session.ts";
import type { SettingsCore } from "./settings.ts";
import type { OnlineProvider } from "../../../src/lib/ipc.ts";

/** What the e2e run reads off `window.__jknetStats` in non-production builds. */
export interface CoreStats {
  refused: number;
  refusedCommands: string[];
  neutral: number;
  neutralCommands: string[];
  missingKeys: number;
  missingKeyList: string[];
}

export function createStats(): CoreStats {
  return { refused: 0, refusedCommands: [], neutral: 0, neutralCommands: [], missingKeys: 0, missingKeyList: [] };
}

export interface RouterDeps {
  apiBase: string;
  session: Session;
  settings: SettingsCore;
  friends: FriendsCore;
  chat: ChatCore;
  stats: CoreStats;
}

export type Args = Record<string, unknown>;
export type CommandRouter = (command: string, args?: Args) => Promise<unknown>;

const PROVIDERS: readonly string[] = ["jkhub", "discord", "dev"];

function text(args: Args, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function number(args: Args, name: string): number {
  const value = args[name];
  return typeof value === "number" ? value : Number.NaN;
}

function object(args: Args, name: string): Args {
  const value = args[name];
  return value !== null && typeof value === "object" ? (value as Args) : {};
}

export function createRouter(deps: RouterDeps): CommandRouter {
  const { session, settings, friends, chat, stats } = deps;

  const requireAccount = () => {
    if (!session.signedIn()) throw signedOut();
  };

  const route = async (command: string, args: Args): Promise<unknown> => {
    switch (command) {
      // -- Account ------------------------------------------------------------
      case "get_account_state":
        return session.accountState();
      case "get_online_url":
        return deps.apiBase;
      case "begin_sign_in": {
        const provider = text(args, "provider");
        if (!PROVIDERS.includes(provider)) throw needsLauncher(`${command}.${provider}`);
        const next = typeof args.next === "string" ? args.next : null;
        return session.beginSignIn(provider as OnlineProvider, next);
      }
      case "poll_sign_in":
        return session.poll(text(args, "sessionId"));
      case "sign_out":
        return session.signOut();
      case "update_display_name":
        requireAccount();
        return session.updateDisplayName(text(args, "displayName"));
      case "delete_account":
        requireAccount();
        return session.deleteAccount();

      // -- Settings -----------------------------------------------------------
      case "get_settings":
        return settings.get();
      case "update_settings": {
        const patch = args.patch;
        return settings.update(patch !== null && typeof patch === "object" ? (patch as Args) : {});
      }

      // -- Friends ------------------------------------------------------------
      case "get_friends_state":
        return friends.state();
      case "send_friend_request":
        requireAccount();
        return friends.sendRequest(text(args, "query"));
      case "accept_friend_request":
        requireAccount();
        return friends.accept(text(args, "id"));
      case "decline_friend_request":
        requireAccount();
        return friends.decline(text(args, "id"));
      case "remove_friend":
        requireAccount();
        return friends.remove(text(args, "userId"));
      case "dismiss_invite":
        requireAccount();
        return friends.dismissInvite(text(args, "id"));

      // -- Chat ---------------------------------------------------------------
      case "chat_get_state":
        return chat.view();
      case "chat_get_messages":
        return chat.getMessages(args);
      case "chat_open_direct":
        return chat.openDirect(text(args, "userId"));
      case "chat_send":
        return chat.send(text(args, "conversationId"), object(args, "draft"));
      case "chat_retry":
        return chat.retry(text(args, "clientId"));
      case "chat_discard":
        return chat.discard(text(args, "clientId"));
      case "chat_set_viewing":
        return chat.setViewing(args);
      case "chat_mark_read":
        return chat.markRead(text(args, "conversationId"));
      case "chat_typing":
        return chat.typing(text(args, "conversationId"));
      case "chat_react":
        return chat.react(text(args, "conversationId"), number(args, "seq"), text(args, "emoji"), args.on === true);
      case "chat_create_group":
        return chat.createGroup(args.title, args.memberIds);
      case "chat_rename_group":
        return chat.renameGroup(text(args, "conversationId"), text(args, "title"));
      case "chat_set_history_for_new_members":
        return chat.setHistoryForNewMembers(text(args, "conversationId"), args.on === true);
      case "chat_add_members":
        return chat.addMembers(text(args, "conversationId"), args.userIds);
      case "chat_remove_member":
        return chat.removeMember(text(args, "conversationId"), text(args, "userId"));
      case "chat_leave":
        return chat.leave(text(args, "conversationId"));
      case "chat_answer_group_invite":
        return chat.answerGroupInvite(text(args, "conversationId"), args.accept === true);
      case "chat_set_notify":
        return chat.setNotify(text(args, "conversationId"), text(args, "notify"));
      case "chat_search":
        return chat.search(args);
      case "chat_get_privacy":
        return chat.getPrivacy();
      case "chat_update_privacy":
        return chat.updatePrivacy(args.patch);
      case "chat_get_draft":
        return chat.getDraft(text(args, "conversationId"));
      case "chat_set_draft":
        return chat.setDraft(text(args, "conversationId"), text(args, "text"));
      case "chat_open_link":
        return chat.openLink(text(args, "url"), args.confirmed === true);
      case "chat_preview_sound":
        return chat.previewSound(args.soundName, args.mention);

      default: {
        const neutral = neutralAnswer(command);
        if (neutral !== undefined) {
          stats.neutral += 1;
          if (!stats.neutralCommands.includes(command)) stats.neutralCommands.push(command);
          return neutral.value;
        }
        stats.refused += 1;
        stats.refusedCommands.push(command);
        throw needsLauncher(command);
      }
    }
  };

  return (command, args) => route(command, args ?? {});
}

/**
 * The web core's answer to every command of `lib/ipc.ts`.
 *
 * One `switch`, one command per case, the arguments under the names the IPC
 * wrappers send. Three kinds of answer:
 *
 * - implemented: the account, the settings and the friends here; the chat,
 *   the catalogs, push and the sessions join as their slices land;
 * - neutral: read-only launcher state whose empty answer is true in a
 *   browser (`neutral.ts`), counted in `stats.neutral`;
 * - refused with `needs_launcher`: anything that needs the game, local files
 *   or a native window, and anything unknown, counted in `stats.refused`.
 *   A refusal during e2e is a gating bug in the component that called.
 */

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
  stats: CoreStats;
}

export type Args = Record<string, unknown>;
export type CommandRouter = (command: string, args?: Args) => Promise<unknown>;

const PROVIDERS: readonly string[] = ["jkhub", "discord", "dev"];

function text(args: Args, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

export function createRouter(deps: RouterDeps): CommandRouter {
  const { session, settings, friends, stats } = deps;

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

/**
 * The events of the web core, under the names `lib/ipc.ts` gives them.
 *
 * The shared hooks subscribe through `listen` of `lib/backend.ts`; the web
 * backend hands the subscription to this bus. One window, one bus: `own` and
 * `any` listeners hear the same events.
 *
 * The names are repeated here rather than imported so that the core's pure
 * modules load under `node --test`, which cannot resolve the extensionless
 * imports of `lib/ipc.ts`. `events.test.mjs` checks that each name still
 * appears in `lib/ipc.ts`.
 */

export const EVENTS = {
  /** `ACCOUNT_CHANGED_EVENT`: `{ signedIn, reason }`. */
  accountChanged: "account:changed",
  /** `friendsEvents.changed`: no payload, refetch `get_friends_state`. */
  friendsChanged: "friends:changed",
  /** `friendsEvents.presence`: `{ userId, presence }`. */
  friendsPresence: "friends:presence",
  /** `friendsEvents.invite`: the whole `Invite`. */
  friendsInvite: "friends:invite",
  /** `chatSettingsEvents` of the chat notification switches: `{ chatNotifications }`. */
  chatNotifications: "settings:chat-notifications",
} as const;

export type Handler = (payload: unknown) => void;

/** A synchronous, in-process event bus. A throwing handler never stops the others. */
export class EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emit(event: string, payload?: unknown): void {
    const set = this.handlers.get(event);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`A listener of ${event} failed`, error);
      }
    }
  }

  /** How many listeners an event has, for the tests. */
  count(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

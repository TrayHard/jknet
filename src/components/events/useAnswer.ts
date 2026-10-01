import { useCallback, useRef, useState } from "react";

import { useEventFailureText } from "./bits";
import { setDeclined } from "./declined";
import { withAnswer } from "./logic";
import { useEventsApi, useOptionalEventsPlatform } from "./platform";
import type { EventCard, EventDetails, RsvpStatus } from "./types";

/** The card a screen holds, with what the service answered after a «going» or «maybe». */
export function mergeAnswer<T extends EventCard>(card: T, page: EventDetails): T {
  return {
    ...card,
    status: page.status,
    capacity: page.capacity,
    counts: page.counts,
    viewer: page.viewer === null ? card.viewer : { ...(card.viewer ?? { rsvp: null, friendsGoing: [] }), rsvp: page.viewer.rsvp, friendsGoing: page.viewer.friendsGoing },
  };
}

/**
 * Answers an event: «going» and «maybe» through `PUT …/rsvp`, «not going»
 * through `DELETE …/rsvp`. One answer at a time; the screen hears the event
 * as it is after the answer, and the host hears that something changed.
 */
export function useAnswer(onAnswered: (event: EventCard) => void): {
  /** The event an answer is on its way for. */
  busyId: string | null;
  /** The refusal of the last answer, for the event it was about. */
  error: { id: string; text: string } | null;
  answer: (event: EventCard, value: RsvpStatus | null) => void;
} {
  const api = useEventsApi();
  const platform = useOptionalEventsPlatform();
  const failure = useEventFailureText();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const locked = useRef(false);
  const done = useRef(onAnswered);
  done.current = onAnswered;

  const answer = useCallback(
    (event: EventCard, value: RsvpStatus | null) => {
      if (locked.current) return;
      locked.current = true;
      setBusyId(event.id);
      setError(null);
      void (async () => {
        try {
          if (value === null) {
            await api.unrsvp(event.id);
            setDeclined(event.id, true);
            done.current(withAnswer(event, null));
          } else {
            const page = await api.rsvp(event.id, value);
            setDeclined(event.id, false);
            done.current(mergeAnswer(event, page));
          }
          platform?.onChanged?.();
        } catch (reason) {
          setError({ id: event.id, text: failure(reason) });
        } finally {
          locked.current = false;
          setBusyId(null);
        }
      })();
    },
    [api, platform, failure],
  );

  return { busyId, error, answer };
}

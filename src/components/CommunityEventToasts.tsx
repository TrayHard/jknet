import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useEventFormat } from "./events/format";
import type { EventNotice } from "./events/types";
import { useCommunityEventLabels, useCommunityEventNotices } from "../lib/useCommunityEvents";
import { useToasts } from "./ToastsProvider";
import { Button } from "./ui";

/** How long a toast of an event stays: a reminder longer, it is about to matter. */
const TOAST_MS = 20_000;
const REMINDER_MS = 120_000;

/** Opens the page of an event from anywhere in the launcher window. */
function openEvent(eventId: string) {
  window.location.hash = `#/events/${encodeURIComponent(eventId)}`;
}

/**
 * --- slice: community events ---
 *
 * The toasts of the events of communities: a new event of a community the
 * player follows, a change or a cancellation of an event they answered, and
 * the reminder 15 minutes before one. The core decides which frames deserve
 * a toast (`community_events::decide`) and shows the Windows notification
 * itself; a click on that one arrives here as `community:open-event`.
 *
 * The component also hands the core the words of those Windows
 * notifications in the language on screen. Mount it once, in the launcher
 * window, inside the toast column.
 */
export function CommunityEventToasts() {
  const { t } = useTranslation("events");
  const toasts = useToasts();
  const format = useEventFormat();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useCommunityEventLabels();

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useCommunityEventNotices(
    (notice: EventNotice) => {
      if (!notice.toast) return;
      const { event } = notice;
      const key = `community-event:${event.id}`;
      const start = Date.parse(event.startsAt);
      const values = {
        community: event.communityName,
        title: event.title,
        when: Number.isFinite(start) ? format.dayTime(start) : event.startsAt,
        place: event.address ?? t("place.offline"),
      };
      const reminder = notice.kind === "reminder";
      toasts.show(key, {
        variant: reminder || notice.kind === "cancelled" ? "warning" : "info",
        title: t(`notify.${notice.kind}`, values),
        text: t(`notify.${notice.kind}Text`, values),
        action: (
          <Button
            size="sm"
            variant={reminder ? "primary" : "secondary"}
            wrap
            onClick={() => {
              toasts.dismiss(key);
              openEvent(event.id);
            }}
          >
            {reminder ? t("notify.join") : t("notify.open")}
          </Button>
        ),
      });
      const before = timers.current.get(key);
      if (before) clearTimeout(before);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          toasts.dismiss(key);
        }, reminder ? REMINDER_MS : TOAST_MS),
      );
    },
    openEvent,
  );

  return null;
}

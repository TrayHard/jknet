/**
 * The events of communities: the calendar, the page of an event, its editor,
 * the events of a community page and the Home card, shared by the launcher,
 * the website and the web app. A host gives them a community platform and
 * an {@link EventsPlatform}.
 */

export { eventFailureKind, eventsApi, type EventFailureKind, type EventsApi } from "./api";
export { CommunityEventsTab, UpcomingEventsPanel } from "./CommunityEvents";
export { EventEditor, type EditorTarget } from "./EventEditor";
export { EventsCalendar, type CalendarScope, type CalendarView } from "./EventsCalendar";
export { EventView, RequirementsList, BundleLine } from "./EventView";
export { HomeEventsCard } from "./HomeEventsCard";
export {
  EventsPlatformProvider,
  useEventsApi,
  useEventsPlatform,
  useOptionalEventsPlatform,
  type EventsPlatform,
  type EventsRoute,
  type JkhubPick,
  type RequirementsContext,
} from "./platform";
export type * from "./types";

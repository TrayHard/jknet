import { CommunityFrame, CommunityPlatformProvider } from "../../../../src/components/community/index.ts";
import { EventView } from "../../../../src/components/events/EventView.tsx";
import { EventsPlatformProvider } from "../../../../src/components/events/platform.tsx";
import { useWebCommunityPlatform } from "../catalog/useCommunityPlatform.tsx";
import { useWebEventsPlatform } from "../catalog/useEventsPlatform.ts";

/**
 * One event in the detail pane: the shared page of the launcher and
 * jknet.app — when and where, the answer, the requirements with their JKHub
 * links and the calendar file. Preparing the client and joining stay with
 * JKNet on the PC, and the page says so.
 */
export function EventDetailsScreen({ eventId }: { eventId: string }) {
  const platform = useWebCommunityPlatform();
  const events = useWebEventsPlatform();
  return (
    <div className="web-catalog flex flex-col" data-testid="event-details">
      <CommunityPlatformProvider platform={platform}>
        <EventsPlatformProvider platform={events}>
          <CommunityFrame className="px-16 pt-8 pb-24">
            <EventView key={eventId} id={eventId} />
          </CommunityFrame>
        </EventsPlatformProvider>
      </CommunityPlatformProvider>
    </div>
  );
}

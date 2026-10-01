import { useTranslation } from "react-i18next";

import { CommunityFrame, CommunityPlatformProvider } from "../../../../src/components/community/index.ts";
import { EventsCalendar } from "../../../../src/components/events/EventsCalendar.tsx";
import { EventsPlatformProvider } from "../../../../src/components/events/platform.tsx";
import { useWebCommunityPlatform } from "../catalog/useCommunityPlatform.tsx";
import { useWebEventsPlatform } from "../catalog/useEventsPlatform.ts";

/**
 * The events of the communities in the list pane: the calendar of the
 * launcher and jknet.app as an agenda of a month, with its filters and the
 * answers. An event opens beside the list or, on a phone, in its place.
 */
export function EventsScreen() {
  const { t } = useTranslation("events");
  const platform = useWebCommunityPlatform();
  const events = useWebEventsPlatform();
  return (
    <div className="web-catalog flex flex-col" data-testid="events-list">
      <p className="px-16 pt-4 text-body-sm text-fg-secondary">{t("web.lead")}</p>
      <CommunityPlatformProvider platform={platform}>
        <EventsPlatformProvider platform={events}>
          <CommunityFrame className="px-16 pt-8 pb-24">
            <EventsCalendar compact />
          </CommunityFrame>
        </EventsPlatformProvider>
      </CommunityPlatformProvider>
    </div>
  );
}

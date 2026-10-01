import { useCallback, useState } from "react";
import { useLocation, useParams, useSearchParams } from "react-router";

import { CommunityFrame, CommunityPlatformProvider } from "../components/community";
import { Notice } from "../components/community/bits";
import { EventEditor, EventsCalendar, EventsPlatformProvider, EventView } from "../components/events";
import { useErrorText } from "../i18n/errors";
import { LauncherPlayProvider } from "./communityPlay";
import { useLauncherCommunityPlatform } from "./eventsHost";
import { useLauncherEventsPlatform } from "./eventsPlatform";

/**
 * **Events**: the calendar at `#/events`, the page of an event at
 * `#/events/:id`, its editor at `#/events/:id/edit` and a new event of a
 * community at `#/community/:communityId/events/new` (`?copy=` fills it
 * from an event a week later). The screens are the shared ones of
 * `components/events`; this page gives them the launcher.
 */
export function EventsPage() {
  const { id, communityId } = useParams();
  const location = useLocation();
  const [params] = useSearchParams();
  const errorText = useErrorText();
  const [externalError, setExternalError] = useState<string | null>(null);
  const onExternalError = useCallback((error: unknown) => setExternalError(errorText(error)), [errorText]);
  const community = useLauncherCommunityPlatform(onExternalError);
  const events = useLauncherEventsPlatform();
  const editing = id !== undefined && location.pathname.endsWith("/edit");
  const copyOf = params.get("copy") ?? undefined;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {externalError ? (
        <div className="px-24 pt-16">
          <Notice tone="danger">{externalError}</Notice>
        </div>
      ) : null}
      <CommunityPlatformProvider platform={community}>
        <EventsPlatformProvider platform={events}>
          <LauncherPlayProvider>
            <CommunityFrame className="p-24 @max-[560px]/community:p-16">
              {communityId ? (
                <EventEditor key={`new:${communityId}:${copyOf ?? ""}`} target={{ mode: "new", communityId, copyOf }} />
              ) : id && editing ? (
                <EventEditor key={`edit:${id}`} target={{ mode: "edit", id }} />
              ) : id ? (
                <EventView key={id} id={id} />
              ) : (
                <EventsCalendar />
              )}
            </CommunityFrame>
          </LauncherPlayProvider>
        </EventsPlatformProvider>
      </CommunityPlatformProvider>
    </div>
  );
}

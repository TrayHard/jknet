import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import { CommunityCatalog, CommunityFrame, CommunityPlatformProvider, catalogTab } from "../../../../src/components/community/index.ts";
import { communityRoutePath, useWebCommunityPlatform } from "../catalog/useCommunityPlatform.tsx";

/** The path of a community's page. */
export function communityPath(communityId: string): string {
  return communityRoutePath({ view: "community", id: communityId, tab: "overview" });
}

/**
 * The communities: the shared catalogue of the launcher and jknet.app, in
 * the list pane — the catalogue with its search and filters, the player's
 * own communities and the ones they follow — without its heading, which the
 * layout gives, and without creating a community. A card opens the page
 * beside the list or, on a phone, in its place.
 */
export function CommunityScreen({ selectedId }: { selectedId?: string }) {
  const { t: tWeb } = useTranslation("web");
  const [params] = useSearchParams();
  const platform = useWebCommunityPlatform();

  return (
    <div className="web-catalog flex flex-col" data-testid="community-list">
      <p className="px-16 pt-4 text-body-sm text-fg-secondary">{tWeb("catalog.communityLead")}</p>
      <CommunityPlatformProvider platform={platform}>
        <CommunityFrame className="px-16 pt-8 pb-24">
          <CommunityCatalog tab={catalogTab(selectedId ? null : params.get("tab"))} selectedId={selectedId} />
        </CommunityFrame>
      </CommunityPlatformProvider>
    </div>
  );
}

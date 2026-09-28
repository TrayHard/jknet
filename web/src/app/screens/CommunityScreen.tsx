import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { CommunityBrowser, type CommunityLabels } from "../../../../src/components/community/CommunityBrowser.tsx";
import { useAccountState } from "../../../../src/lib/queries.ts";
import { useCommunityRequest } from "../catalog/useCommunityRequest.ts";

/** The path of a community server's page. */
export function communityPath(serverId: string): string {
  return `/community/${encodeURIComponent(serverId)}`;
}

/**
 * The community servers: the catalog of jknet.app, read only. The
 * launcher's `CommunityBrowser` draws it — the search, the game, the
 * player's own pages — without its heading, which the layout gives, and
 * without adding, claiming or editing a page. A card opens the server's page
 * beside the list or, on a phone, in its place.
 */
export function CommunityScreen({ selectedId }: { selectedId?: string }) {
  const { t } = useTranslation("servers");
  const { t: tWeb } = useTranslation("web");
  const labels = t("community", { returnObjects: true }) as CommunityLabels;
  const account = useAccountState().data;
  const navigate = useNavigate();
  const request = useCommunityRequest();

  return (
    <div className="web-catalog flex flex-col" data-testid="community-list">
      <p className="px-16 pt-4 text-body-sm text-fg-secondary">{tWeb("catalog.communityLead")}</p>
      <CommunityBrowser
        request={request}
        labels={labels}
        signedIn={account?.onlineSignedIn ?? false}
        accountKey={account?.onlineUser?.id ?? ""}
        signIn={() => void navigate("/settings/account")}
        navigate={(id) => void navigate(id ? communityPath(id) : "/community")}
        readOnly
        embedded
        selectedId={selectedId}
      />
    </div>
  );
}

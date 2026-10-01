import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import { useShareDialog } from "../../../../src/components/chat/ShareToChatDialog.tsx";
import { CommunityFrame, CommunityPlatformProvider, CommunityView, pageTab } from "../../../../src/components/community/index.ts";
import type { Community } from "../../../../src/components/community/types.ts";
import { serverCard } from "../../../../src/lib/chat/cardDrafts.ts";
import type { ChatCard } from "../../../../src/lib/ipc.ts";
import { useWebCommunityPlatform } from "../catalog/useCommunityPlatform.tsx";

/**
 * A community's card for the chat: the address and game of its first
 * server, under the community's name. The page carries neither a map nor a
 * mode; the card's own check leaves them out. `null` for a community that
 * shows no server.
 */
export function communityServerCard(community: Community): ChatCard | null {
  const server = [...community.servers].sort((a, b) => a.position - b.position)[0];
  if (!server) return null;
  return serverCard({
    address: server.address,
    hostnameRaw: community.name,
    hostnameClean: community.name,
    game: server.game,
    map: "",
    gametype: -1,
    modName: "",
  });
}

/**
 * One community's page in the detail pane: the shared page of the launcher
 * and jknet.app, with its tabs. **Share** sends the community's server as a
 * card through the chat's share dialog. Joining and installing stay in JKNet
 * on the PC, and **Play** says so.
 */
export function CommunityDetailsScreen({ serverId }: { serverId: string }) {
  const { t: tChat } = useTranslation("chat");
  const [params] = useSearchParams();
  const share = useShareDialog();
  const platform = useWebCommunityPlatform(
    share.available
      ? {
          label: tChat("share.action"),
          run: (community) => {
            const card = communityServerCard(community);
            if (card) share.open({ kind: "card", card });
          },
        }
      : undefined,
  );

  return (
    <div className="web-catalog flex flex-col" data-testid="community-details">
      <CommunityPlatformProvider platform={platform}>
        <CommunityFrame className="px-16 pt-8 pb-24">
          <CommunityView key={serverId} id={serverId} tab={pageTab(params.get("tab"))} />
        </CommunityFrame>
      </CommunityPlatformProvider>
      {share.dialog}
    </div>
  );
}

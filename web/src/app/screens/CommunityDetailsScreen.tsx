import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useShareDialog } from "../../../../src/components/chat/ShareToChatDialog.tsx";
import { CommunityBrowser, type CommunityLabels } from "../../../../src/components/community/CommunityBrowser.tsx";
import type { CommunityServer } from "../../../../src/components/community/types.ts";
import { serverCard } from "../../../../src/lib/chat/cardDrafts.ts";
import type { ChatCard } from "../../../../src/lib/ipc.ts";
import { useAccountState } from "../../../../src/lib/queries.ts";
import { PlatformNote } from "../catalog/PlatformNote.tsx";
import { useCommunityRequest } from "../catalog/useCommunityRequest.ts";
import { communityPath } from "./CommunityScreen.tsx";

/**
 * A community server's card for the chat: its address, its name and its
 * game. The page carries neither a map nor a mode; the card's own check
 * leaves them out.
 */
export function communityServerCard(server: CommunityServer): ChatCard {
  return serverCard({
    address: server.address,
    hostnameRaw: server.name,
    hostnameClean: server.name,
    game: server.game,
    map: "",
    gametype: -1,
    modName: "",
  });
}

/**
 * One community server's page: what the owner wrote, the rules, the
 * recommended JKHub files, **Copy address** and **Share to chat**, which
 * sends the server as a card through the chat's share dialog. Joining and
 * installing the recommendations stay in JKNet on the PC, and the page says
 * so where the launcher offers them.
 */
export function CommunityDetailsScreen({ serverId }: { serverId: string }) {
  const { t } = useTranslation("servers");
  const { t: tWeb } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const labels = t("community", { returnObjects: true }) as CommunityLabels;
  const account = useAccountState().data;
  const navigate = useNavigate();
  const request = useCommunityRequest();
  const share = useShareDialog();

  return (
    <div className="web-catalog flex flex-col" data-testid="community-details">
      <CommunityBrowser
        request={request}
        labels={labels}
        signedIn={account?.onlineSignedIn ?? false}
        accountKey={account?.onlineUser?.id ?? ""}
        signIn={() => void navigate("/settings/account")}
        pageId={serverId}
        navigate={(id) => void navigate(id ? communityPath(id) : "/community")}
        readOnly
        embedded
        onShare={share.available ? (server) => share.open({ kind: "card", card: communityServerCard(server) }) : undefined}
        shareLabel={tChat("share.action")}
        renderInstall={() => <PlatformNote text={tWeb("catalog.playNote")} className="mt-12" />}
      />
      {share.dialog}
    </div>
  );
}

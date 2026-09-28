import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  BundleDetailsBody,
  bundleRecordCard,
  useBundleRecord,
} from "../../../../src/components/bundles/BundleDetailsDialog.tsx";
import { useShareDialog } from "../../../../src/components/chat/ShareToChatDialog.tsx";
import { Button } from "../../../../src/components/ui/index.ts";
import { PlatformNote } from "../catalog/PlatformNote.tsx";

/**
 * One bundle's page: the body of the launcher's bundle dialog drawn inline —
 * the owner, the languages, the description, the components with their
 * files, the versions — under the name and **Share to chat**, which sends the
 * bundle as a card through the chat's share dialog. The install, the client
 * windows and a look inside a file stay in JKNet on the PC; the platform's
 * capabilities leave them out of the body, and the page says where they are.
 */
export function BundleDetailsScreen({ bundleId }: { bundleId: string }) {
  const { t: tWeb } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const view = useBundleRecord(bundleId);
  const share = useShareDialog();
  const card = bundleRecordCard(view);
  const summary = view.text?.summary.trim() ?? "";

  return (
    <div className="flex flex-col gap-16 px-16 py-20 sm:px-32 sm:py-24" data-testid="bundle-details">
      <div className="flex flex-wrap items-start gap-12">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <h1 className="text-display-md text-fg [overflow-wrap:anywhere]">{view.title}</h1>
          {summary !== "" && view.text?.description.trim() !== "" ? (
            <p className="text-body-md text-fg-secondary [overflow-wrap:anywhere]">{summary}</p>
          ) : null}
        </div>
        {share.available && card !== null ? (
          <Button icon={<Share2 size={16} />} onClick={() => share.open({ kind: "card", card })}>
            {tChat("share.action")}
          </Button>
        ) : null}
      </div>
      <PlatformNote text={tWeb("catalog.installNote")} />
      <BundleDetailsBody view={view} />
      {share.dialog}
    </div>
  );
}

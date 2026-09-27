import { ChatPrivacyCard } from "../../../../src/components/chat/settings/ChatPrivacyCard.tsx";

/**
 * Settings · Privacy: the launcher's chat privacy card — read receipts and
 * typing, both ways (D8), and who may add the player to a group. The
 * switches live on the service, so they follow the account to every device.
 */
export function PrivacyScreen() {
  return (
    <div className="flex flex-col gap-16 px-16 py-24 sm:px-40 sm:py-32" data-testid="privacy-screen">
      <ChatPrivacyCard />
    </div>
  );
}

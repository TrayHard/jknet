import { Users } from "lucide-react";

import { Page, PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/ui";

/** Placeholder for the friends list. */
export function FriendsPage() {
  return (
    <Page>
      <PageHeader
        title="Friends"
        subtitle="See who is online and join their server in one click."
      />
      <EmptyState
        icon={<Users size={24} />}
        title="Friends need an account"
        text="Accounts, friend requests and Play with a friend arrive after the launcher can start a game."
      />
    </Page>
  );
}

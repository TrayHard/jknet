import { RefreshCw, Server } from "lucide-react";

import { Page, PageHeader } from "../components/PageHeader";
import { Button, EmptyState } from "../components/ui";

/** Placeholder for the server browser. The Rust side returns an empty list. */
export function ServersPage() {
  return (
    <Page>
      <PageHeader
        title="Servers"
        subtitle="Every online server, with the community ones marked as trusted."
        actions={
          <Button icon={<RefreshCw size={16} />} disabled>
            Refresh
          </Button>
        }
      />
      <EmptyState
        icon={<Server size={24} />}
        title="The browser is not connected yet"
        text="Master server queries arrive in a later task: address list, ping, map, mod and player count."
      />
    </Page>
  );
}

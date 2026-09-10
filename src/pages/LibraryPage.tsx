import { ExternalLink, Library } from "lucide-react";

import { Page, PageHeader } from "../components/PageHeader";
import { Button, EmptyState } from "../components/ui";

/** Placeholder for the pk3 library. */
export function LibraryPage() {
  return (
    <Page>
      <PageHeader
        title="Library"
        subtitle="Skins, hilts, maps and mods, installed into the client you choose."
        actions={
          <Button icon={<ExternalLink size={16} />} disabled>
            Browse JKHub
          </Button>
        }
      />
      <EmptyState
        icon={<Library size={24} />}
        title="Nothing in the library yet"
        text="Downloading from JKHub and installing files into a client arrive in a later task."
      />
    </Page>
  );
}

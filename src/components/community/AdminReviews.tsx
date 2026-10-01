import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";
import { Failure, Notice, Panel, PanelHead } from "./bits";
import { useFailureText } from "./errors";
import { useCommunityApi, useCommunityPlatform } from "./platform";
import type { CommunityReview } from "./types";
import { useAction, type Remote } from "./useRemote";

/**
 * The manual claims that wait for a JKNet administrator, as before
 * communities: who asks, for which server of which community, and
 * **Approve and feature** or **Decline**. An approval applies the same rules
 * as a code in `sv_hostname`.
 */
export function AdminReviews({ remote }: { remote: Remote<{ claims: CommunityReview[] }> }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const [error, setError] = useState<string | null>(null);
  const items = remote.data?.claims ?? [];

  const decide = (item: CommunityReview, approve: boolean) =>
    action.run(
      async () => {
        setError(null);
        await api.review(item.claim.id, approve, approve ? true : undefined);
        remote.set((current) => current && { claims: current.claims.filter((entry) => entry.claim.id !== item.claim.id) });
      },
      (reason) => setError(failure(reason)),
    );

  return (
    <Panel labelledBy="community-reviews">
      <PanelHead
        id="community-reviews"
        title={
          <span className="inline-flex items-center gap-8">
            <ShieldCheck size={16} className="text-fg-purple" aria-hidden="true" />
            {t("admin.title")}
          </span>
        }
      />
      {remote.error && !remote.data ? (
        <Failure error={remote.error} onRetry={remote.reload} />
      ) : items.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{remote.loading ? t("common.loading") : t("admin.empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.claim.id} className="flex flex-wrap items-center gap-12 border-t border-line-subtle py-12 first:border-t-0 first:pt-0">
              <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-2">
                <span className="text-body-md-medium text-fg [overflow-wrap:anywhere]">{item.community.name}</span>
                <span className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">
                  {t("admin.request", { user: item.user.displayName, address: item.communityServer.address })}
                </span>
                <span className="text-mono-xs text-fg-muted">{item.user.id}</span>
              </div>
              <div className="flex flex-wrap gap-8">
                <Button size="sm" wrap onClick={() => platform.navigate({ view: "community", id: item.community.id, tab: "servers" })}>
                  {t("common.open")}
                </Button>
                <Button size="sm" variant="primary" wrap disabled={action.busy} onClick={() => void decide(item, true)}>
                  {t("admin.approve")}
                </Button>
                <Button size="sm" variant="ghost" wrap disabled={action.busy} onClick={() => void decide(item, false)}>
                  {t("admin.reject")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Panel>
  );
}

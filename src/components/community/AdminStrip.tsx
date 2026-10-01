import { Check, ShieldCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";
import { Notice } from "./bits";
import { useFailureText } from "./errors";
import { inCatalog } from "./ManageSummary";
import { useCommunityApi } from "./platform";
import type { Community } from "./types";
import { useAction } from "./useRemote";

/**
 * The strip a JKNet administrator sees under the hero of any page, as the
 * design's B3 draws it: who owns the community and whether the catalogue
 * lists it, with the two marks an administrator sets in one press and the
 * way to the owner on the management screen.
 */
export function AdminStrip({
  community,
  onChanged,
  onOwner,
}: {
  community: Community;
  onChanged: (community: Community) => void;
  /** Opens the administration of the management screen. */
  onOwner: () => void;
}) {
  const { t } = useTranslation("community");
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const [error, setError] = useState<string | null>(null);
  const owned = community.ownerId !== null;
  const listed = inCatalog(community);

  const change = (body: { featured?: boolean; listed?: boolean }) =>
    action.run(
      async () => {
        setError(null);
        onChanged(await api.admin(community.id, body));
      },
      (reason) => setError(failure(reason)),
    );

  return (
    <section
      aria-label={t("manage.strip.title")}
      className="flex flex-col gap-8 rounded-lg border border-line bg-surface px-16 py-12"
    >
      <div className="flex flex-wrap items-center gap-x-16 gap-y-12">
        <span className="inline-flex items-center gap-8 text-heading-sm text-fg-purple">
          <ShieldCheck size={16} aria-hidden="true" />
          {t("manage.strip.title")}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 text-body-sm text-fg-secondary">
          <span>{community.owner ? t("manage.strip.owner", { name: community.owner.displayName }) : t("manage.strip.noOwner")}</span>
          <span aria-hidden="true">·</span>
          <span>
            {listed ? (owned ? t("manage.summary.inCatalog") : t("manage.summary.listed")) : t("manage.summary.notListed")}
          </span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-8">
          <Button size="sm" wrap icon={<UserPlus size={14} />} onClick={onOwner}>
            {owned ? t("manage.strip.changeOwner") : t("manage.strip.assignOwner")}
          </Button>
          <Button
            size="sm"
            wrap
            aria-pressed={community.listed && !owned}
            disabled={owned || action.busy}
            title={owned ? t("manage.admin.listedOwned") : undefined}
            icon={community.listed && !owned ? <Check size={14} /> : undefined}
            onClick={() => void change({ listed: !community.listed })}
          >
            {owned ? t("manage.strip.inCatalog") : community.listed ? t("manage.strip.published") : t("manage.strip.publish")}
          </Button>
          <Button
            size="sm"
            wrap
            aria-pressed={community.featured}
            disabled={action.busy}
            icon={community.featured ? <Check size={14} /> : undefined}
            onClick={() => void change({ featured: !community.featured })}
          >
            {t("manage.strip.featured")}
          </Button>
        </div>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </section>
  );
}

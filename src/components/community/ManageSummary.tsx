import { AlertTriangle, CheckCircle2, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Avatar, Badge, Button } from "../ui";
import { Panel, PanelHead } from "./bits";
import { inCatalog } from "./catalogVisibility";
import { hostOf } from "./format";
import { useCommunityPlatform, type ManageSection } from "./platform";
import type { Community, CommunityDiscord } from "./types";

/** A line of a card: a check that passed, or one that wants attention. */
function Line({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <p className="flex items-start gap-8 text-body-sm text-fg-secondary [overflow-wrap:anywhere]">
      {ok === true ? <CheckCircle2 size={16} className="mt-1 shrink-0 text-fg-success" aria-hidden="true" /> : null}
      {ok === false ? <AlertTriangle size={16} className="mt-1 shrink-0 text-fg-warm" aria-hidden="true" /> : null}
      {ok === null ? <span className="mt-6 size-6 shrink-0 rounded-full bg-fg-muted" aria-hidden="true" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * The **Manage** tab of a page, as the design's B3 draws it: three cards that
 * say how the community stands — its owner and editors, its verification
 * and its place in the catalogue, its Discord — and **Open management**,
 * which leads to the management screen.
 */
export function ManageSummary({
  community,
  discord,
  onOpen,
}: {
  community: Community;
  /** What the service says of the invite; `undefined` while it is asked or when there is none. */
  discord: CommunityDiscord | undefined;
  onOpen: (section?: ManageSection) => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const me = platform.accountId;
  const admin = community.viewer?.isAdmin === true;
  const pending = community.servers.filter((server) => !server.verified).length;
  const total = community.servers.length;
  const listed = inCatalog(community);

  const widget = discord?.inviteStatus === "ok" ? discord.widget : null;

  return (
    <div className="flex flex-col gap-16">
      <div className="grid grid-cols-3 items-start gap-16 @max-[1000px]/community:grid-cols-2 @max-[640px]/community:grid-cols-1">
        <Panel labelledBy="community-summary-team">
          <PanelHead id="community-summary-team" title={t("manage.summary.team")} />
          {community.owner ? (
            <div className="flex min-h-32 min-w-0 items-center gap-10">
              <Avatar name={community.owner.displayName} src={community.owner.avatarUrl} size="sm" />
              <span className="min-w-0 flex-1 text-body-sm-medium text-fg [overflow-wrap:anywhere]">{community.owner.displayName}</span>
              <Badge tone="warm">{community.owner.id === me ? t("manage.summary.ownerYou") : t("roles.owner")}</Badge>
            </div>
          ) : (
            <Line ok={false}>{t("manage.summary.noOwner")}</Line>
          )}
          {community.editors.map((editor) => (
            <div key={editor.id} className="flex min-h-32 min-w-0 items-center gap-10">
              <Avatar name={editor.displayName} src={editor.avatarUrl} size="sm" />
              <span className="min-w-0 flex-1 text-body-sm-medium text-fg [overflow-wrap:anywhere]">{editor.displayName}</span>
              <Badge tone={editor.id === me ? "accent" : "neutral"}>{editor.id === me ? t("manage.summary.editorYou") : t("roles.editor")}</Badge>
            </div>
          ))}
          <p className="text-body-sm text-fg-secondary">{admin && community.ownerId === null ? t("manage.summary.teamNoteAdmin") : t("manage.summary.teamNote")}</p>
        </Panel>

        <Panel labelledBy="community-summary-status">
          <PanelHead id="community-summary-status" title={t("manage.summary.status")} />
          <Line ok={community.ownerId !== null}>
            {community.owner ? t("manage.summary.owned", { name: community.owner.displayName }) : t("manage.summary.unowned")}
          </Line>
          <Line ok={total > 0 && pending === 0}>
            {total === 0
              ? t("manage.summary.noServers")
              : pending > 0
                ? t("manage.summary.serversPending", { count: pending })
                : t("manage.summary.serversVerified", { count: total })}
          </Line>
          <Line ok={listed}>
            {listed ? (community.ownerId !== null ? t("manage.summary.inCatalog") : t("manage.summary.listed")) : t("manage.summary.notListed")}
          </Line>
        </Panel>

        <Panel labelledBy="community-summary-discord">
          <PanelHead id="community-summary-discord" title={t("discord.titlePlain")} />
          {community.discord.trim() === "" ? (
            <Line ok={null}>{t("manage.summary.inviteNone")}</Line>
          ) : discord === undefined ? (
            <Line ok={null}>{t("manage.summary.inviteUnknown")}</Line>
          ) : discord.inviteStatus === "ok" ? (
            <Line ok>{t("manage.summary.inviteOk", { invite: hostOf(community.discord) })}</Line>
          ) : discord.inviteStatus === "invalid" ? (
            <Line ok={false}>{t("manage.summary.inviteInvalid")}</Line>
          ) : discord.inviteStatus === "none" ? (
            <Line ok={false}>{t("manage.summary.inviteNotInvite")}</Line>
          ) : (
            <Line ok={null}>{t("manage.summary.inviteUnknown")}</Line>
          )}
          {widget?.enabled === true ? <Line ok>{t("manage.summary.widgetOn", { count: widget.online })}</Line> : null}
          {widget?.enabled === false ? <Line ok={false}>{t("manage.summary.widgetOff")}</Line> : null}
        </Panel>
      </div>
      <div className="flex flex-wrap items-center gap-16">
        <Button variant="primary" wrap icon={<Settings2 size={16} />} onClick={() => onOpen()}>
          {t("manage.summary.open")}
        </Button>
        <span className="text-body-sm text-fg-secondary">{t("manage.summary.openText")}</span>
      </div>
    </div>
  );
}

import {
  CirclePlay,
  ExternalLink,
  Gamepad2,
  Globe,
  Layers,
  Link2,
  MessageCircle,
  Package,
  Send,
  Tv,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";
import { Panel, PanelHead } from "./bits";
import { hostOf, isHttps, LINK_NAMES } from "./format";
import { useCommunityPlatform } from "./platform";
import type { Community, CommunityBundleRef } from "./types";

/** The address of a file's page on JKHub. */
export function jkhubPage(id: number): string {
  return `https://jkhub.org/files/file/${id}/`;
}

/**
 * The recommended files of a page where nothing can be installed: each file
 * with a link to its JKHub page, the bundle when there is one, and a line
 * that says the launcher installs them. The launcher draws its own list,
 * with what the chosen client already has.
 */
export function FilesCard({ community }: { community: Community }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  if (community.recommendations.length === 0 && community.bundle === null) return null;
  return (
    <Panel labelledBy="community-files">
      <PanelHead id="community-files" title={t("files.title")} end={<span className="text-body-sm text-fg-secondary">{t("files.note")}</span>} />
      <ul className="flex flex-col gap-12">
        {community.recommendations.map((file) => (
          <li key={file.jkhubId} data-testid="community-file" className="flex min-w-0 items-center gap-10">
            <span className="flex size-32 shrink-0 items-center justify-center rounded-md bg-elevated text-fg-secondary" aria-hidden="true">
              <Package size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-body-sm-medium text-fg [overflow-wrap:anywhere]">{file.title}</span>
              <span className="text-mono-xs text-fg-secondary">{t("files.source", { id: file.jkhubId })}</span>
            </span>
            <a
              href={jkhubPage(file.jkhubId)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                platform.openExternal(jkhubPage(file.jkhubId));
              }}
              className="inline-flex size-28 shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg pointer-coarse:size-44"
              aria-label={`${t("files.view")}: ${file.title}`}
              title={t("files.view")}
            >
              <ExternalLink size={14} />
            </a>
          </li>
        ))}
        {community.bundle ? <BundleRow bundle={community.bundle} /> : null}
      </ul>
      {platform.renderPlay ? null : <p className="text-body-sm text-fg-secondary">{t("files.installInLauncher")}</p>}
    </Panel>
  );
}

/** The bundle a community recommends as its client, with **Open** where the host can show it. */
export function BundleRow({ bundle }: { bundle: CommunityBundleRef }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  return (
    <li className="flex min-w-0 items-center gap-10">
      <span className="flex size-32 shrink-0 items-center justify-center rounded-md bg-purple-subtle text-fg-purple" aria-hidden="true">
        <Layers size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-sm-medium text-fg [overflow-wrap:anywhere]">{bundle.name}</span>
        <span className="text-body-sm text-fg-secondary">{t("files.bundle")}</span>
      </span>
      {platform.openBundle ? (
        <Button size="sm" wrap onClick={() => platform.openBundle?.(bundle.id)}>
          {t("common.open")}
        </Button>
      ) : null}
    </li>
  );
}

const LINK_ICONS: Record<string, ReactNode> = {
  youtube: <CirclePlay size={16} />,
  twitch: <Tv size={16} />,
  telegram: <Send size={16} />,
  vk: <Users size={16} />,
  steam: <Gamepad2 size={16} />,
  github: <Link2 size={16} />,
};

/** The website, the Discord invite and the other links of a page, each opening outside. */
export function LinksCard({ community, discordBroken = false }: { community: Community; discordBroken?: boolean }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const rows: { key: string; name: string; url: string; icon: ReactNode }[] = [];
  if (isHttps(community.website)) rows.push({ key: "website", name: t("links.website"), url: community.website, icon: <Globe size={16} /> });
  if (isHttps(community.discord) && !discordBroken) rows.push({ key: "discord", name: "Discord", url: community.discord, icon: <MessageCircle size={16} /> });
  community.links.forEach((link, index) => {
    if (!isHttps(link.url)) return;
    rows.push({
      key: `${index}-${link.url}`,
      name: LINK_NAMES[link.kind] ?? hostOf(link.url).split("/")[0],
      url: link.url,
      icon: LINK_ICONS[link.kind] ?? <Link2 size={16} />,
    });
  });
  if (rows.length === 0) return null;
  return (
    <Panel labelledBy="community-links">
      <PanelHead id="community-links" title={t("links.title")} />
      <div className="flex flex-col gap-8">
        {rows.map((row) => (
          <a
            key={row.key}
            href={row.url}
            target="_blank"
            rel="noopener noreferrer ugc"
            onClick={(event) => {
              event.preventDefault();
              platform.openExternal(row.url);
            }}
            className="flex min-h-36 min-w-0 items-center gap-10 rounded-md bg-input px-12 py-6 text-left hover:bg-surface-hover"
          >
            <span className="shrink-0 text-fg-secondary" aria-hidden="true">
              {row.icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-8">
              <span className="text-body-sm-medium text-fg">{row.name}</span>
              <span className="min-w-0 truncate text-mono-xs text-fg-secondary">{hostOf(row.url)}</span>
            </span>
            <ExternalLink size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
          </a>
        ))}
      </div>
    </Panel>
  );
}

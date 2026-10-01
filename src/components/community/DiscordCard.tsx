import { AlertTriangle, ChevronRight, ExternalLink, Info, MessageCircle, Pencil, Volume2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Avatar, Badge, Button } from "../ui";
import { Panel } from "./bits";
import { useCommunityPlatform } from "./platform";
import type { Community, CommunityDiscord, DiscordChannel, DiscordMember } from "./types";

/** How many voice channels and faces the card lists. */
const MAX_CHANNELS = 4;
const MAX_FACES = 12;

/**
 * The Discord card of a community page, in the states of the design:
 *
 * 1. the invite alone — the widget is off or Discord did not say;
 * 2. the invite and the widget — voice channels and members online;
 * 3. the widget is off, to an organizer: how to turn it on;
 * 4. the invite is not valid, to an organizer: a mark and a way to fix it.
 *
 * A player does not see the card of an invite that is not valid. While the
 * service has not answered, and when Discord could not, the card is the
 * link alone. The JKNet bot of a later slice adds a fifth state.
 */
export function DiscordCard({
  community,
  info,
  organizer,
  onFix,
}: {
  community: Community;
  info: CommunityDiscord | undefined;
  organizer: boolean;
  onFix?: () => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const invite = info?.inviteStatus === "ok" ? info.invite : null;
  const widget = info?.inviteStatus === "ok" ? info.widget : null;

  if (info?.inviteStatus === "invalid") {
    if (!organizer) return null;
    return (
      <Panel labelledBy="community-discord">
        <div className="flex items-center gap-12">
          <DiscordIcon url={null} muted />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h2 id="community-discord" className="text-heading-sm text-fg">
              {t("discord.titlePlain")}
            </h2>
            <span className="truncate text-mono-xs text-fg-secondary" title={community.discord}>
              {community.discord.replace(/^https:\/\/(www\.)?/, "")}
            </span>
          </div>
          <Badge tone="warm">{t("discord.needsFix")}</Badge>
        </div>
        <div className="flex items-start gap-10 rounded-md border border-line-warm bg-warm-subtle px-12 py-8">
          <AlertTriangle size={16} className="mt-1 shrink-0 text-fg-warm" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-6 text-body-sm text-fg">
            <span className="font-semibold">{t("discord.invalidTitle")}</span>
            <span>{t("discord.invalidText")}</span>
          </div>
        </div>
        {onFix ? (
          <Button block wrap icon={<Pencil size={16} />} onClick={onFix}>
            {t("discord.fix")}
          </Button>
        ) : null}
      </Panel>
    );
  }

  const open = () => {
    const link = widget?.enabled && widget.instantInvite ? widget.instantInvite : community.discord;
    platform.openExternal(link);
  };
  const channels = widget?.enabled ? [...widget.channels].sort((a, b) => a.position - b.position).slice(0, MAX_CHANNELS) : [];
  const faces = widget?.enabled ? widget.members.slice(0, MAX_FACES) : [];
  const more = widget?.enabled ? Math.max(0, widget.online - faces.length) : 0;

  return (
    <Panel labelledBy="community-discord">
      <div className="flex items-center gap-12">
        <DiscordIcon url={invite?.iconUrl ?? null} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h2 id="community-discord" className="text-heading-sm text-fg [overflow-wrap:anywhere]">
            {invite ? t("discord.title", { name: invite.name }) : t("discord.titlePlain")}
          </h2>
          {invite && (invite.members !== null || invite.online !== null) ? (
            <span className="flex flex-wrap items-center gap-x-12 gap-y-4 text-body-sm text-fg-secondary">
              {invite.members !== null ? (
                <span>{t("discord.members", { count: invite.members })}</span>
              ) : null}
              {invite.online !== null ? (
                <span className="inline-flex items-center gap-6">
                  <span className="size-8 rounded-full bg-success" aria-hidden="true" />
                  {t("discord.online", { count: invite.online })}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>

      {channels.length > 0 ? (
        <div className="flex flex-col gap-8">
          <span className="text-label-xs text-fg-secondary">{t("discord.voice")}</span>
          {channels.map((channel) => (
            <VoiceChannel key={channel.id} channel={channel} />
          ))}
        </div>
      ) : null}

      {faces.length > 0 ? (
        <div className="flex flex-col gap-8">
          <span className="text-label-xs text-fg-secondary">{t("discord.onlineList")}</span>
          <div className="flex flex-wrap items-center gap-8">
            <Faces members={faces} />
            {more > 0 ? <span className="whitespace-nowrap text-body-sm text-fg-secondary">{t("discord.more", { count: more })}</span> : null}
          </div>
        </div>
      ) : null}

      {organizer && widget?.enabled === false ? (
        <>
          <div className="flex items-start gap-10 rounded-md border border-line-accent bg-accent-subtle px-12 py-8">
            <Info size={16} className="mt-1 shrink-0 text-fg-accent" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-6 text-body-sm text-fg">
              <span className="font-semibold">{t("discord.widgetOffTitle")}</span>
              <span>{t("discord.widgetOffText")}</span>
              <span className="flex flex-wrap items-center gap-4" aria-label={t("discord.path")}>
                <Step>{t("discord.stepSettings")}</Step>
                <ChevronRight size={12} className="text-fg-secondary" aria-hidden="true" />
                <Step>{t("discord.stepWidget")}</Step>
                <ChevronRight size={12} className="text-fg-secondary" aria-hidden="true" />
                <Step>{t("discord.stepEnable")}</Step>
              </span>
            </div>
          </div>
          <p className="text-body-sm text-fg-secondary">{t("discord.recheck")}</p>
        </>
      ) : null}

      {info?.inviteStatus === "unavailable" ? <p className="text-body-sm text-fg-secondary">{t("discord.unavailable")}</p> : null}

      <Button block wrap icon={<ExternalLink size={16} />} onClick={open}>
        {t("discord.open")}
      </Button>
    </Panel>
  );
}

function Step({ children }: { children: string }) {
  return (
    <span className="inline-flex min-h-22 items-center rounded-sm bg-elevated px-8 py-2 text-body-sm-medium text-fg">{children}</span>
  );
}

/** The server's icon when Discord gave one, the speech bubble otherwise. */
function DiscordIcon({ url, muted = false }: { url: string | null; muted?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (url !== null && !broken) {
    return <img src={url} alt="" className="size-44 shrink-0 rounded-lg bg-elevated object-cover" onError={() => setBroken(true)} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-44 shrink-0 items-center justify-center rounded-lg",
        muted ? "bg-elevated text-fg-secondary" : "bg-accent-subtle text-fg-accent",
      )}
    >
      <MessageCircle size={20} />
    </span>
  );
}

function VoiceChannel({ channel }: { channel: DiscordChannel }) {
  const { t } = useTranslation("community");
  const names = channel.members.map((member) => member.name);
  return (
    <div className="flex min-h-40 items-center gap-8 rounded-md bg-input px-10 py-6">
      <Volume2 size={16} className="shrink-0 text-fg-secondary" aria-hidden="true" />
      <span className="min-w-0 shrink text-body-sm-medium text-fg [overflow-wrap:anywhere]">{channel.name}</span>
      {channel.members.length > 0 ? <Faces members={channel.members.slice(0, 3)} ring="input" /> : null}
      <span className="min-w-0 flex-1 truncate text-right text-body-sm text-fg-secondary" title={names.join(", ")}>
        {names.length > 0 ? names.join(", ") : t("discord.nobody")}
      </span>
    </div>
  );
}

/** Faces in a row, each over the one before it. */
function Faces({ members, ring = "surface" }: { members: DiscordMember[]; ring?: "surface" | "input" }) {
  return (
    <span className="flex shrink-0 items-center">
      {members.map((member, index) => (
        <span
          key={`${index}-${member.name}`}
          title={member.name}
          className={cn("rounded-full", index > 0 && "-ml-6", ring === "input" ? "ring-2 ring-input" : "ring-2 ring-surface")}
        >
          <Avatar name={member.name} src={member.avatarUrl} size="sm" />
        </span>
      ))}
    </span>
  );
}

import { AlertTriangle, Bot, ChevronRight, ExternalLink, Hash, Info, Megaphone, MessageCircle, Paperclip, Pencil, Volume2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Avatar, Badge, Button } from "../ui";
import { LinkButton, Panel } from "./bits";
import { useCommunityPlatform } from "./platform";
import type { Community, CommunityDiscord, DiscordBot, DiscordChannel, DiscordMember } from "./types";

/** How many voice channels and faces the card lists. */
const MAX_CHANNELS = 4;
const MAX_FACES = 12;
/** How many text channels of the bot the card lists before **Show all**. */
const MAX_TEXT_CHANNELS = 6;

/** Whether the bot has something for the page: it read the server, or it lists a channel or an announcement. */
export function botShows(bot: DiscordBot | null | undefined): bot is DiscordBot {
  return Boolean(bot?.linked && (bot.syncedAt || (bot.channels?.length ?? 0) > 0 || (bot.announcements?.messages.length ?? 0) > 0));
}

/**
 * The Discord card of a community page, in the states of the design:
 *
 * 1. the invite alone — the widget is off or Discord did not say;
 * 2. the invite and the widget — voice channels and members online;
 * 3. the widget is off, to an organizer: how to turn it on;
 * 4. the invite is not valid, to an organizer: a mark and a way to fix it;
 * 5. the JKNet bot reads the server: the latest announcements and, while
 *    the organizers show them, the text channels everyone there sees.
 *
 * A player does not see the card of an invite that is not valid, unless the
 * bot reads the server: then the card is what the bot read, and **Open
 * Discord** leads to its first channel. While the service has not answered,
 * and when Discord could not, the card is the link alone. An organizer of a community whose bot is not linked gets the
 * way to the management screen's **Discord bot**, and one whose bot fails
 * gets why.
 */
export function DiscordCard({
  community,
  info,
  organizer,
  onFix,
  onBot,
}: {
  community: Community;
  info: CommunityDiscord | undefined;
  organizer: boolean;
  onFix?: () => void;
  /** The management screen's **Discord bot**, for an organizer of a host that manages. */
  onBot?: () => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const invite = info?.inviteStatus === "ok" ? info.invite : null;
  const widget = info?.inviteStatus === "ok" ? info.widget : null;
  const bot = info?.bot ?? null;
  const reading = botShows(bot) ? bot : null;
  // An invite that is not valid leads nowhere; the bot may still read the server.
  const inviteLink = info?.inviteStatus === "invalid" ? "" : community.discord.trim();

  if (info?.inviteStatus === "invalid" && organizer) {
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
            <span>{reading ? t("discord.invalidTextBot") : t("discord.invalidText")}</span>
          </div>
        </div>
        {reading ? <BotReading bot={reading} /> : null}
        {bot ? <BotHint bot={bot} onBot={onBot} /> : null}
        {onFix ? (
          <Button block wrap icon={<Pencil size={16} />} onClick={onFix}>
            {t("discord.fix")}
          </Button>
        ) : null}
      </Panel>
    );
  }

  // A player sees nothing of an invite that is not valid, unless the bot reads the server.
  if (info?.inviteStatus === "invalid" && reading === null) return null;

  const firstChannel = reading?.channels?.[0]?.url ?? reading?.announcements?.url ?? null;
  const open = () => {
    const link = widget?.enabled && widget.instantInvite ? widget.instantInvite : inviteLink !== "" ? inviteLink : firstChannel;
    if (link) platform.openExternal(link);
  };
  const channels = widget?.enabled ? [...widget.channels].sort((a, b) => a.position - b.position).slice(0, MAX_CHANNELS) : [];
  const faces = widget?.enabled ? widget.members.slice(0, MAX_FACES) : [];
  const more = widget?.enabled ? Math.max(0, widget.online - faces.length) : 0;
  const name = invite?.name ?? reading?.guildName ?? null;

  return (
    <Panel labelledBy="community-discord">
      <div className="flex items-center gap-12">
        <DiscordIcon url={invite?.iconUrl ?? null} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h2 id="community-discord" className="text-heading-sm text-fg [overflow-wrap:anywhere]">
            {name ? t("discord.title", { name }) : t("discord.titlePlain")}
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
        {reading ? (
          <Badge tone="purple" icon={<Bot size={12} />} title={t("discord.bot.badgeHint")}>
            {t("discord.bot.badge")}
          </Badge>
        ) : null}
      </div>

      {reading ? <BotReading bot={reading} /> : null}
      {organizer && bot ? <BotHint bot={bot} onBot={onBot} /> : null}

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

      {inviteLink !== "" || firstChannel ? (
        <Button block wrap icon={<ExternalLink size={16} />} onClick={open}>
          {t("discord.open")}
        </Button>
      ) : null}
    </Panel>
  );
}

/** A moment of an announcement in the reader's words: «2 hours ago», «yesterday», a date further back. */
function useWhen(): (iso: string) => string {
  const { i18n } = useTranslation("community");
  return (iso) => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return iso;
    const minutes = Math.round((Date.now() - at) / 60_000);
    try {
      const relative = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
      if (minutes < 60) return relative.format(-Math.max(1, minutes), "minute");
      if (minutes < 24 * 60) return relative.format(-Math.round(minutes / 60), "hour");
      if (minutes < 7 * 24 * 60) return relative.format(-Math.round(minutes / (24 * 60)), "day");
      return new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(new Date(at));
    } catch {
      return iso.slice(0, 10);
    }
  };
}

/**
 * What the bot read, as the design's H1 draws its fifth state: the latest
 * announcement of the chosen channel with its author, its time and its link
 * to Discord — the older ones on request — then the text channels.
 */
function BotReading({ bot }: { bot: DiscordBot }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const when = useWhen();
  const [allMessages, setAllMessages] = useState(false);
  const [allChannels, setAllChannels] = useState(false);
  const announcements = bot.announcements ?? null;
  const messages = announcements ? (allMessages ? announcements.messages : announcements.messages.slice(0, 1)) : [];
  const channels = bot.channels ?? [];
  const shownChannels = allChannels ? channels : channels.slice(0, MAX_TEXT_CHANNELS);

  return (
    <>
      {announcements && announcements.messages.length > 0 ? (
        <div className="flex flex-col gap-8">
          <span className="text-label-xs text-fg-secondary [overflow-wrap:anywhere]">
            {announcements.messages.length > 1 && allMessages
              ? t("discord.bot.announcementsIn", { channel: announcements.channelName })
              : t("discord.bot.latestIn", { channel: announcements.channelName })}
          </span>
          {messages.map((message) => (
            <article key={message.id} className="flex min-w-0 flex-col gap-6 rounded-md bg-input px-12 py-10">
              <div className="flex min-w-0 items-center gap-8">
                <Avatar name={message.author} size="sm" />
                <span className="min-w-0 truncate text-body-sm-medium text-fg" title={message.author}>
                  {message.author}
                </span>
                <time dateTime={message.postedAt} className="ml-auto shrink-0 text-mono-xs text-fg-secondary" title={message.postedAt}>
                  {when(message.postedAt)}
                </time>
              </div>
              <p className="line-clamp-4 text-body-sm whitespace-pre-line text-fg [overflow-wrap:anywhere]">{message.content}</p>
              <div className="flex flex-wrap items-center gap-x-12 gap-y-4">
                {message.attachments > 0 ? (
                  <span className="inline-flex items-center gap-4 text-body-sm text-fg-secondary">
                    <Paperclip size={12} aria-hidden="true" />
                    {t("discord.bot.attachments", { count: message.attachments })}
                  </span>
                ) : null}
                <LinkButton onClick={() => platform.openExternal(message.url)} className="-ml-4">
                  {t("discord.bot.openMessage")}
                </LinkButton>
              </div>
            </article>
          ))}
          {announcements.messages.length > 1 ? (
            <LinkButton onClick={() => setAllMessages((value) => !value)} className="-ml-4 w-fit">
              {allMessages ? t("discord.bot.fewer") : t("discord.bot.moreAnnouncements", { count: announcements.messages.length - 1 })}
            </LinkButton>
          ) : null}
        </div>
      ) : null}

      {channels.length > 0 ? (
        <div className="flex flex-col gap-6">
          <span className="text-label-xs text-fg-secondary">{t("discord.bot.channels")}</span>
          <ul className="flex flex-col gap-2">
            {shownChannels.map((channel) => {
              const feed = channel.id === announcements?.channelId;
              return (
                <li key={channel.id}>
                  <button
                    type="button"
                    onClick={() => platform.openExternal(channel.url)}
                    title={channel.category ? `${channel.category} · #${channel.name}` : `#${channel.name}`}
                    className={cn(
                      "-mx-8 flex min-h-28 w-[calc(100%+16px)] cursor-pointer items-center gap-8 rounded-sm px-8 py-4 text-left text-body-sm-medium select-none",
                      feed ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
                    )}
                  >
                    {channel.kind === "announcement" ? (
                      <Megaphone size={14} className={cn("shrink-0", feed ? "text-fg-accent" : "text-fg-muted")} aria-hidden="true" />
                    ) : (
                      <Hash size={14} className={cn("shrink-0", feed ? "text-fg-accent" : "text-fg-muted")} aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                    {feed ? <span className="shrink-0 text-mono-xs text-fg-accent">{t("discord.bot.inFeed")}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {channels.length > MAX_TEXT_CHANNELS ? (
            <LinkButton onClick={() => setAllChannels((value) => !value)} className="-ml-4 w-fit">
              {allChannels ? t("discord.bot.fewer") : t("discord.bot.allChannels", { count: channels.length })}
            </LinkButton>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * What an organizer is told of the bot on the card: that it can be
 * connected, that it lost the server or a channel, or that the invite leads
 * elsewhere — each with the way to **Discord bot** of the management screen.
 */
function BotHint({ bot, onBot }: { bot: DiscordBot; onBot?: () => void }) {
  const { t } = useTranslation("community");
  let text: string | null = null;
  let warn = false;
  if (!bot.linked) text = onBot ? t("discord.bot.connectHint") : null;
  else if (bot.error) {
    warn = true;
    text = t(`manage.bot.errors.${botErrorKey(bot.error)}`);
  } else if (bot.inviteGuildMismatch) {
    warn = true;
    text = t("manage.bot.mismatch");
  } else if (!bot.syncedAt) text = t("manage.bot.waitingRead");
  if (text === null) return null;
  return (
    <div className={cn("flex items-start gap-10 rounded-md border px-12 py-8", warn ? "border-line-warm bg-warm-subtle" : "border-line bg-input")}>
      {warn ? <AlertTriangle size={16} className="mt-1 shrink-0 text-fg-warm" aria-hidden="true" /> : <Bot size={16} className="mt-1 shrink-0 text-fg-muted" aria-hidden="true" />}
      <div className="flex min-w-0 flex-col gap-4 text-body-sm text-fg">
        <span>{text}</span>
        {onBot ? (
          <LinkButton onClick={onBot} className="-ml-4 w-fit">
            {bot.linked ? t("discord.bot.settings") : t("discord.bot.connect")}
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}

/** The key of a code of the bot's last failure; a code this launcher does not know reads as Discord not answering. */
export function botErrorKey(code: string): "noAccess" | "announcementsHidden" | "announcementsHistoryHidden" | "announcementsDenied" | "botToken" | "unavailable" {
  switch (code) {
    case "no_access":
      return "noAccess";
    case "announcements_hidden":
      return "announcementsHidden";
    case "announcements_history_hidden":
      return "announcementsHistoryHidden";
    case "announcements_denied":
      return "announcementsDenied";
    case "bot_token":
      return "botToken";
    default:
      return "unavailable";
  }
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

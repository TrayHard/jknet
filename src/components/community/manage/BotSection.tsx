import { Bot, ExternalLink, Hash, Megaphone, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Dialog, Select, Toggle } from "../../ui";
import { failureOf } from "../api";
import { botErrorKey } from "../DiscordCard";
import { useFailureText } from "../errors";
import { formatMoment } from "../format";
import { useCommunityApi, useCommunityPlatform } from "../platform";
import type { Community, CommunityDiscord, DiscordBot } from "../types";
import { useAction, type Remote } from "../useRemote";
import { FieldNote, Section, SectionNoticeLine, useSectionNotice } from "./parts";

/** How often the screen reads the Discord card again while it waits for the bot. */
const WAIT_EVERY_MS = 5_000;
/** How long the screen waits for the bot after it opened Discord's page: the life of the link. */
const WAIT_FOR_MS = 15 * 60_000;

/** Where the section is: it has no word of the bot yet, the bot is not linked, or it is. */
type Phase = "unknown" | "off" | "linked";

/** The bot of the Discord card, or what its absence means for an organizer. */
function phaseOf(info: CommunityDiscord | undefined): Phase | "disabled" {
  if (info === undefined) return "unknown";
  // An organizer gets `null` only while the bot is off on the service, or from a service without the bot.
  if (info.bot === null || info.bot === undefined) return "disabled";
  return info.bot.linked ? "linked" : "off";
}

/**
 * **Discord bot**, as the design's F1 draws it: the JKNet bot adds the text
 * channels and the announcements of the community's Discord server to its
 * page.
 *
 * - Not linked: what the bot reads, and **Connect the JKNet bot**, which
 *   asks the service for Discord's page that adds the bot and opens it in
 *   the system browser — a new tab on the website. The screen then reads the
 *   Discord card again every few seconds and when its window comes back,
 *   until the bot is there, and **Check connection** reads it at once.
 * - Linked: the server the bot reads and when, its last failure and what
 *   to do about it, the announcements channel among the channels everyone
 *   sees, **Show text channels on the page**, and **Disconnect the bot**
 *   after a question.
 *
 * Each of them goes to the service at once, as the servers do; nothing of
 * the bot waits for **Save changes**. Each also moves the page's revision,
 * so the section reads the page again and hands it to the form, which then
 * saves on the right revision. While the bot is off on the service, a short
 * note stands in for the section.
 */
export function BotSection({
  community,
  discord,
  onApplied,
}: {
  community: Community;
  discord: Remote<CommunityDiscord>;
  /** The page after a change of the bot, read again: its revision moved. */
  onApplied: (community: Community) => void;
}) {
  const { t, i18n } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const id = useId();
  const action = useAction();
  const [notice, setNotice] = useSectionNotice();
  const [waiting, setWaiting] = useState<{ url: string; until: number } | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const reload = discord.reload;
  const info = discord.data;
  const phase = disabled ? "disabled" : phaseOf(info);
  const bot: DiscordBot | null = info?.bot ?? null;
  const guild = bot?.guildName ?? (info?.inviteStatus === "ok" ? info.invite?.name ?? null : null);

  // Waiting for Discord: read the card every few seconds and when the window comes back.
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  useEffect(() => {
    if (waiting === null) return;
    const timer = setInterval(() => {
      if (Date.now() > waiting.until) {
        setWaiting(null);
        return;
      }
      reload();
    }, WAIT_EVERY_MS);
    const back = () => {
      if (waitingRef.current) reload();
    };
    window.addEventListener("focus", back);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", back);
    };
  }, [waiting, reload]);

  /** The page as it is after a change of the bot, for the form. A failure leaves the form as it is: a save then names the conflict. */
  const communityId = community.id;
  const refresh = useCallback(async () => {
    try {
      onApplied(await api.get(communityId));
    } catch {
      // Nothing to say here: the bot's own notice stands.
    }
  }, [api, communityId, onApplied]);

  // The note of the wait comes into sight, clear of the save bar under it.
  const waitingBox = useRef<HTMLDivElement>(null);
  const isWaiting = waiting !== null;
  useEffect(() => {
    if (isWaiting) waitingBox.current?.scrollIntoView({ block: "nearest" });
  }, [isWaiting]);

  // The bot came: the wait is over, and the page moved on.
  const linked = bot?.linked === true;
  useEffect(() => {
    if (!linked || waiting === null) return;
    setWaiting(null);
    setNotice({ tone: "success", text: t("manage.bot.connected") });
    void refresh();
  }, [linked, waiting, setNotice, t, refresh]);

  const unavailable = useCallback(
    (reason: unknown) => {
      const { code } = failureOf(reason);
      if (code === "provider_error") {
        setDisabled(true);
        return;
      }
      setNotice({ tone: "danger", text: code === "conflict" ? t("manage.bot.notRead") : failure(reason) });
    },
    [failure, setNotice, t],
  );

  const connect = () => {
    setNotice(null);
    const open = platform.openExternalLater?.() ?? ((url: string | null) => (url ? platform.openExternal(url) : undefined));
    void action.run(
      async () => {
        const link = await api.discordBotLink(community.id);
        // A tab follows any scheme it is given: only a page over HTTPS opens.
        if (!/^https:\/\//i.test(link.url)) throw Object.assign(new Error("The link of the bot is not HTTPS"), { code: "internal" });
        open(link.url);
        const until = Date.parse(link.expiresAt);
        setWaiting({ url: link.url, until: Number.isFinite(until) ? Math.min(until, Date.now() + WAIT_FOR_MS) : Date.now() + WAIT_FOR_MS });
      },
      (reason) => {
        open(null);
        unavailable(reason);
      },
    );
  };

  const choose = (body: { announcementsChannelId?: string | null; showChannels?: boolean }, done: string) => {
    setNotice(null);
    void action.run(async () => {
      discord.set(await api.discordBot(community.id, body));
      setNotice({ tone: "success", text: done });
      await refresh();
    }, unavailable);
  };

  const disconnect = () => {
    setNotice(null);
    void action.run(
      async () => {
        await api.unlinkDiscordBot(community.id);
        setConfirm(false);
        discord.set((current) => current && { ...current, bot: { linked: false } });
        setNotice({ tone: "success", text: t("manage.bot.disconnected") });
        await refresh();
      },
      (reason) => {
        setConfirm(false);
        unavailable(reason);
      },
    );
  };

  if (phase === "disabled") {
    return (
      <Section section="bot" title={t("manage.sections.bot")}>
        <p className="flex items-start gap-8 text-body-sm text-fg-muted">
          <Bot size={16} className="mt-1 shrink-0" aria-hidden="true" />
          <span>{t("manage.bot.disabled")}</span>
        </p>
      </Section>
    );
  }

  const channels = bot?.availableChannels ?? [];
  const syncedAt = bot?.syncedAt ?? null;

  return (
    <Section
      section="bot"
      title={t("manage.sections.bot")}
      lead={phase === "linked" ? undefined : guild ? t("manage.bot.lead", { name: guild }) : t("manage.bot.leadPlain")}
    >
      {phase === "unknown" ? (
        discord.error ? (
          <FieldNote tone="warn">{t("manage.bot.unknown")}</FieldNote>
        ) : (
          <p role="status" className="text-body-sm text-fg-muted">
            {t("common.loading")}
          </p>
        )
      ) : null}

      {phase === "off" ? (
        <>
          <ul className="flex flex-col gap-6">
            <li className="flex items-start gap-8 text-body-sm text-fg-secondary">
              <Hash size={14} className="mt-2 shrink-0" aria-hidden="true" />
              {t("manage.bot.readsChannels")}
            </li>
            <li className="flex items-start gap-8 text-body-sm text-fg-secondary">
              <Megaphone size={14} className="mt-2 shrink-0" aria-hidden="true" />
              {t("manage.bot.readsAnnouncements")}
            </li>
          </ul>
          <div className="flex flex-wrap items-center gap-8">
            <Button variant="primary" size="sm" wrap icon={<Bot size={14} />} disabled={action.busy} onClick={connect}>
              {waiting ? t("manage.bot.connectAgain") : t("manage.bot.connect")}
            </Button>
            {waiting ? (
              <Button size="sm" wrap icon={<RefreshCw size={14} />} disabled={discord.loading} onClick={reload}>
                {t("manage.bot.check")}
              </Button>
            ) : null}
          </div>
          {waiting ? (
            <div
              ref={waitingBox}
              role="status"
              className="flex scroll-mb-112 flex-col gap-6 rounded-md border border-line-accent bg-accent-subtle px-12 py-8 text-body-sm text-fg"
            >
              <span className="font-semibold">{t("manage.bot.waitingTitle")}</span>
              <span>{t("manage.bot.waitingText")}</span>
              <button
                type="button"
                onClick={() => platform.openExternal(waiting.url)}
                className="inline-flex w-fit cursor-pointer items-center gap-6 text-body-sm-medium text-fg-accent hover:underline hover:underline-offset-2"
              >
                <ExternalLink size={14} aria-hidden="true" />
                {t("manage.bot.openLink")}
              </button>
            </div>
          ) : (
            <FieldNote>{t("manage.bot.permissions")}</FieldNote>
          )}
        </>
      ) : null}

      {phase === "linked" && bot ? (
        <>
          {syncedAt ? (
            <FieldNote tone="ok">
              {guild
                ? t("manage.bot.linkedTo", { name: guild, time: formatMoment(syncedAt, i18n.language) })
                : t("manage.bot.linkedToPlain", { time: formatMoment(syncedAt, i18n.language) })}
            </FieldNote>
          ) : (
            <FieldNote>{t("manage.bot.waitingRead")}</FieldNote>
          )}
          {bot.error ? <FieldNote tone="warn">{t(`manage.bot.errors.${botErrorKey(bot.error)}`)}</FieldNote> : null}
          {bot.inviteGuildMismatch ? <FieldNote tone="warn">{t("manage.bot.mismatch")}</FieldNote> : null}

          <div className="flex min-w-0 flex-col gap-6">
            <span id={`${id}-channel`} className="text-body-sm-medium text-fg-secondary">
              {t("manage.bot.channel")}
            </span>
            <Select
              className="w-[280px] max-w-full"
              ariaLabel={t("manage.bot.channel")}
              value={bot.announcementsChannelId ?? ""}
              disabled={action.busy || channels.length === 0}
              onChange={(value) => {
                const next = value === "" ? null : value;
                if (next === (bot.announcementsChannelId ?? null)) return;
                choose({ announcementsChannelId: next }, next === null ? t("manage.bot.channelCleared") : t("manage.bot.channelSaved"));
              }}
              options={[
                { value: "", label: t("manage.bot.noChannel") },
                ...channels.map((channel) => ({ value: channel.id, label: `#${channel.name}`, hint: channel.category ?? undefined })),
              ]}
            />
            <FieldNote>{channels.length === 0 ? t("manage.bot.noChannels") : t("manage.bot.channelHint")}</FieldNote>
          </div>

          <div className="flex items-start justify-between gap-16">
            <span className="flex min-w-0 flex-col gap-2">
              <span className="text-body-md-medium text-fg">{t("manage.bot.showChannels")}</span>
              <span className="text-body-sm text-fg-secondary">{t("manage.bot.showChannelsHint")}</span>
            </span>
            <Toggle
              checked={bot.showChannels ?? true}
              disabled={action.busy}
              label={t("manage.bot.showChannels")}
              onChange={(showChannels) => choose({ showChannels }, showChannels ? t("manage.bot.channelsShown") : t("manage.bot.channelsHidden"))}
            />
          </div>

          <div className="flex flex-wrap items-center gap-8">
            <Button size="sm" variant="ghost" wrap className="text-fg-danger!" disabled={action.busy} onClick={() => setConfirm(true)}>
              {t("manage.bot.disconnect")}
            </Button>
          </div>
        </>
      ) : null}

      <SectionNoticeLine notice={notice} />

      {confirm ? (
        <Dialog
          variant="danger"
          title={t("manage.bot.disconnectTitle")}
          body={guild ? t("manage.bot.disconnectText", { name: guild }) : t("manage.bot.disconnectTextPlain")}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button variant="ghost" wrap onClick={() => setConfirm(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" wrap disabled={action.busy} onClick={disconnect}>
                {t("manage.bot.disconnectConfirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </Section>
  );
}

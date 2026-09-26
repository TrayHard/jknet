import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useLocale } from "../../../i18n/useFormat";
import {
  chatNotificationsOf,
  clockLabel,
  DEFAULT_QUIET_HOURS,
  minutesOfDay,
  normalizeClock,
  quietHoursShape,
  silenceAt,
} from "../../../lib/chat/notifySettings";
import type { ChatNotificationsPatch, QuietHours } from "../../../lib/ipc";
import { useSettings } from "../../../lib/queries";
import { useNow } from "../../host/useNow";
import { Input } from "../../ui";
import { RowGroup, SettingsCard, ToggleRow } from "./SettingRow";

interface ChatNotificationsCardProps {
  /** Saves the switches that moved; the group reports a refusal. */
  onChange: (patch: ChatNotificationsPatch) => void;
}

/** How often the line about silence reads the clock: quiet hours start on a minute. */
const CLOCK_MS = 30_000;

/**
 * --- slice: chat notifications ---
 *
 * Settings · Chat · Notifications: where a message reaches the player and
 * when nothing does.
 *
 * Three groups of switches: the channels (the toast in the launcher, the
 * Windows notification, the text they show), the silence (**Do not
 * disturb**, quiet hours and whether mentions break through them, D7), and
 * the game (messages wait while a game runs, one summary after it). The
 * core decides what a message does with them (`chat::notify::decide`); the
 * card only sends the switch that moved, because the tray's **Do not
 * disturb** writes the same block behind its back.
 */
export function ChatNotificationsCard({ onChange }: ChatNotificationsCardProps) {
  const { t } = useTranslation("chat");
  const locale = useLocale();
  const settings = useSettings();
  const notifications = chatNotificationsOf(settings.data);
  const loading = settings.data === undefined;
  const now = useNow(CLOCK_MS);
  const silence = silenceAt(notifications, minutesOfDay(new Date(now)));
  const anyChannel = notifications.inApp || notifications.os;

  return (
    <SettingsCard
      icon={notifications.dnd ? <BellOff size={20} /> : <Bell size={20} />}
      title={t("settings.notifications.title")}
      text={t("settings.notifications.text")}
    >
      {silence === "none" ? null : (
        <p
          role="status"
          className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle px-12 py-8 mb-12 text-body-sm text-fg"
        >
          <BellOff size={16} className="text-fg-warm shrink-0 mt-2" />
          <span>
            {silence === "quiet"
              ? t("settings.notifications.silenced.quiet", {
                  to: clockLabel(notifications.quietHours?.to ?? "", locale),
                })
              : t(`settings.notifications.silenced.${silence}`)}
          </span>
        </p>
      )}

      <ToggleRow
        title={t("settings.notifications.inApp")}
        hint={t("settings.notifications.inAppHint")}
        checked={notifications.inApp}
        disabled={loading}
        onChange={(inApp) => onChange({ inApp })}
      />
      <ToggleRow
        title={t("settings.notifications.os")}
        hint={t("settings.notifications.osHint")}
        checked={notifications.os}
        disabled={loading}
        onChange={(os) => onChange({ os })}
      />
      <ToggleRow
        title={t("settings.notifications.showText")}
        hint={
          anyChannel
            ? t("settings.notifications.showTextHint")
            : t("settings.notifications.showTextNeedsChannel")
        }
        checked={notifications.showText}
        disabled={loading || !anyChannel}
        onChange={(showText) => onChange({ showText })}
      />

      <RowGroup title={t("settings.notifications.silenceTitle")}>
        <ToggleRow
          title={t("settings.notifications.dnd")}
          hint={t("settings.notifications.dndHint")}
          checked={notifications.dnd}
          disabled={loading}
          onChange={(dnd) => onChange({ dnd })}
        />
        <QuietHoursRow
          range={notifications.quietHours}
          disabled={loading}
          onChange={(quietHours) => onChange({ quietHours })}
        />
        <ToggleRow
          title={t("settings.notifications.mentionsBreak")}
          hint={t("settings.notifications.mentionsBreakHint")}
          checked={notifications.mentionsBreakDnd}
          disabled={loading}
          onChange={(mentionsBreakDnd) => onChange({ mentionsBreakDnd })}
        />
      </RowGroup>

      <RowGroup title={t("settings.notifications.gameTitle")}>
        <ToggleRow
          title={t("settings.notifications.dndInGame")}
          hint={t("settings.notifications.dndInGameHint")}
          checked={notifications.dndInGame}
          disabled={loading}
          onChange={(dndInGame) => onChange({ dndInGame })}
        />
        <ToggleRow
          title={t("settings.notifications.summary")}
          hint={
            notifications.dndInGame
              ? t("settings.notifications.summaryHint")
              : t("settings.notifications.summaryNeedsDnd")
          }
          checked={notifications.summaryAfterGame}
          disabled={loading || !notifications.dndInGame}
          onChange={(summaryAfterGame) => onChange({ summaryAfterGame })}
        />
      </RowGroup>
    </SettingsCard>
  );
}

interface QuietHoursRowProps {
  range: QuietHours | null;
  disabled: boolean;
  onChange: (range: QuietHours | null) => void;
}

/**
 * **Quiet hours**: the switch, and the two times under it.
 *
 * A time saves when the field loses the focus (or on Enter), so typing
 * `2`, `2` and `30` is one write rather than three. The switch remembers the
 * last range of this visit: off and on again brings the same hours back.
 */
function QuietHoursRow({ range, disabled, onChange }: QuietHoursRowProps) {
  const { t } = useTranslation("chat");
  const locale = useLocale();
  const [last, setLast] = useState<QuietHours>(range ?? DEFAULT_QUIET_HOURS);
  const [from, setFrom] = useState(range?.from ?? last.from);
  const [to, setTo] = useState(range?.to ?? last.to);

  // Follow the stored range: it arrives after the first render, and the
  // tray or another window may change the block.
  useEffect(() => {
    if (range === null) return;
    setLast(range);
    setFrom(range.from);
    setTo(range.to);
  }, [range]);

  const on = range !== null;
  const shown: QuietHours = { from, to };
  const shape = quietHoursShape(shown);

  const save = () => {
    if (range === null) return;
    const next = { from: normalizeClock(from), to: normalizeClock(to) };
    if (next.from === null || next.to === null) {
      // An emptied field goes back to what is stored.
      setFrom(range.from);
      setTo(range.to);
      return;
    }
    if (next.from === range.from && next.to === range.to) return;
    onChange({ from: next.from, to: next.to });
  };

  const note =
    !on || shape === "sameDay"
      ? null
      : shape === "overnight"
        ? t("settings.notifications.quietOvernight", { to: clockLabel(to, locale) })
        : shape === "empty"
          ? t("settings.notifications.quietEmpty")
          : t("settings.notifications.quietInvalid");

  return (
    <ToggleRow
      title={t("settings.notifications.quiet")}
      hint={t("settings.notifications.quietHint")}
      checked={on}
      disabled={disabled}
      onChange={(checked) => onChange(checked ? last : null)}
    >
      <div className="flex flex-wrap items-center gap-8">
        <span className="text-body-sm text-fg-secondary">{t("settings.notifications.quietFrom")}</span>
        <Input
          type="time"
          aria-label={t("settings.notifications.quietFromLabel")}
          value={from}
          disabled={disabled || !on}
          onChange={(event) => setFrom(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="w-128"
        />
        <span className="text-body-sm text-fg-secondary">{t("settings.notifications.quietTo")}</span>
        <Input
          type="time"
          aria-label={t("settings.notifications.quietToLabel")}
          value={to}
          disabled={disabled || !on}
          onChange={(event) => setTo(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="w-128"
        />
      </div>
      {note === null ? null : <p className="text-body-sm text-fg-muted">{note}</p>}
    </ToggleRow>
  );
}

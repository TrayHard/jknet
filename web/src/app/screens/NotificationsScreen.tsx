import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, BellOff, MonitorSmartphone, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  ChoiceRow,
  RowGroup,
  SettingRow,
  SettingsCard,
  ToggleRow,
} from "../../../../src/components/chat/settings/SettingRow.tsx";
import { ChatSoundsCard } from "../../../../src/components/chat/settings/ChatSoundsCard.tsx";
import { useNow } from "../../../../src/components/host/useNow.ts";
import { Button, Input, Select } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useLocale } from "../../../../src/i18n/useFormat.ts";
import { clockLabel, normalizeClock, quietHoursShape } from "../../../../src/lib/chat/notifySettings.ts";
import type { ChatNotificationsPatch } from "../../../../src/lib/ipc.ts";
import { useAccountState, useUpdateChatSettings } from "../../../../src/lib/queries.ts";
import { CoreError } from "../../core/errors.ts";
import type { ActiveElsewhere, PushDevice, PushLevel, PushPreview, PushSettings } from "../../core/push.ts";
import { useWebCore } from "../CoreContext.tsx";
import { installState, needsHomeScreen, subscribeInstall } from "../install.ts";
import { HomeScreenSteps } from "../InstallSteps.tsx";

export const PUSH_CONFIG_KEY = ["web", "push", "config"] as const;
export const PUSH_DEVICES_KEY = ["web", "push", "devices"] as const;

/** When the list of devices is read again after a test: the delivery date may have moved. */
const RECHECK_AFTER_TEST_MS = 4_000;

const PREVIEWS: readonly PushPreview[] = ["full", "sender", "none"];
const AT_PC: readonly ActiveElsewhere[] = ["delay", "always", "never"];
const LEVELS: readonly PushLevel[] = ["all", "mentions", "off"];

/**
 * Settings · Notifications.
 *
 * Push of this device: **Enable notifications**, then every setting the
 * service keeps per device — on or off, a pause, the kinds of events, the
 * message text (**Message text**), the rule while the player is at the PC
 * (**When I'm at my PC**), quiet hours and their mentions, the sound — each
 * saved for this device alone. A test notification, the last delivery, the
 * other devices with **Remove**, and the way to the sessions. An iPhone or
 * iPad in a browser tab gets the Home Screen steps instead: push reaches it
 * only there. A service with push off shows no push section at all.
 *
 * Then the chat sound of this browser, the web app's own switch: it plays
 * whenever the app is open, a tab in the background included, and never
 * touches the launcher's.
 */
export function NotificationsScreen() {
  const { t } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const errorText = useErrorText();
  const update = useUpdateChatSettings();
  const { mutate } = update;
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (chatNotifications: ChatNotificationsPatch) => {
      setError(null);
      mutate({ chatNotifications }, { onError: (e) => setError(tChat("settings.failed", { error: errorText(e) })) });
    },
    [mutate, tChat, errorText],
  );

  return (
    <div className="flex max-w-[720px] flex-col gap-16 px-16 py-24 sm:px-40 sm:py-32" data-testid="notifications-screen">
      <PushSection />
      {error === null ? null : <Alert>{error}</Alert>}
      <ChatSoundsCard onChange={save} text={t("notifications.soundText")} />
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12">
      <AlertTriangle size={16} className="mt-2 shrink-0 text-fg-danger" />
      <span className="text-body-sm text-fg">{children}</span>
    </div>
  );
}

function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warm" | "danger" }) {
  const box =
    tone === "danger"
      ? "border-line-danger bg-danger-subtle"
      : tone === "warm"
        ? "border-line-warm bg-warm-subtle"
        : "border-line-subtle bg-elevated";
  return <div className={`rounded-md border px-12 py-8 text-body-sm text-fg ${box}`}>{children}</div>;
}

/** A date and time in the language on screen. */
function useWhen(): (value: string | number) => string {
  const locale = useLocale();
  return useCallback(
    (value: string | number) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
    },
    [locale],
  );
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The push part of the screen: this device, then the account's other devices. */
function PushSection() {
  const { t } = useTranslation("web");
  const core = useWebCore();
  const signedIn = useAccountState().data?.onlineSignedIn === true;
  const local = useSyncExternalStore(core.push.subscribe, core.push.local, core.push.local);
  const install = useSyncExternalStore(subscribeInstall, installState, installState);
  const config = useQuery({ queryKey: PUSH_CONFIG_KEY, queryFn: () => core.push.config(), staleTime: Infinity });
  const on = config.data?.enabled === true;
  const devices = useQuery({
    queryKey: PUSH_DEVICES_KEY,
    queryFn: () => core.push.devices(),
    enabled: on && signedIn,
    retry: false,
  });

  if (config.isPending) return null;
  if (config.isError) return <Note tone="warm">{t("notifications.unavailable")}</Note>;
  if (!on) return null;
  if (needsHomeScreen(install)) return <HomeScreenSteps />;

  const mine = local.subscriptionId === null ? undefined : devices.data?.find((device) => device.id === local.subscriptionId);
  const others = (devices.data ?? []).filter((device) => device.id !== local.subscriptionId);

  return (
    <>
      <SettingsCard
        icon={mine?.settings.enabled === false ? <BellOff size={20} /> : <Bell size={20} />}
        title={t("notifications.pushTitle")}
        text={t("notifications.pushText")}
      >
        {!local.supported ? (
          <Note tone="warm">{t("notifications.unsupported")}</Note>
        ) : local.permission === "denied" ? (
          <Note tone="danger">
            <span data-testid="push-blocked" className="flex flex-col gap-2">
              <span className="text-body-md-medium">{t("notifications.blocked")}</span>
              <span className="text-fg-secondary">{t("notifications.blockedHint")}</span>
            </span>
          </Note>
        ) : local.subscriptionId === null ? (
          <EnableRow />
        ) : mine === undefined ? (
          devices.isError ? (
            <Note tone="warm">{t("notifications.unavailable")}</Note>
          ) : (
            <p role="status" className="text-body-sm text-fg-muted">
              {t("notifications.loading")}
            </p>
          )
        ) : (
          <DeviceSettings device={mine} />
        )}
      </SettingsCard>
      {signedIn ? <OtherDevices devices={others} loaded={devices.isSuccess} /> : null}
    </>
  );
}

/** **Enable notifications**: asks the browser straight from the click, then subscribes. */
function EnableRow() {
  const { t } = useTranslation("web");
  const core = useWebCore();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = () => {
    setError(null);
    setBusy(true);
    // Not through a mutation: the permission request must start inside the click.
    core.push
      .enable()
      .then(() => queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY }))
      .catch((failure: unknown) => {
        if (failure instanceof CoreError && failure.code === "pushBlocked") {
          if (core.push.local().permission !== "denied") setError(t("notifications.notAllowed"));
          return;
        }
        if (failure instanceof CoreError && failure.code === "pushUnsupported") {
          setError(t("notifications.unsupported"));
          return;
        }
        setError(t("notifications.failed", { error: errorText(failure) }));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-12">
      <p className="text-body-sm text-fg-secondary">{t("notifications.enableText")}</p>
      <Button variant="primary" icon={<Bell size={16} />} className="self-start" disabled={busy} onClick={enable}>
        {t("notifications.enable")}
      </Button>
      {error === null ? null : <Alert>{error}</Alert>}
    </div>
  );
}

/** Saves a change of this device's settings, showing it at once and taking the service's answer. */
function useSaveSettings(device: PushDevice) {
  const { t } = useTranslation("web");
  const core = useWebCore();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);

  const put = (settings: (current: PushSettings) => PushSettings) =>
    queryClient.setQueryData<PushDevice[]>(PUSH_DEVICES_KEY, (list) =>
      list?.map((entry) => (entry.id === device.id ? { ...entry, settings: settings(entry.settings) } : entry)),
    );

  const mutation = useMutation({
    mutationFn: (patch: Partial<PushSettings>) => core.push.update(patch),
    onMutate: (patch) => {
      setError(null);
      put((current) => ({ ...current, ...patch }));
    },
    onSuccess: (settings) => put(() => settings),
    onError: (failure) => {
      setError(t("notifications.failed", { error: errorText(failure) }));
      void queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY });
    },
  });

  return { save: mutation.mutate, error };
}

function DeviceSettings({ device }: { device: PushDevice }) {
  const { t } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const { save, error } = useSaveSettings(device);
  const settings = device.settings;
  const off = !settings.enabled;
  const levelOptions = LEVELS.map((level) => ({ value: level, label: t(`notifications.level.${level}`) }));

  return (
    <div data-testid="push-settings" className="flex flex-col">
      {error === null ? null : <Alert>{error}</Alert>}
      <ToggleRow
        title={t("notifications.master")}
        hint={t("notifications.masterHint")}
        checked={settings.enabled}
        onChange={(enabled) => save({ enabled })}
      />
      <PauseRow settings={settings} disabled={off} onChange={save} />
      <TestRow device={device} />

      <RowGroup title={t("notifications.kinds")}>
        <ToggleRow title={t("notifications.direct")} checked={settings.direct} disabled={off} onChange={(direct) => save({ direct })} />
        <SettingRow
          title={t("notifications.groups")}
          disabled={off}
          control={
            <Select
              size="sm"
              ariaLabel={t("notifications.groups")}
              value={settings.groups}
              disabled={off}
              options={levelOptions}
              onChange={(value) => save({ groups: value as PushLevel })}
              className="w-176"
            />
          }
        />
        <SettingRow
          title={t("notifications.serverChats")}
          disabled={off}
          control={
            <Select
              size="sm"
              ariaLabel={t("notifications.serverChats")}
              value={settings.serverChats}
              disabled={off}
              options={levelOptions}
              onChange={(value) => save({ serverChats: value as PushLevel })}
              className="w-176"
            />
          }
        />
        <ToggleRow title={t("notifications.reactions")} checked={settings.reactions} disabled={off} onChange={(reactions) => save({ reactions })} />
        <ToggleRow
          title={t("notifications.friendRequests")}
          checked={settings.friendRequests}
          disabled={off}
          onChange={(friendRequests) => save({ friendRequests })}
        />
        <ToggleRow
          title={t("notifications.friendAccepted")}
          checked={settings.friendAccepted}
          disabled={off}
          onChange={(friendAccepted) => save({ friendAccepted })}
        />
        <ToggleRow
          title={t("notifications.groupInvites")}
          checked={settings.groupInvites}
          disabled={off}
          onChange={(groupInvites) => save({ groupInvites })}
        />
        <ToggleRow
          title={t("notifications.serverInvites")}
          checked={settings.serverInvites}
          disabled={off}
          onChange={(serverInvites) => save({ serverInvites })}
        />
      </RowGroup>

      <div className="flex flex-col border-t border-line-subtle pt-12">
        <ChoiceRow<PushPreview>
          title={t("notifications.messageText")}
          value={settings.preview}
          disabled={off}
          options={PREVIEWS.map((preview) => ({ value: preview, label: t(`notifications.preview.${preview}`) }))}
          onChange={(preview) => save({ preview })}
        />
        <ChoiceRow<ActiveElsewhere>
          title={t("notifications.atPc")}
          hint={t("notifications.atPcHint")}
          value={settings.whileActiveElsewhere}
          disabled={off}
          options={AT_PC.map((mode) => ({ value: mode, label: t(`notifications.whileActiveElsewhere.${mode}`) }))}
          onChange={(whileActiveElsewhere) => save({ whileActiveElsewhere })}
        />
      </div>

      <RowGroup title={tChat("settings.notifications.silenceTitle")}>
        <QuietRow settings={settings} disabled={off} onChange={save} />
        <ToggleRow
          title={t("notifications.mentionsBreak")}
          hint={t("notifications.mentionsBreakHint")}
          checked={settings.mentionsBreakQuiet}
          disabled={off}
          onChange={(mentionsBreakQuiet) => save({ mentionsBreakQuiet })}
        />
        <ToggleRow
          title={t("notifications.silent")}
          hint={t("notifications.silentHint")}
          checked={settings.silent}
          disabled={off}
          onChange={(silent) => save({ silent })}
        />
      </RowGroup>

      <p className="border-t border-line-subtle pt-12 text-body-sm text-fg-muted">{t("notifications.perChat")}</p>
    </div>
  );
}

/** Tomorrow at eight in the morning, local time: the end of **Until tomorrow**. */
export function tomorrowMorning(now: number): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date;
}

function PauseRow({
  settings,
  disabled,
  onChange,
}: {
  settings: PushSettings;
  disabled: boolean;
  onChange: (patch: Partial<PushSettings>) => void;
}) {
  const { t } = useTranslation("web");
  const when = useWhen();
  const now = useNow(30_000);
  const until = settings.pausedUntil === null ? Number.NaN : Date.parse(settings.pausedUntil);
  const paused = !Number.isNaN(until) && until > now;
  const pauseFor = (ms: number) => onChange({ pausedUntil: new Date(Date.now() + ms).toISOString() });

  return (
    <SettingRow
      title={t("notifications.pause")}
      hint={paused ? t("notifications.pausedUntil", { time: when(until) }) : t("notifications.pauseHint")}
      disabled={disabled}
    >
      <div className="flex flex-wrap gap-8">
        {paused ? (
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange({ pausedUntil: null })}>
            {t("notifications.resume")}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => pauseFor(60 * 60_000)}>
              {t("notifications.pause1h")}
            </Button>
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => pauseFor(8 * 60 * 60_000)}>
              {t("notifications.pause8h")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => onChange({ pausedUntil: tomorrowMorning(Date.now()).toISOString() })}
            >
              {t("notifications.pauseTomorrow")}
            </Button>
          </>
        )}
      </div>
    </SettingRow>
  );
}

/** **Send test notification** and the date of the last delivery to this device. */
function TestRow({ device }: { device: PushDevice }) {
  const { t } = useTranslation("web");
  const core = useWebCore();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const when = useWhen();
  const [status, setStatus] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: () => core.push.test(),
    onMutate: () => setStatus(null),
    onSuccess: () => {
      setStatus(t("notifications.testSent"));
      window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY }), RECHECK_AFTER_TEST_MS);
    },
    onError: (failure) => setStatus(t("notifications.failed", { error: errorText(failure) })),
  });

  return (
    <SettingRow
      title={t("notifications.testTitle")}
      hint={device.lastOkAt === null ? t("notifications.noDelivery") : t("notifications.lastDelivery", { date: when(device.lastOkAt) })}
    >
      <div className="flex flex-wrap items-center gap-12">
        <Button size="sm" variant="secondary" icon={<Send size={14} />} disabled={test.isPending} onClick={() => test.mutate()}>
          {t("notifications.test")}
        </Button>
        {status === null ? null : (
          <span role="status" className="text-body-sm text-fg-secondary">
            {status}
          </span>
        )}
      </div>
    </SettingRow>
  );
}

/**
 * **Quiet hours**: the switch and the two times, in the browser's time zone.
 * A time saves when its field loses the focus; the same time twice is never
 * quiet, and the service refuses it, so it is not sent.
 */
function QuietRow({
  settings,
  disabled,
  onChange,
}: {
  settings: PushSettings;
  disabled: boolean;
  onChange: (patch: Partial<PushSettings>) => void;
}) {
  const { t } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const locale = useLocale();
  const range = settings.quietHours;
  const zone = browserTimeZone();
  const [from, setFrom] = useState(range?.from ?? "23:00");
  const [to, setTo] = useState(range?.to ?? "08:00");

  useEffect(() => {
    if (range === null) return;
    setFrom(range.from);
    setTo(range.to);
  }, [range]);

  const on = range !== null;
  const shape = quietHoursShape({ from, to });

  const save = () => {
    if (range === null) return;
    const next = { from: normalizeClock(from), to: normalizeClock(to) };
    if (next.from === null || next.to === null || next.from === next.to) {
      setFrom(range.from);
      setTo(range.to);
      return;
    }
    if (next.from === range.from && next.to === range.to && range.timeZone === zone) return;
    onChange({ quietHours: { from: next.from, to: next.to, timeZone: zone } });
  };

  const toggle = (checked: boolean) => {
    if (!checked) {
      onChange({ quietHours: null });
      return;
    }
    const start = normalizeClock(from) ?? "23:00";
    const end = normalizeClock(to) ?? "08:00";
    onChange({ quietHours: { from: start, to: start === end ? "08:00" : end, timeZone: zone } });
  };

  const note =
    !on || shape === "sameDay"
      ? null
      : shape === "overnight"
        ? tChat("settings.notifications.quietOvernight", { to: clockLabel(to, locale) })
        : shape === "empty"
          ? tChat("settings.notifications.quietEmpty")
          : tChat("settings.notifications.quietInvalid");

  const field = (value: string, set: (value: string) => void, label: string) => (
    <Input
      type="time"
      aria-label={label}
      value={value}
      disabled={disabled || !on}
      onChange={(event) => set(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="w-128"
    />
  );

  return (
    <ToggleRow
      title={t("notifications.quiet")}
      hint={t("notifications.quietHint", { zone: range?.timeZone ?? zone })}
      checked={on}
      disabled={disabled}
      onChange={toggle}
    >
      <div className="flex flex-wrap items-center gap-8">
        <span className="text-body-sm text-fg-secondary">{tChat("settings.notifications.quietFrom")}</span>
        {field(from, setFrom, tChat("settings.notifications.quietFromLabel"))}
        <span className="text-body-sm text-fg-secondary">{tChat("settings.notifications.quietTo")}</span>
        {field(to, setTo, tChat("settings.notifications.quietToLabel"))}
      </div>
      {note === null ? null : <p className="text-body-sm text-fg-muted">{note}</p>}
    </ToggleRow>
  );
}

/** The account's other devices with push, each with **Remove**, and the way to the sessions. */
function OtherDevices({ devices, loaded }: { devices: PushDevice[]; loaded: boolean }) {
  const { t } = useTranslation("web");
  const core = useWebCore();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const when = useWhen();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => core.push.remove(id),
    onMutate: () => setError(null),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY }),
    onError: (failure) => setError(t("notifications.failed", { error: errorText(failure) })),
  });

  return (
    <SettingsCard
      icon={<MonitorSmartphone size={20} />}
      title={t("notifications.otherDevices")}
      text={t("notifications.otherDevicesText")}
    >
      {error === null ? null : <Alert>{error}</Alert>}
      {!loaded ? null : devices.length === 0 ? (
        <p className="text-body-sm text-fg-muted">{t("notifications.noOtherDevices")}</p>
      ) : (
        <ul className="flex flex-col">
          {devices.map((device) => (
            <li
              key={device.id}
              data-testid="push-device"
              className="flex items-center gap-12 border-t border-line-subtle py-12 first:border-t-0 first:pt-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="truncate text-body-md-medium text-fg">{device.deviceName ?? t("notifications.unnamed")}</span>
                <span className="text-body-sm text-fg-muted">
                  {device.lastOkAt === null
                    ? t("notifications.since", { date: when(device.createdAt) })
                    : t("notifications.lastDelivery", { date: when(device.lastOkAt) })}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                icon={<Trash2 size={14} />}
                disabled={remove.isPending}
                onClick={() => remove.mutate(device.id)}
              >
                {t("notifications.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Link to="/settings/sessions" className="mt-12 self-start text-body-sm-medium text-fg-accent hover:underline">
        {t("notifications.sessionsLink")}
      </Link>
    </SettingsCard>
  );
}

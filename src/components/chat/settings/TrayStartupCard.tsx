import { MonitorUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { chatOpenInOf, closeToTrayOf, startMinimizedOf } from "../../../lib/chat/notifySettings";
import type { ChatOpenIn, SettingsPatch } from "../../../lib/ipc";
import { useAutostart, useSetAutostart, useSettings } from "../../../lib/queries";
import { isTauri } from "../../../lib/runtime";
import { ChoiceRow, SettingsCard, ToggleRow } from "./SettingRow";

/** The anchor the hint of the first hide into the tray links to: `#/settings?section=tray`. */
export const TRAY_SECTION_ID = "settings-tray";

interface TrayStartupCardProps {
  onChange: (patch: SettingsPatch) => void;
}

type CloseChoice = "tray" | "quit";

/**
 * --- slice: chat notifications ---
 *
 * Settings · Chat · Tray and startup: what the close button does, whether
 * JKNet starts with Windows and stays in the tray then, and where the tray's
 * **Open chats** and a Windows notification open a chat.
 *
 * The close button hides into the tray by default (D6): chats and a private
 * server keep running, and **Quit** of the tray menu leaves. The start with
 * Windows is not in `settings.json` but in the registry, behind
 * `get_autostart` / `set_autostart`; the core answers the state in force,
 * and the switch shows that. The unread badge of the tray icon is the
 * core's own and has no switch.
 */
export function TrayStartupCard({ onChange }: TrayStartupCardProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const settings = useSettings();
  const loading = settings.data === undefined;
  const autostart = useAutostart();
  const setAutostart = useSetAutostart();
  const [error, setError] = useState<string | null>(null);

  const closeToTray = closeToTrayOf(settings.data);
  const startMinimized = startMinimizedOf(settings.data);
  const openIn = chatOpenInOf(settings.data);
  // Outside the installed launcher there is no start with Windows to switch.
  const autostartKnown = isTauri() && autostart.data !== undefined;
  const autostartOn = autostart.data ?? false;

  const toggleAutostart = (enabled: boolean) => {
    setError(null);
    setAutostart.mutate(enabled, {
      onError: (e) => setError(t("settings.tray.autostartFailed", { error: errorText(e) })),
    });
  };

  return (
    <SettingsCard
      id={TRAY_SECTION_ID}
      icon={<MonitorUp size={20} />}
      title={t("settings.tray.title")}
      text={t("settings.tray.text")}
    >
      <ChoiceRow<CloseChoice>
        title={t("settings.tray.close")}
        hint={closeToTray ? t("settings.tray.closeTrayHint") : t("settings.tray.closeQuitHint")}
        value={closeToTray ? "tray" : "quit"}
        disabled={loading}
        options={[
          { value: "tray", label: t("settings.tray.closeTray") },
          { value: "quit", label: t("settings.tray.closeQuit") },
        ]}
        onChange={(value) => onChange({ closeToTray: value === "tray" })}
      />
      <ToggleRow
        title={t("settings.tray.autostart")}
        hint={isTauri() ? t("settings.tray.autostartHint") : t("settings.tray.autostartUnavailable")}
        checked={autostartOn}
        disabled={!autostartKnown || setAutostart.isPending}
        onChange={toggleAutostart}
      >
        {error === null ? null : (
          <p role="alert" className="text-body-sm text-fg-danger">
            {error}
          </p>
        )}
      </ToggleRow>
      <ToggleRow
        title={t("settings.tray.startMinimized")}
        hint={
          autostartKnown && !autostartOn
            ? t("settings.tray.startMinimizedNeedsAutostart")
            : t("settings.tray.startMinimizedHint")
        }
        checked={startMinimized}
        disabled={loading || (autostartKnown && !autostartOn)}
        onChange={(value) => onChange({ startMinimized: value })}
      />
      <ChoiceRow<ChatOpenIn>
        title={t("settings.tray.openIn")}
        hint={t("settings.tray.openInHint")}
        value={openIn}
        disabled={loading}
        options={[
          { value: "main", label: t("settings.tray.openInMain") },
          { value: "window", label: t("settings.tray.openInWindow") },
        ]}
        onChange={(value) => onChange({ chatOpenIn: value })}
      />
    </SettingsCard>
  );
}

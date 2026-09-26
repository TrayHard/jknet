import { Clock, Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../../i18n/useFormat";
import { autoDownloadOf, autoDownloadOptions } from "../../../lib/chat/notifySettings";
import type { SettingsPatch } from "../../../lib/ipc";
import { useChatState, useSettings } from "../../../lib/queries";
import { Select } from "../../ui";
import { SettingRow, SettingsCard } from "./SettingRow";

interface ChatFilesCardProps {
  onChange: (patch: SettingsPatch) => void;
}

/**
 * --- slice: chat notifications ---
 *
 * Settings · Chat · Files: how big a picture may be to download by itself
 * when a chat shows it (`chatAutoDownloadMb`, 0 to 25 MiB), how much of the
 * account's file quota on JKNet Online is taken, and how long chats are
 * kept there. The quota line is there only while the service reports one.
 */
export function ChatFilesCard({ onChange }: ChatFilesCardProps) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const settings = useSettings();
  const quota = useChatState().data?.quota ?? null;
  const current = autoDownloadOf(settings.data);

  const options = autoDownloadOptions(current).map((megabytes) => ({
    value: String(megabytes),
    label:
      megabytes === 0
        ? t("settings.files.never")
        : t("settings.files.upTo", { size: format.number(megabytes) }),
  }));

  const used = quota === null ? 0 : Math.min(1, quota.usedBytes / Math.max(1, quota.quotaBytes));

  return (
    <SettingsCard icon={<Paperclip size={20} />} title={t("settings.files.title")} text={t("settings.files.text")}>
      <SettingRow
        title={t("settings.files.autoDownload")}
        hint={t("settings.files.autoDownloadHint")}
        control={
          <Select
            size="sm"
            ariaLabel={t("settings.files.autoDownload")}
            value={String(current)}
            options={options}
            disabled={settings.data === undefined}
            onChange={(value) => {
              const megabytes = Number(value);
              if (Number.isInteger(megabytes) && megabytes !== current) onChange({ chatAutoDownloadMb: megabytes });
            }}
            className="w-160"
          />
        }
      />
      {quota === null ? null : (
        <SettingRow
          title={t("settings.files.storage")}
          hint={t("settings.files.storageOf", {
            used: format.bytes(quota.usedBytes),
            quota: format.bytes(quota.quotaBytes),
          })}
        >
          <div
            role="meter"
            aria-label={t("settings.files.storage")}
            aria-valuemin={0}
            aria-valuemax={quota.quotaBytes}
            aria-valuenow={quota.usedBytes}
            aria-valuetext={t("settings.files.storageOf", {
              used: format.bytes(quota.usedBytes),
              quota: format.bytes(quota.quotaBytes),
            })}
            className="h-6 rounded-full bg-elevated overflow-hidden"
          >
            <span
              className={used >= 0.9 ? "block h-full bg-danger" : "block h-full bg-accent"}
              style={{ width: `${Math.round(used * 1000) / 10}%` }}
            />
          </div>
          {quota.nextFreeAt === null || quota.usedBytes === 0 ? null : (
            <p className="text-body-sm text-fg-muted">
              {t("settings.files.nextFree", { date: format.date(quota.nextFreeAt) })}
            </p>
          )}
        </SettingRow>
      )}
      <p className="flex items-start gap-8 pt-12 border-t border-line-subtle text-body-sm text-fg-muted">
        <Clock size={14} className="shrink-0 mt-2" />
        <span>{t("settings.files.retention")}</span>
      </p>
    </SettingsCard>
  );
}

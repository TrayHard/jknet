import { MessageCircle, TerminalSquare, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { OnlineProvider } from "../../lib/ipc";

interface ProviderButtonsProps {
  /** Called with the provider the player picked. */
  onPick: (provider: OnlineProvider) => void;
  /** True while a sign-in runs, whichever provider started it. */
  busy?: boolean;
  /** Whether the service runs on this machine, which is what shows Developer. */
  localOnline?: boolean;
}

/**
 * The two provider buttons of the design, and a third for a service on this
 * machine.
 *
 * JKHub and Discord are drawn live rather than disabled: neither has issued an
 * OAuth client yet, and a service says so with `provider_error` — a sentence the
 * player can act on ("not available yet") instead of a greyed-out control that
 * explains nothing. The Developer button only appears against a local service,
 * because the `dev` provider hands out an account for any name typed into a
 * form.
 */
export function ProviderButtons({
  onPick,
  busy = false,
  localOnline = false,
}: ProviderButtonsProps) {
  const { t } = useTranslation("account");

  return (
    <div className="flex flex-col gap-8">
      <ProviderButton
        icon={<UserRound size={20} />}
        label={t("providers.continueJkhub")}
        note={t("providers.continueJkhubNote")}
        disabled={busy}
        onClick={() => onPick("jkhub")}
      />
      <ProviderButton
        icon={<MessageCircle size={20} />}
        label={t("providers.continueDiscord")}
        note={t("providers.continueDiscordNote")}
        disabled={busy}
        onClick={() => onPick("discord")}
      />
      {localOnline ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onPick("dev")}
          className={[
            "flex items-center gap-8 h-28 px-12 self-start rounded-sm",
            "text-body-sm-medium text-fg-secondary transition-colors duration-150",
            "enabled:cursor-pointer enabled:hover:bg-hover-overlay enabled:hover:text-fg",
            "disabled:cursor-not-allowed disabled:text-fg-disabled",
          ].join(" ")}
        >
          <TerminalSquare size={16} />
          {t("providers.developer")}
        </button>
      ) : null}
    </div>
  );
}

interface ProviderButtonProps {
  icon: ReactNode;
  label: string;
  note: string;
  disabled: boolean;
  onClick: () => void;
}

function ProviderButton({
  icon,
  label,
  note,
  disabled,
  onClick,
}: ProviderButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex items-center gap-12 h-56 px-16 rounded-md border border-line bg-input",
        "text-left transition-colors duration-150",
        "enabled:cursor-pointer enabled:hover:bg-surface-hover",
        "disabled:cursor-not-allowed disabled:opacity-60",
      ].join(" ")}
    >
      <span className="flex items-center justify-center size-36 shrink-0 rounded-md bg-elevated text-fg-secondary">
        {icon}
      </span>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="text-body-md-medium text-fg">{label}</span>
        <span className="text-body-sm text-fg-muted truncate">{note}</span>
      </span>
    </button>
  );
}

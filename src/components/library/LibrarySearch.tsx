import { Search, X } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "../ui";
import { JkhubSearchHelp } from "./JkhubSearchHelp";

export function LibrarySearch({ value, onChange, jkhub = false, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  jkhub?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("library");
  const { t: tJkhub } = useTranslation("jkhub");
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-8 flex-1 min-w-200 max-w-[480px]">
      <Input
        ref={input}
        icon={<Search size={16} />}
        aria-label={t("searchPlaceholder")}
        placeholder={t("searchPlaceholder")}
        value={value}
        className="flex-1 min-w-0"
        disabled={disabled}
        title={disabled ? tJkhub("search.unavailable") : undefined}
        onChange={event => onChange(event.target.value)}
        trailing={value ? (
          <button
            type="button"
            aria-label={t("clearSearch")}
            title={t("clearSearch")}
            onClick={() => { onChange(""); input.current?.focus(); }}
            className="inline-flex size-20 items-center justify-center rounded-sm text-fg-muted hover:text-fg cursor-pointer select-none"
          >
            <X size={14} aria-hidden />
          </button>
        ) : undefined}
      />
      {jkhub ? <JkhubSearchHelp /> : null}
    </div>
  );
}

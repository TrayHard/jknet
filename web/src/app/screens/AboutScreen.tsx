import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Logo } from "../../../../src/components/Logo.tsx";
import { useFormat } from "../../../../src/i18n/useFormat.ts";

/** Settings · About: which build this is, and where the launcher lives. */
export function AboutScreen() {
  const { t } = useTranslation("web");
  const format = useFormat();
  return (
    <div className="flex max-w-[640px] flex-col gap-16 px-16 py-24 sm:px-40 sm:py-32">
      <div className="flex items-center gap-12">
        <Logo size={48} />
        <span className="font-display text-[22px] leading-[28px] font-medium tracking-[0.12em] text-fg">JKNET</span>
      </div>
      <p data-testid="build" className="text-body-md text-fg-secondary">
        {t("about.version", { commit: __BUILD_COMMIT__, date: format.date(__BUILD_AT__) })}
      </p>
      <a
        href="https://jknet.app"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-8 self-start text-body-md-medium text-fg-accent hover:underline"
      >
        {t("about.launcher")}
        <ExternalLink size={14} />
      </a>
    </div>
  );
}

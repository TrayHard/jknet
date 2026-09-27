import { useTranslation } from "react-i18next";

import { NAV_SECTIONS } from "../nav.ts";
import type { Section } from "../routeTable.ts";

/** The content pane of the wide layout while nothing is picked: "Pick a chat". */
export function EmptyPane({ section }: { section: Exclude<Section, "settings"> }) {
  const { t } = useTranslation("web");
  const Icon = NAV_SECTIONS.find((item) => item.section === section)?.icon;
  return (
    <div data-testid="empty-pane" className="flex flex-1 flex-col items-center justify-center gap-12 px-24 text-center">
      {Icon !== undefined ? (
        <span className="flex size-48 items-center justify-center rounded-full bg-app text-fg-secondary">
          <Icon size={24} />
        </span>
      ) : null}
      <p className="text-body-md text-fg-secondary">{t(`nav.empty.${section}`)}</p>
    </div>
  );
}

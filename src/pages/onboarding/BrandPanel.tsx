import { Layers, Radar, Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Logo } from "../../components/Logo";

/** One product promise: an icon and a key of the `onboarding` catalog. */
interface ProductPromise {
  icon: ReactNode;
  key: "promiseLaunch" | "promiseClients" | "promiseServers";
}

const PROMISES: ProductPromise[] = [
  { icon: <Rocket size={20} />, key: "promiseLaunch" },
  { icon: <Layers size={20} />, key: "promiseClients" },
  { icon: <Radar size={20} />, key: "promiseServers" },
];

/**
 * The left half of the first run: what JKNet is, in one screen.
 *
 * It stays put while the steps change on the right, so the three promises are
 * read at least once by every new player. Below 1024 px the panel disappears
 * rather than shrinking: the window minimum is 1100 px wide, so this only
 * happens on a display the launcher does not target.
 */
export function BrandPanel() {
  const { t } = useTranslation("onboarding");

  return (
    <aside className="hidden lg:flex flex-col justify-between w-480 shrink-0 bg-sidebar border-r border-line-subtle p-40">
      <div>
        <div className="flex items-center gap-10">
          <Logo size={28} />
          <span className="text-display-nav text-fg tracking-[0.12em]">JKNET</span>
        </div>
        <p className="text-display-md text-fg pt-32">{t("brand.tagline")}</p>
      </div>

      <ul className="flex flex-col gap-20">
        {PROMISES.map((promise) => (
          <li key={promise.key} className="flex items-start gap-12">
            <span className="flex items-center justify-center size-36 shrink-0 rounded-md bg-surface text-fg-accent">
              {promise.icon}
            </span>
            <span className="text-body-md text-fg-secondary pt-8">
              {t(`brand.${promise.key}`)}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-body-sm text-fg-muted">{t("brand.footer")}</p>
    </aside>
  );
}

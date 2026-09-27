import { useTranslation } from "react-i18next";

/**
 * The place of a screen a later part of the web app brings: the chats, the
 * catalogs, notifications, privacy, devices and the install page. The route,
 * the layout and the navigation around it are already the final ones.
 */
export function PendingScreen() {
  const { t } = useTranslation("web");
  return (
    <p data-testid="pending-screen" className="px-24 py-24 text-body-md text-fg-secondary">
      {t("nav.pending")}
    </p>
  );
}

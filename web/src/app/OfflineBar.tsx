import { WifiOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { useSocketStatus } from "./CoreContext.tsx";

/** How long the socket may be down before the bar says so. */
const RECONNECTING_AFTER_MS = 4_000;

function subscribeOnline(notify: () => void): () => void {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

/**
 * "No connection" while the browser is offline, "Reconnecting…" while the
 * network is there and the live socket is not, after a few seconds of it:
 * a socket that comes back at once is not worth a flicker.
 */
export function OfflineBar() {
  const { t } = useTranslation("web");
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const socket = useSocketStatus();
  const [slow, setSlow] = useState(false);
  const down = socket === "closed" || socket === "connecting";

  useEffect(() => {
    if (!down) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), RECONNECTING_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [down]);

  if (online && !(down && slow)) return null;
  return (
    <div
      role="status"
      data-testid="offline-bar"
      className="flex shrink-0 items-center gap-10 border-b border-line-warm bg-warm-subtle px-16 py-8 text-body-sm text-fg"
    >
      <WifiOff size={16} className="shrink-0 text-fg-warm" />
      <span className="min-w-0 flex-1">{online ? t("offline.reconnecting") : t("offline.banner")}</span>
    </div>
  );
}

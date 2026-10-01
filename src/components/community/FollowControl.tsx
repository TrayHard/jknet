import { Bell, BellOff, BellPlus, Check, LogIn } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Button } from "../ui";
import { useCommunityPlatform } from "./platform";

interface FollowProps {
  following: boolean;
  notify: boolean;
  busy: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  onNotify: (notify: boolean) => void;
}

/**
 * **Follow** of a community page, and the bell of a subscription.
 *
 * A guest's press opens a note under the button that says why an account
 * is needed and offers the sign-in, rather than leaving the page for it.
 * Following, the button reads **Following** and unfollows; the bell next to
 * it turns the community's notifications on and off.
 */
export function FollowControl({ following, notify, busy, onFollow, onUnfollow, onNotify }: FollowProps) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const [prompt, setPrompt] = useState(false);
  const promptId = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prompt) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setPrompt(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPrompt(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [prompt]);

  if (!platform.signedIn) {
    return (
      <div ref={box} className="relative">
        <Button
          variant="primary"
          wrap
          icon={<BellPlus size={16} />}
          aria-expanded={prompt}
          aria-controls={prompt ? promptId : undefined}
          onClick={() => setPrompt((open) => !open)}
        >
          {t("follow.follow")}
        </Button>
        {prompt ? (
          <div
            id={promptId}
            role="dialog"
            aria-label={t("follow.promptTitle")}
            className="absolute left-0 top-[calc(100%+8px)] z-40 flex w-[300px] max-w-[calc(100vw-32px)] flex-col gap-6 rounded-lg border border-line-strong bg-elevated p-16 shadow-popover"
          >
            <p className="text-heading-sm text-fg">{t("follow.promptTitle")}</p>
            <p className="text-body-sm text-fg-secondary">{t("follow.promptText")}</p>
            <div className="flex flex-wrap gap-8 pt-8">
              <Button
                size="sm"
                variant="primary"
                wrap
                onClick={() => {
                  setPrompt(false);
                  platform.signIn();
                }}
              >
                {t("common.signIn")}
              </Button>
              <Button size="sm" variant="ghost" wrap onClick={() => setPrompt(false)}>
                {t("follow.notNow")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (!following) {
    return (
      <Button variant="primary" wrap icon={<BellPlus size={16} />} disabled={busy} onClick={onFollow}>
        {t("follow.follow")}
      </Button>
    );
  }

  const bell = notify ? t("follow.notifyOn") : t("follow.notifyOff");
  return (
    <div className="flex gap-4">
      <Button
        wrap
        icon={<Check size={16} />}
        aria-pressed={true}
        title={t("follow.unfollow")}
        disabled={busy}
        onClick={onUnfollow}
      >
        {t("follow.following")}
      </Button>
      <Button
        className={cn("w-36 px-0!", notify && "border-line-accent! bg-accent-subtle! text-fg-accent!")}
        aria-pressed={notify}
        aria-label={bell}
        title={bell}
        disabled={busy}
        onClick={() => onNotify(!notify)}
      >
        {notify ? <Bell size={16} /> : <BellOff size={16} />}
      </Button>
    </div>
  );
}

/** The follow button of a catalogue card: small, and a guest's press signs in. */
export function CardFollowButton({
  following,
  busy,
  onToggle,
}: {
  following: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  if (!platform.signedIn) {
    return (
      <Button size="sm" wrap icon={<LogIn size={14} />} className="relative z-[2]" onClick={platform.signIn}>
        {t("follow.signIn")}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      wrap
      icon={following ? <Check size={14} /> : <BellPlus size={14} />}
      aria-pressed={following}
      title={following ? t("follow.unfollow") : undefined}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        "relative z-[2]",
        following && "border-transparent! bg-accent-subtle! text-fg-accent!",
      )}
    >
      {following ? t("follow.following") : t("follow.follow")}
    </Button>
  );
}

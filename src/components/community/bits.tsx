/**
 * The small pieces every community screen draws: the logo and the cover of
 * a community, a link to a route, the live dot, a failure with its retry,
 * an address to copy and a tag.
 */

import { AlertTriangle, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Button } from "../ui";
import { blobUrl } from "./api";
import { useFailureText } from "./errors";
import { communityHue, monogram } from "./format";
import { useCommunityPlatform, type CommunityRoute } from "./platform";
import type { CommunityCard } from "./types";

/**
 * The hue of a community as a custom property. The placeholder cover and
 * logo are the one place the community screens compute a colour: a
 * decorative gradient, like the previews of maps, from `community.css`.
 */
export function hueStyle(id: string): CSSProperties {
  return { "--jkc-hue": String(communityHue(id)) } as CSSProperties;
}

export type LogoSize = "sm" | "md" | "lg" | "xl" | "hero";

const LOGO_SIZES: Record<LogoSize, string> = {
  sm: "size-24 rounded-sm text-[10px]",
  md: "size-32 rounded-md text-[12px]",
  lg: "size-40 rounded-[10px] text-[15px]",
  xl: "size-48 rounded-lg text-[17px]",
  hero: "size-96 rounded-[20px] border-2 text-[32px]",
};

/** The logo of a community: its picture, or two letters on its hue. */
export function CommunityLogo({
  card,
  size,
  className,
}: {
  card: Pick<CommunityCard, "id" | "name" | "logo">;
  size: LogoSize;
  className?: string;
}) {
  const { apiBase } = useCommunityPlatform();
  const [broken, setBroken] = useState(false);
  const url = blobUrl(apiBase, card.logo);
  const box = cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden select-none", LOGO_SIZES[size], className);
  if (url !== null && !broken) {
    return (
      <span className={cn(box, "bg-elevated")} style={hueStyle(card.id)} aria-hidden="true">
        <img src={url} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      </span>
    );
  }
  return (
    <span className={cn(box, "jkc-logo font-display font-semibold leading-none")} style={hueStyle(card.id)} aria-hidden="true">
      {monogram(card.name)}
    </span>
  );
}

/** The cover of a community: its picture, or the pattern on its hue. */
export function CommunityCover({
  card,
  className,
  label,
}: {
  card: Pick<CommunityCard, "id" | "banner">;
  className?: string;
  /** Read out for the picture; the cover is decoration without it. */
  label?: string;
}) {
  const { apiBase } = useCommunityPlatform();
  const [broken, setBroken] = useState(false);
  const url = blobUrl(apiBase, card.banner);
  const shown = url !== null && !broken;
  return (
    <div
      className={cn("relative overflow-hidden", shown ? "bg-elevated" : "jkc-cover", className)}
      style={hueStyle(card.id)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {shown ? <img src={url} alt="" className="absolute inset-0 size-full object-cover" onError={() => setBroken(true)} /> : null}
    </div>
  );
}

/**
 * A link to a route of the community screens. A plain click moves within the
 * host; a click with a modifier, or the middle button, is the browser's.
 */
export function RouteLink({
  route,
  className,
  children,
  ariaLabel,
  title,
  current = false,
}: {
  route: CommunityRoute;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
  title?: string;
  /** The page open beside the list: marked for a screen reader and a test. */
  current?: boolean;
}) {
  const platform = useCommunityPlatform();
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    platform.navigate(route);
  };
  return (
    <a
      href={platform.href(route)}
      onClick={follow}
      className={className}
      aria-label={ariaLabel}
      title={title}
      aria-current={current ? "page" : undefined}
    >
      {children}
    </a>
  );
}

/** A server that answers now, one that does not, or one nobody asked. */
export type LiveState = "live" | "off" | "unknown";

/** The dot of a server: green when it answers. `pulse` is for the one number per screen that is live. */
export function LiveDot({ state, pulse = false, label }: { state: LiveState; pulse?: boolean; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "relative inline-block size-8 shrink-0 rounded-full",
        state === "live" ? "bg-success" : state === "off" ? "bg-fg-muted" : "bg-elevated",
        pulse && state === "live" && "jkc-pulse",
      )}
    />
  );
}

/** A failure of a read, with the button that reads again. */
export function Failure({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t } = useTranslation("community");
  const text = useFailureText();
  return (
    <div
      role="alert"
      className={cn("flex flex-wrap items-start gap-12 rounded-md border border-line-danger bg-danger-subtle p-12", className)}
    >
      <AlertTriangle size={16} className="mt-2 shrink-0 text-fg-danger" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-[200px] text-body-sm text-fg [overflow-wrap:anywhere]">{text(error)}</p>
      {onRetry ? (
        <Button size="sm" wrap onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

/** A line that says the last write went well or badly, read out when it changes. */
export function Notice({ tone, children }: { tone: "success" | "danger" | "info"; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-12 py-8 text-body-sm text-fg [overflow-wrap:anywhere]",
        tone === "success" && "border-success bg-success-subtle",
        tone === "danger" && "border-line-danger bg-danger-subtle",
        tone === "info" && "border-line-accent bg-accent-subtle",
      )}
    >
      {children}
    </p>
  );
}

/** Copies a text and says so for two seconds. */
export function useCopy(): { copied: string | null; failed: string | null; copy: (text: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    clearTimeout(timer.current);
    setFailed(null);
    const done = () => {
      setCopied(text);
      timer.current = setTimeout(() => setCopied(null), 2000);
    };
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setFailed(text);
      return;
    }
    navigator.clipboard.writeText(text).then(done, () => setFailed(text));
  };
  return { copied, failed, copy };
}

/** The small button that copies a server address, and says so for two seconds. */
export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation("community");
  const { copied, copy } = useCopy();
  const done = copied === text;
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          copy(text);
        }}
        className="inline-flex size-24 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-secondary transition-colors hover:bg-hover-overlay hover:text-fg pointer-coarse:size-44"
        aria-label={t("play.copy", { address: text })}
        title={done ? t("play.copied") : t("play.copy", { address: text })}
      >
        {done ? <Check size={14} className="text-fg-accent" /> : <Copy size={14} />}
      </button>
      {done ? (
        <span role="status" className="sr-only">
          {t("play.copied")}
        </span>
      ) : null}
    </>
  );
}

/** A tag of a community: filled on a card, outlined in the hero of its page. */
export function TagChip({ children, outlined = false }: { children: ReactNode; outlined?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-20 items-center px-8 py-2 text-body-sm-medium text-fg-secondary",
        outlined ? "rounded-sm border border-line-strong" : "rounded-xs bg-selected-overlay",
      )}
    >
      {children}
    </span>
  );
}

/** A card of a page: the surface, the border and the padding every block shares. */
export function Panel({
  children,
  className,
  labelledBy,
  as = "section",
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  as?: "section" | "div" | "article";
}) {
  const Tag = as;
  return (
    <Tag aria-labelledby={labelledBy} className={cn("flex min-w-0 flex-col gap-12 rounded-lg border border-line bg-surface p-16", className)}>
      {children}
    </Tag>
  );
}

/** The title row of a panel: the heading and, at the end, a link or a note. */
export function PanelHead({ id, title, end }: { id?: string; title: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-28 flex-wrap items-center justify-between gap-x-12 gap-y-4">
      <h2 id={id} className="min-w-0 text-heading-sm text-fg [overflow-wrap:anywhere]">
        {title}
      </h2>
      {end}
    </div>
  );
}

/** A link-looking button inside a panel head: «All 23», «Edit». */
export function LinkButton({ children, onClick, className }: { children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex min-h-28 cursor-pointer items-center gap-4 rounded-sm px-4 text-body-sm-medium text-fg-accent hover:underline hover:underline-offset-2",
        className,
      )}
    >
      {children}
    </button>
  );
}

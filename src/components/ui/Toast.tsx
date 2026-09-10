import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";

export type ToastVariant = "info" | "success" | "error";

interface ToastProps {
  variant?: ToastVariant;
  title: string;
  /** One line under the title. Omit it when the title says everything. */
  text?: ReactNode;
  /** Buttons on the right. Keep it to one or two. */
  action?: ReactNode;
  /** Renders the close button and takes its click. */
  onDismiss?: () => void;
  className?: string;
}

const ICONS: Record<ToastVariant, ReactNode> = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  error: <AlertTriangle size={16} />,
};

const TONES: Record<ToastVariant, string> = {
  info: "border-line-accent text-fg-accent",
  success: "border-line text-fg-success",
  error: "border-line-danger text-fg-danger",
};

/**
 * One message floating over the screens: the Toast of the Figma component
 * page, with the three variants it declares.
 *
 * The icon carries the variant colour and the body stays on the surface
 * palette. A toast is read at a glance from the corner of the eye, so the
 * colour has to sit on the one element the eye lands on first.
 */
export function Toast({
  variant = "info",
  title,
  text,
  action,
  onDismiss,
  className,
}: ToastProps) {
  const { t } = useTranslation("common");

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-12 w-[380px] max-w-full",
        "rounded-lg border bg-surface p-16 shadow-popover",
        TONES[variant],
        className,
      )}
    >
      <span className="shrink-0 mt-2">{ICONS[variant]}</span>
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <p className="text-body-md-medium text-fg">{title}</p>
        {text ? (
          <div className="text-body-sm text-fg-secondary">{text}</div>
        ) : null}
        {action ? <div className="flex items-center gap-8 pt-8">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label={t("actions.dismiss")}
          onClick={onDismiss}
          className={cn(
            "shrink-0 flex items-center justify-center size-20 rounded-sm cursor-pointer",
            "text-fg-muted hover:text-fg hover:bg-hover-overlay transition-colors duration-150",
          )}
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

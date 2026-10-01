/**
 * The pieces every section of the management screen is built from: the
 * section card, a labelled field with its counter and its note, the chip of
 * a closed list, and the sentences of the checks.
 */

import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../lib/format";
import { Notice } from "../bits";
import { LINK_NAMES } from "../format";
import type { ManageSection } from "../platform";
import { chars, LIMITS, type Problem } from "./validate";

/** The id of a section's card, for the navigation to scroll to. */
export function sectionId(section: ManageSection): string {
  return `community-manage-${section}`;
}

/**
 * One section of the screen: a card with its heading, an optional count and
 * tools on the heading row, an optional lead under it, and its content.
 */
export function Section({
  section,
  title,
  count,
  tools,
  lead,
  children,
}: {
  section: ManageSection;
  title: string;
  count?: ReactNode;
  tools?: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
}) {
  const id = sectionId(section);
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 scroll-mt-16 flex-col gap-16 rounded-lg border border-line bg-surface px-20 pt-16 pb-20 @max-[560px]/community:px-16"
    >
      <div className="flex min-h-24 flex-wrap items-center gap-x-12 gap-y-8">
        <h2 id={`${id}-title`} className="min-w-0 text-heading-sm text-fg [overflow-wrap:anywhere]">
          {title}
        </h2>
        {count !== undefined ? <span className="text-mono-xs text-fg-secondary">{count}</span> : null}
        {tools ? <div className="ml-auto flex flex-wrap items-center gap-8">{tools}</div> : null}
      </div>
      {lead ? <p className="-mt-8 max-w-[72ch] text-body-sm text-fg-secondary">{lead}</p> : null}
      {children}
    </section>
  );
}

/** The number of characters against the limit, warm in the last tenth. */
export function Counter({ value, max }: { value: string; max: number }) {
  const { t } = useTranslation("community");
  const count = chars(value.trim());
  return (
    <span className={cn("shrink-0 text-mono-xs tabular-nums", count > max ? "text-fg-danger" : count > max * 0.9 ? "text-fg-warm" : "text-fg-secondary")}>
      {t("manage.counter", { count, max })}
    </span>
  );
}

/** The tone of the line under a field. */
export type NoteTone = "neutral" | "ok" | "bad" | "warn";

/** The line under a field: a hint, a check that passed, a problem. */
export function FieldNote({ id, tone = "neutral", children }: { id?: string; tone?: NoteTone; children: ReactNode }) {
  return (
    <p
      id={id}
      className={cn(
        "flex items-start gap-6 text-body-sm [overflow-wrap:anywhere]",
        tone === "neutral" && "text-fg-secondary",
        tone === "ok" && "text-fg-success",
        tone === "bad" && "text-fg-danger",
        tone === "warn" && "text-fg-warm",
      )}
    >
      {tone === "ok" ? <CheckCircle2 size={14} className="mt-2 shrink-0" aria-hidden="true" /> : null}
      {tone === "bad" || tone === "warn" ? <AlertCircle size={14} className="mt-2 shrink-0" aria-hidden="true" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A labelled field: the label and the counter on one row, the control, the note. */
export function Field({
  label,
  htmlFor,
  labelId,
  counter,
  note,
  children,
  className,
}: {
  label: string;
  /** The control the label names; leave it out for a group, and name it by `labelId`. */
  htmlFor?: string;
  labelId?: string;
  counter?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-6", className)}>
      <div className="flex min-w-0 items-baseline justify-between gap-8">
        {htmlFor ? (
          <label id={labelId} htmlFor={htmlFor} className="min-w-0 text-body-sm-medium text-fg-secondary">
            {label}
          </label>
        ) : (
          <span id={labelId} className="min-w-0 text-body-sm-medium text-fg-secondary">
            {label}
          </span>
        )}
        {counter}
      </div>
      {children}
      {note}
    </div>
  );
}

/**
 * The two arrows that move a row up and down a list, stacked in a column as
 * tall as the row: 28 × 18 px each, 44 px apart under a finger.
 */
export function OrderButtons({
  upLabel,
  downLabel,
  first,
  last,
  disabled = false,
  onMove,
}: {
  upLabel: string;
  downLabel: string;
  first: boolean;
  last: boolean;
  disabled?: boolean;
  onMove: (by: -1 | 1) => void;
}) {
  const arrow =
    "flex h-18 w-28 cursor-pointer items-center justify-center rounded-xs text-fg-secondary select-none hover:bg-hover-overlay hover:text-fg disabled:cursor-not-allowed disabled:bg-transparent disabled:text-fg-disabled pointer-coarse:h-22";
  return (
    <span className="flex shrink-0 flex-col">
      <button type="button" className={arrow} aria-label={upLabel} title={upLabel} disabled={disabled || first} onClick={() => onMove(-1)}>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button type="button" className={arrow} aria-label={downLabel} title={downLabel} disabled={disabled || last} onClick={() => onMove(1)}>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

/** A chip of a closed list: on, off, or off and out of room. */
export function Chip({
  on,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-28 cursor-pointer items-center gap-6 rounded-full border px-12 py-4 text-body-sm-medium transition-colors pointer-coarse:min-h-44",
        on
          ? "border-line-accent bg-accent-subtle text-fg-accent"
          : "border-line-strong text-fg-secondary hover:bg-hover-overlay hover:text-fg",
        "disabled:cursor-not-allowed disabled:border-line-subtle disabled:bg-transparent disabled:text-fg-disabled",
      )}
    >
      {children}
    </button>
  );
}

/** The sentence of a problem a check found. `site` names the kind of a link. */
export function useProblemText(): (problem: Problem, context?: { max?: number; kind?: string }) => string {
  const { t } = useTranslation("community");
  return useCallback(
    (problem, context = {}) => {
      switch (problem) {
        case "required":
          return t("manage.problems.required");
        case "tooLong":
          return t("manage.problems.tooLong", { max: context.max ?? LIMITS.link });
        case "oneLine":
          return t("manage.problems.oneLine");
        case "control":
          return t("manage.problems.control");
        case "https":
          return t("manage.problems.https");
        case "invite":
          return t("manage.problems.invite");
        case "linkHost":
          return t("manage.problems.linkHost", { site: LINK_NAMES[context.kind ?? ""] ?? context.kind ?? "" });
        case "linkEmpty":
          return t("manage.problems.linkEmpty");
        case "fileTitle":
          return t("manage.problems.fileTitle");
        case "fileLink":
          return t("manage.problems.fileLink");
        case "fileDuplicate":
          return t("manage.problems.fileDuplicate");
        case "bundle":
          return t("manage.problems.bundle");
      }
    },
    [t],
  );
}

/** What the last write of a section said, until the next one. */
export interface SectionNotice {
  tone: "success" | "danger" | "info";
  text: string;
}

/** The notice of a section, read out when it changes. */
export function SectionNoticeLine({ notice }: { notice: SectionNotice | null }) {
  return notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null;
}

/**
 * A notice that goes by itself: success after a few seconds, a failure
 * when the next action starts.
 */
export function useSectionNotice(): [SectionNotice | null, (notice: SectionNotice | null) => void] {
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const set = useCallback((next: SectionNotice | null) => {
    clearTimeout(timer.current);
    setNotice(next);
    if (next?.tone === "success") timer.current = setTimeout(() => setNotice(null), 6000);
  }, []);
  return [notice, set];
}

/** Bytes as the screen prints a picture: KiB under a mebibyte, MiB from one on. */
export function useSizeText(): (bytes: number) => string {
  const { t, i18n } = useTranslation("community");
  return useCallback(
    (bytes: number) => {
      const format = (value: number) => {
        try {
          return new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
        } catch {
          return String(Math.round(value * 10) / 10);
        }
      };
      return bytes < 1024 * 1024
        ? t("manage.images.kib", { value: format(Math.max(1, Math.round(bytes / 1024))) })
        : t("manage.images.mib", { value: format(bytes / (1024 * 1024)) });
    },
    [t, i18n.language],
  );
}

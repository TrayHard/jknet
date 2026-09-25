import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";

/** How long a button says **Copied** after a press. */
const COPIED_MS = 2000;

/**
 * Puts text on the clipboard and says so for two seconds.
 *
 * The state is the button's own: pressing **Copy** on the password must not
 * turn the address row into **Copied** as well. A clipboard that refuses — a
 * browser tab without focus, a policy — leaves the button as it was rather
 * than claiming a copy that did not happen.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch(() => undefined);
  };

  return { copied, copy };
}

interface CopyButtonProps {
  /** What goes on the clipboard. */
  text: string | null;
  /** The label before the press; **Copy** by default. */
  children?: ReactNode;
  /** What a screen reader hears: «Copy Password». */
  ariaLabel?: string;
  className?: string;
}

/** The Copy button of AddressField and **Copy console command**. */
export function CopyButton({ text, children, ariaLabel, className }: CopyButtonProps) {
  const { t } = useTranslation("host");
  const { copied, copy } = useCopy();

  return (
    <Button
      aria-label={ariaLabel}
      disabled={text === null || text === ""}
      icon={
        copied ? (
          <Check size={16} className="text-fg-success" />
        ) : (
          <Copy size={16} />
        )
      }
      onClick={() => {
        if (text === null || text === "") return;
        copy(text);
      }}
      className={className}
    >
      {copied ? (
        <span className="text-fg-success">{t("running.join.copied")}</span>
      ) : (
        (children ?? t("running.join.copy"))
      )}
    </Button>
  );
}

/**
 * The AddressField of the design: a label, the value in mono, and **Copy**.
 *
 * The value sits in a box the shape of an input but is plain selectable text:
 * the player may copy half of it by hand, and nothing here is editable.
 */
export function AddressField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation("host");
  return (
    <div className="flex items-center gap-12">
      <span className="w-112 shrink-0 text-body-sm text-fg-secondary truncate" title={label}>
        {label}
      </span>
      <div className="flex-1 min-w-0 flex items-center h-36 px-12 rounded-md border border-line bg-input">
        <span className="text-mono-sm text-fg truncate" title={value}>
          {value}
        </span>
      </div>
      <CopyButton
        text={value}
        ariaLabel={t("running.join.copyLabel", { label })}
        className="w-108 shrink-0"
      />
    </div>
  );
}

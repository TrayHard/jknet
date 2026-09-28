import { Monitor } from "lucide-react";

import { cn } from "../../../../src/lib/format.ts";

/**
 * The line every catalog page carries: playing and installing are the
 * launcher's, on the player's PC.
 */
export function PlatformNote({ text, className }: { text: string; className?: string }) {
  return (
    <p
      data-testid="platform-note"
      className={cn(
        "flex items-start gap-10 rounded-md border border-line-subtle bg-accent-subtle px-12 py-10 text-body-sm text-fg",
        className,
      )}
    >
      <Monitor size={16} aria-hidden="true" className="mt-2 shrink-0 text-fg-accent" />
      <span>{text}</span>
    </p>
  );
}

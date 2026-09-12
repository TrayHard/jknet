import { useCallback, useEffect, useRef, type InputHTMLAttributes } from "react";

import { cn } from "../../lib/format";
import { colorSpansWithCodes, colorSpanStyle } from "../servers/ServerName";

/**
 * The one text style both layers wear.
 *
 * The overlay only lines up with the field while the two agree on family,
 * size, line height and tracking to the pixel, so the class is written once
 * and applied twice rather than repeated in two places that could drift.
 */
const TEXT = "text-body-md";

interface ColoredNicknameInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  /** Marks the field as rejected and paints the border red. */
  invalid?: boolean;
}

/**
 * A nickname field whose letters carry the colours the game will give them.
 *
 * A text field cannot paint one word red and the next green — there is one
 * `color` for the whole control — so the field is two layers. Underneath sits
 * a layer of coloured spans; on top sits the real `<input>` with transparent
 * text and a visible caret. The player types into a control that behaves in
 * every way like a text field, and reads a name that looks like the one the
 * server will show.
 *
 * Three things keep the illusion:
 *
 * - **The same characters.** The layer is built by `colorSpansWithCodes`, which
 *   keeps the `^N` codes instead of dropping them. A layer that hid the codes
 *   would be two characters shorter per code and every letter after the first
 *   one would sit away from its caret position. The codes are dimmed instead,
 *   so they read as markup rather than as part of the name.
 * - **The same metrics.** Both layers wear {@link TEXT}, and the layer is
 *   inset by the padding of the field.
 * - **The same scroll.** A field longer than its box scrolls as the caret
 *   moves; the layer is scrolled to match on every `scroll` event the input
 *   fires, which is every one of those moves.
 *
 * The selection is translucent on purpose: an opaque highlight over
 * transparent text would blank the colours out exactly where the player is
 * working.
 */
export function ColoredNicknameInput({
  value,
  onChange,
  invalid = false,
  className,
  ...rest
}: ColoredNicknameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLSpanElement>(null);

  const sync = useCallback(() => {
    const input = inputRef.current;
    const layer = layerRef.current;
    if (input === null || layer === null) return;
    layer.scrollLeft = input.scrollLeft;
  }, []);

  // A value replaced from outside — a saved nickname picked from the list —
  // moves the scroll without a keystroke and without a `scroll` event of its
  // own in every case.
  useEffect(sync, [value, sync]);

  const spans = colorSpansWithCodes(value);

  return (
    <div
      className={cn(
        "relative flex items-center h-36 px-12 rounded-md",
        "bg-input border transition-colors duration-150",
        invalid ? "border-line-danger" : "border-line",
        "focus-within:border-line-focus",
        className,
      )}
    >
      <span
        ref={layerRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-12 right-12 flex items-center overflow-hidden"
      >
        <span className={cn(TEXT, "whitespace-pre")}>
          {spans.map((span, index) => (
            <span
              key={`${index}-${span.text}`}
              style={colorSpanStyle(span)}
              // The code is drawn in the colour it turns on and held back, so
              // the eye reads the name and finds the markup when it looks for
              // it.
              className={span.code === true ? "opacity-45" : undefined}
            >
              {span.text}
            </span>
          ))}
        </span>
      </span>

      <input
        ref={inputRef}
        value={value}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "relative w-full bg-transparent outline-none",
          TEXT,
          // The text itself is drawn by the layer beneath. The caret and the
          // placeholder are not, so both keep a colour of their own.
          "text-transparent caret-fg",
          "placeholder:text-fg-muted",
          "selection:bg-[var(--alpha-cyan-32)] selection:text-transparent",
        )}
        onScroll={sync}
        onChange={(event) => onChange(event.target.value)}
        {...rest}
      />
    </div>
  );
}

import type { InputHTMLAttributes } from "react";

import { cn } from "../../lib/format";

/**
 * Diameter of the thumb, in pixels.
 *
 * A number and not only a class, because the position of the thumb is
 * arithmetic: a native thumb travels from `THUMB / 2` to `width - THUMB / 2`,
 * so a drawn one placed at a plain percentage would drift half a thumb away
 * from the value under the pointer at either end of the track.
 */
const THUMB = 14;

/** Height of the track, in pixels. */
const TRACK = 6;

interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "size"> {
  value: number;
  min: number;
  max: number;
}

/**
 * A range control that is visible in WebView2.
 *
 * The launcher drew its sliders as a bare `<input type="range">` with
 * `appearance: none`, which removes the native track and the native thumb and
 * leaves a Chromium range with nothing drawn at all: the volume rows and the
 * **Character tint** rows were three invisible strips.
 *
 * Styling `::-webkit-slider-runnable-track` and `::-webkit-slider-thumb` back
 * into existence is the usual answer, and it means writing the whole visual
 * language of the control inside vendor pseudo-elements no token can reach
 * without an arbitrary Tailwind variant per rule. This component draws the
 * track, the fill and the thumb as three ordinary elements in project tokens,
 * and keeps the real input on top, transparent, to do the work: the pointer,
 * the arrow keys, `Home` and `End`, the focus ring and the accessible name all
 * stay the browser's own.
 *
 * The decorations take no pointer events, so every click still lands on the
 * input underneath whatever is painted over it.
 */
export function Slider({ value, min, max, className, ...rest }: SliderProps) {
  const span = max - min;
  const ratio = span <= 0 ? 0 : Math.min(1, Math.max(0, (value - min) / span));
  // Where the left edge of the thumb sits: the percentage is of the travel,
  // which is the track minus one thumb.
  const thumbLeft = `calc(${ratio * 100}% - ${ratio * THUMB}px)`;
  // The fill stops under the middle of the thumb, not behind its left edge.
  const fillWidth = `calc(${ratio * 100}% - ${ratio * THUMB}px + ${THUMB / 2}px)`;

  return (
    <span
      className={cn("relative flex items-center", className)}
      // The two sizes are arithmetic above, so they are written here rather
      // than as utilities: Tailwind reads class names, not variables.
      style={{ height: THUMB }}
    >
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        className="peer absolute inset-0 w-full h-full m-0 cursor-pointer opacity-0"
        {...rest}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 rounded-full bg-elevated"
        style={{ height: TRACK }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 rounded-full bg-accent peer-disabled:bg-elevated"
        style={{ height: TRACK, width: fillWidth }}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute rounded-full bg-fg border border-line-strong",
          // The same focus ring the rest of the kit draws, see `RadioCard`:
          // the input under this circle is what the keyboard has, and nothing
          // of it is visible.
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
          "peer-focus-visible:outline-line-focus",
          "peer-disabled:bg-elevated",
        )}
        style={{ height: THUMB, width: THUMB, left: thumbLeft }}
      />
    </span>
  );
}

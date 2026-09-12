import type { CSSProperties } from "react";

import { cn } from "../../lib/format";

/**
 * The game's colour palette, `g_color_table` in
 * `shared/qcommon/q_color.c:19-29` of OpenJK `1a6a6434`.
 *
 * The table is the engine's own and is copied straight: a name the player
 * writes in the launcher has to look the way it will look on the server, and a
 * palette «adjusted for the panel» is a palette that lies about `^0`. The
 * floats of the engine are `0`, `0.5` and `1` per channel, so every entry is
 * `00`, `80` or `FF`.
 *
 * `^7` is white and is written as white rather than left to inherit: the game
 * draws `^7` as a colour of its own, and a row whose text is dimmed would
 * otherwise show `^7` dimmed as well. Text before any code inherits, which is
 * a different thing — nothing has been coloured yet.
 */
const PALETTE: Record<string, string> = {
  "0": "#000000", // black
  "1": "#FF0000", // red
  "2": "#00FF00", // green
  "3": "#FFFF00", // yellow
  "4": "#0000FF", // blue
  "5": "#00FFFF", // cyan
  "6": "#FF00FF", // magenta
  "7": "#FFFFFF", // white
  "8": "#FF8000", // orange, `1 0.5 0` of the engine
  "9": "#808080", // medium grey, `0.5 0.5 0.5` of the engine
};

/**
 * The codes the panel cannot carry on its own, and the halo that saves them.
 *
 * Black on `#0B0E14` is invisible and pure blue is very nearly so — a contrast
 * of about 1.6 to 1. The game draws both over a bright, moving scene; the
 * launcher draws them over a dark panel. Rather than bend the palette, which
 * would show the player a colour the server will not use, the two dark codes
 * keep their hue and get a thin light halo behind the glyphs.
 *
 * A halo of four one-pixel shadows and not `-webkit-text-stroke`: the stroke is
 * painted inside the glyph and eats a 12 px letter from both sides.
 */
const DARK_CODES = new Set(["0", "4"]);

/** The halo of a dark span. Thin enough to read as an outline, not a glow. */
const DARK_HALO = [
  "0 0 1px rgba(255, 255, 255, 0.95)",
  "1px 0 1px rgba(255, 255, 255, 0.65)",
  "-1px 0 1px rgba(255, 255, 255, 0.65)",
  "0 1px 1px rgba(255, 255, 255, 0.65)",
  "0 -1px 1px rgba(255, 255, 255, 0.65)",
].join(", ");

/** One run of characters that shares a colour. */
export interface Span {
  text: string;
  color: string;
  /** The colour is one of {@link DARK_CODES} and needs the halo. */
  dark?: boolean;
  /**
   * The run is the `^N` itself, kept by {@link colorSpansWithCodes} so an
   * overlay can sit exactly on top of the text a field holds.
   */
  code?: boolean;
}

/**
 * How a span should be painted, halo included.
 *
 * One function for every place a coloured name is drawn — the server row, the
 * profile preview, the overlay of the nickname field — so none of them can
 * paint `^0` differently from the others.
 */
export function colorSpanStyle(span: Span): CSSProperties | undefined {
  const color = span.color === "inherit" ? undefined : span.color;
  if (span.dark !== true) {
    return color === undefined ? undefined : { color };
  }
  return { color, textShadow: DARK_HALO };
}

/**
 * Splits a raw name into coloured runs.
 *
 * The rule is the engine's `Q_IsColorString`: `^` followed by `0`..`9` sets
 * the colour and is not drawn; anything else after `^` is an ordinary
 * character. Exported so the parsing can be read on its own.
 */
export function colorSpans(raw: string): Span[] {
  return walk(raw, false);
}

/**
 * The same runs, with the `^N` codes kept as runs of their own.
 *
 * For an overlay drawn on top of a text field: the field holds `^1Kyle` and
 * the layer beneath it has to hold the same six characters, or the letters
 * stop lining up with the caret. The code runs carry `code: true` so the
 * caller can dim them.
 */
export function colorSpansWithCodes(raw: string): Span[] {
  return walk(raw, true);
}

/** The one walk behind both functions. */
function walk(raw: string, keepCodes: boolean): Span[] {
  const spans: Span[] = [];
  let code: string | null = null;
  let text = "";

  const push = () => {
    if (text.length === 0) return;
    spans.push(span(text, code));
    text = "";
  };

  for (let at = 0; at < raw.length; at += 1) {
    const next = raw[at + 1];
    if (raw[at] === "^" && next !== undefined && next >= "0" && next <= "9") {
      push();
      if (keepCodes) {
        // Drawn in the colour it turns on, so a player reading the field can
        // tell which code did what, and dimmed by the caller.
        spans.push({ ...span(`^${next}`, next), code: true });
      }
      code = next;
      at += 1;
      continue;
    }
    text += raw[at];
  }
  push();
  return spans;
}

/** One run in the colour of `code`, or in the inherited colour. */
function span(text: string, code: string | null): Span {
  if (code === null) return { text, color: "inherit" };
  const color = PALETTE[code];
  if (color === undefined) return { text, color: "inherit" };
  return DARK_CODES.has(code) ? { text, color, dark: true } : { text, color };
}

interface ServerNameProps {
  /** The name with its colour codes. */
  raw: string;
  /** The same name stripped, used when `raw` is empty or all codes. */
  clean: string;
  className?: string;
}

/** Draws a server or player name with the game's colours. */
export function ServerName({ raw, clean, className }: ServerNameProps) {
  const spans = colorSpans(raw);
  return (
    <span className={cn("truncate", className)} title={clean}>
      {spans.length === 0
        ? clean
        : spans.map((item, index) => (
            <span key={`${index}-${item.text}`} style={colorSpanStyle(item)}>
              {item.text}
            </span>
          ))}
    </span>
  );
}

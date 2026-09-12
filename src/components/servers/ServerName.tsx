import type { CSSProperties } from "react";

import { cn } from "../../lib/format";

/**
 * The game's colour palette, `g_color_table` in
 * `shared/qcommon/q_color.c:19-29` of OpenJK `1a6a6434`.
 *
 * The table is the engine's, with one exception. The floats of the engine are
 * `0`, `0.5` and `1` per channel, so every entry is `00`, `80` or `FF`. The
 * exception is `^0`: pure black on the launcher's `#0B0E14` is nothing at all,
 * so the code is drawn in the grey the panel can carry. Every other code keeps
 * the engine's value — pure blue `^4` included, which is dark here and still
 * the colour the server will use.
 *
 * Nothing is outlined and nothing sits on a backing. A halo behind the glyphs
 * of the two dark codes made them read as highlighted text: the name lost its
 * colours and gained a marker pen.
 *
 * `^7` is white and is written as white rather than left to inherit: the game
 * draws `^7` as a colour of its own, and a row whose text is dimmed would
 * otherwise show `^7` dimmed as well. Text before any code inherits, which is
 * a different thing — nothing has been coloured yet.
 */
const PALETTE: Record<string, string> = {
  "0": "#4A5058", // black in the game, greyed to stay visible on the panel
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

/** One run of characters that shares a colour. */
export interface Span {
  text: string;
  color: string;
  /**
   * The run is the `^N` itself, kept by {@link colorSpansWithCodes} so an
   * overlay can sit exactly on top of the text a field holds.
   */
  code?: boolean;
}

/**
 * How a span should be painted.
 *
 * One function for every place a coloured name is drawn — the server row, the
 * profile preview, the overlay of the nickname field — so none of them can
 * paint `^0` differently from the others.
 */
export function colorSpanStyle(span: Span): CSSProperties | undefined {
  if (span.color === "inherit") return undefined;
  return { color: span.color };
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
  return { text, color: PALETTE[code] ?? "inherit" };
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

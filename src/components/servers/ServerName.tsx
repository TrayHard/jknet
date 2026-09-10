import { cn } from "../../lib/format";

/**
 * The game's colour palette, `g_color_table` in
 * `shared/qcommon/q_color.c:18` of OpenJK.
 *
 * Two entries are lifted for the launcher's dark surface: `^0` is pure black
 * and `^4` is pure blue in the game, and both are unreadable on `#0B0E14`.
 * The game draws them over a bright HUD, this table draws them over a panel,
 * so the hue is kept and the luminance is raised.
 */
const PALETTE: Record<string, string> = {
  "0": "#4A5058", // black in game, lifted to stay visible
  "1": "#FF4A4A", // red, softened so it does not vibrate on dark
  "2": "#3BE07A",
  "3": "#FFE14A",
  "4": "#5B7BFF", // blue in game, lifted to stay visible
  "5": "#4AE3FF",
  "6": "#FF6EE0",
  "7": "inherit", // white: let the row's own colour through
  "8": "#FF9A3C",
  "9": "#9AA3AE",
};

/** One run of characters that shares a colour. */
interface Span {
  text: string;
  color: string;
}

/**
 * Splits a raw name into coloured runs.
 *
 * The rule is the engine's `Q_IsColorString`: `^` followed by `0`..`9` sets
 * the colour and is not drawn; anything else after `^` is an ordinary
 * character. Exported so the parsing can be read on its own.
 */
export function colorSpans(raw: string): Span[] {
  const spans: Span[] = [];
  let color = "inherit";
  let text = "";

  const push = () => {
    if (text.length > 0) spans.push({ text, color });
    text = "";
  };

  for (let at = 0; at < raw.length; at += 1) {
    const code = raw[at + 1];
    if (raw[at] === "^" && code !== undefined && code >= "0" && code <= "9") {
      push();
      color = PALETTE[code] ?? "inherit";
      at += 1;
      continue;
    }
    text += raw[at];
  }
  push();
  return spans;
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
        : spans.map((span, index) => (
            <span
              key={`${index}-${span.text}`}
              style={span.color === "inherit" ? undefined : { color: span.color }}
            >
              {span.text}
            </span>
          ))}
    </span>
  );
}

import { colorSpans, colorSpanStyle } from "../servers/ServerName";

/**
 * A nickname drawn the way the game draws it.
 *
 * The parsing is `colorSpans` of `ServerName`, which is the engine's own
 * `Q_IsColorString` rule and the palette the launcher already uses for server
 * and player names. One rule for every coloured name on screen: a preview that
 * coloured `^4` differently from the row of the server it appears on would be
 * a preview of something else.
 *
 * `placeholder` stands in for an empty name and for one made of colour codes
 * alone, which is what the server would replace with `Padawan` anyway.
 */
export function ColoredNickname({
  raw,
  placeholder,
  className,
}: {
  raw: string;
  placeholder: string;
  className?: string;
}) {
  const spans = colorSpans(raw).filter((span) => span.text.length > 0);
  if (spans.length === 0) {
    return <span className={className}>{placeholder}</span>;
  }
  return (
    <span className={className}>
      {spans.map((span, index) => (
        <span key={`${index}-${span.text}`} style={colorSpanStyle(span)}>
          {span.text}
        </span>
      ))}
    </span>
  );
}

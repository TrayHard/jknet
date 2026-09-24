/**
 * --- slice: pk3 contents ---
 * The StringEd format of `strings/<language>/<package>.str`, read the way
 * the game reads it (`codemp/qcommon/stringed_ingame.cpp`, `ParseLine`).
 *
 * A file is a header (`VERSION`, `CONFIG`, `FILENOTES`) and then entries:
 * `REFERENCE NAME`, an optional `NOTES "…"`, `FLAGS …`, and one `LANG_<X> "…"`
 * line per language, ending with `ENDMARKER`. Keywords match by prefix
 * regardless of case; a value is what stands between the outer quotes, with
 * `\n` written out as two characters; `//` starts a comment unless it sits
 * inside quotes. Nothing here runs: the text is shown, never executed.
 */

export interface StringsEntry {
  /** The `REFERENCE` name, as written. */
  key: string;
  /** The `NOTES` line, for the translator; the game ignores it. */
  notes: string | null;
  /** Language of the `LANG_<X>` line, lowercased, to the text of that line. */
  values: Record<string, string>;
}

export interface StringsFile {
  entries: StringsEntry[];
  /** Every language a `LANG_` line names, lowercased, in order of first appearance. */
  languages: string[];
  /** Whether the file ends in `ENDMARKER`, which the game insists on. */
  complete: boolean;
}

/** The part of a line before a `//` that is not inside quotes. */
function withoutComment(line: string): string {
  let quotes = 0;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === '"') quotes += 1;
    else if (char === "/" && line[at + 1] === "/" && quotes % 2 === 0) return line.slice(0, at);
  }
  return line;
}

/** `InsideQuotes` of the game: trims, then drops one leading and one trailing quote. */
function insideQuotes(rest: string): string {
  let text = rest.trim();
  if (text.startsWith('"')) text = text.slice(1);
  if (text.endsWith('"')) text = text.slice(0, -1);
  return text;
}

/** `ConvertCRLiterals_Read` of the game: a written `\n` is a line break. */
function withLineBreaks(text: string): string {
  return text.replace(/\\n/g, "\n");
}

export function parseStringsFile(text: string): StringsFile {
  const entries: StringsEntry[] = [];
  const languages: string[] = [];
  let current: StringsEntry | null = null;
  let complete = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = withoutComment(raw).trim();
    if (line === "") continue;
    const space = line.search(/[ \t]/);
    const keyword = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const rest = space < 0 ? "" : line.slice(space + 1);
    if (keyword === "REFERENCE") {
      current = { key: insideQuotes(rest), notes: null, values: {} };
      entries.push(current);
    } else if (keyword === "NOTES") {
      if (current) current.notes = insideQuotes(rest);
    } else if (keyword === "ENDMARKER") {
      complete = true;
    } else if (keyword.startsWith("LANG_") && current) {
      const language = keyword.slice("LANG_".length).toLowerCase();
      if (language === "") continue;
      current.values[language] = withLineBreaks(insideQuotes(rest));
      if (!languages.includes(language)) languages.push(language);
    }
    // VERSION, CONFIG, FILENOTES and FLAGS carry nothing the table shows.
  }
  return { entries, languages, complete };
}

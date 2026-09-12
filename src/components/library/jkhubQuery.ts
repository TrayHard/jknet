/**
 * The `by:` operator of the catalogue search, from the screen's side.
 *
 * The search itself is the core's: `index::parse_query` in
 * `src-tauri/src/jkhub/index.rs` reads the query and decides what matches, and
 * nothing here filters anything. What is here is the other direction — writing
 * an operator into the box when the player clicks an author's name — and the
 * two have to agree on the same grammar, which is why the reader below mirrors
 * the core's rules for skipping one.
 */

/** The operator, as it is typed. */
const OPERATOR = "by:";

/**
 * The words of a query with every `by:` taken out.
 *
 * Both forms are skipped whole, quotes and the spaces inside them included, so
 * `by:"Szico VII" duel` leaves `duel` and not `VII"` alongside it.
 */
function withoutAuthors(query: string): string[] {
  const words: string[] = [];
  let rest = query;
  while (rest.length > 0) {
    const start = rest.replace(/^\s+/, "");
    if (start.length === 0) break;
    if (start.slice(0, OPERATOR.length).toLowerCase() === OPERATOR) {
      const value = start.slice(OPERATOR.length);
      if (value.startsWith('"')) {
        // An unclosed quote runs to the end, the way the core reads it.
        const end = value.indexOf('"', 1);
        rest = end < 0 ? "" : value.slice(end + 1);
      } else {
        const end = value.search(/\s/);
        rest = end < 0 ? "" : value.slice(end);
      }
      continue;
    }
    const end = start.search(/\s/);
    words.push(end < 0 ? start : start.slice(0, end));
    rest = end < 0 ? "" : start.slice(end);
  }
  return words;
}

/**
 * The query that asks for this author, keeping every word the player typed.
 *
 * The quoted form, because a click means this author and not everyone whose
 * name holds those letters. A `by:` already in the box is replaced rather than
 * added to: two of them are two conditions in the core, and clicking a second
 * author would otherwise answer nothing at all.
 *
 * ```ts
 * byAuthor("", "Circa")                       // 'by:"Circa"'
 * byAuthor("duel", "Szico VII")               // 'by:"Szico VII" duel'
 * byAuthor('by:"Circa" duel', "Szico VII")    // 'by:"Szico VII" duel'
 * ```
 */
export function byAuthor(query: string, author: string): string {
  // A quote inside the name would close the operator early. The site allows
  // one in a display name, and dropping it is closer to what the player meant
  // than a query that stops parsing halfway.
  const name = author.replace(/"/g, "").trim();
  if (name === "") return withoutAuthors(query).join(" ");
  const filter = `${OPERATOR}"${name}"`;
  const words = withoutAuthors(query);
  return words.length > 0 ? `${filter} ${words.join(" ")}` : filter;
}

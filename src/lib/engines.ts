/**
 * The route of the engine page, in one place.
 *
 * Three callers build it — a client card, a tile of the New client dialog and
 * the page's own back link — and they live in three folders. It sits in `lib`
 * rather than next to the page so that a component never has to import a page,
 * which is the shape of an import cycle waiting to happen.
 */

/** The hash route of the page of one engine, without the leading `#`. */
export function engineRoute(engineId: string): string {
  return `/engines/${engineId}`;
}

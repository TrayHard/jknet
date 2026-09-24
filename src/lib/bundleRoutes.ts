/**
 * --- slice: bundles ---
 *
 * The routes of the bundles feature, spelled once.
 *
 * The editor of a draft is a page of the main window at
 * `#/bundles/drafts/<id>`; the catalogue is the **Bundles** tab of the
 * Clients screen, which opens a record when the address names one. Both are
 * built here so that the tab, the editor, the client card and the dialogs
 * do not spell the same hash four times.
 */

/** The search parameter that picks the tab of the Clients screen: `#/clients?tab=bundles`. */
export const CLIENTS_TAB_PARAM = "tab";

/** The search parameter that opens one record on the Bundles tab. */
export const OPEN_BUNDLE_PARAM = "bundle";

/** The editor of one draft. */
export function draftRoute(draftId: string): string {
  return `/bundles/drafts/${encodeURIComponent(draftId)}`;
}

/** The Bundles tab, opened on one record when `bundleId` is given. */
export function bundlesTabRoute(bundleId?: string | null): string {
  const params = new URLSearchParams();
  params.set(CLIENTS_TAB_PARAM, "bundles");
  if (bundleId) params.set(OPEN_BUNDLE_PARAM, bundleId);
  return `/clients?${params.toString()}`;
}

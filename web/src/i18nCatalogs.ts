/**
 * Which catalogs the web app loads, as pure functions over the globs of
 * `i18n.ts`.
 *
 * The web app reads the launcher's catalogs of the namespaces its shared
 * components use, plus its own `web` namespace, and nothing else: a launcher
 * screen's strings never reach a phone. `i18n.ts` hands the glob maps of Vite
 * to these functions; `i18n.test.mjs` hands them fakes with extra namespaces
 * and checks that only these arrive.
 */

/**
 * The namespaces the shared components of the web app read, plus `web`.
 * Excluded: `nav`, `home`, `settings`, `onboarding`, `update`.
 */
export const WEB_NAMESPACES = [
  "common",
  "errors",
  "games",
  "friends",
  "chat",
  "account",
  "servers",
  "bundles",
  "host",
  "clients",
  "library",
  "pk3",
  "jkhub",
  // --- slice: communities ---
  "community",
  // --- slice: community events ---
  "events",
  "web",
] as const;

export type WebNamespace = (typeof WEB_NAMESPACES)[number];

export type Catalog = Record<string, unknown>;

/** The key of one catalog file in the glob maps of `i18n.ts`. */
export function catalogPath(language: string, namespace: WebNamespace): string {
  return namespace === "web"
    ? `./locales/${language}/web.json`
    : `../../src/locales/${language}/${namespace}.json`;
}

/** English as i18next wants it: one object per namespace, only the web's. */
export function englishResources(eager: Record<string, Catalog>): Record<string, Catalog> {
  const resources: Record<string, Catalog> = {};
  for (const namespace of WEB_NAMESPACES) {
    const catalog = eager[catalogPath("en", namespace)];
    if (catalog !== undefined) resources[namespace] = catalog;
  }
  return resources;
}

/**
 * Fetches the catalogs of one language, the web's namespaces only.
 *
 * A file that fails to load is left out: i18next then answers from English,
 * the same fallback a missing key gets.
 */
export async function loadCatalogs(
  language: string,
  lazy: Record<string, () => Promise<Catalog>>,
): Promise<Array<{ namespace: WebNamespace; catalog: Catalog }>> {
  const files = await Promise.all(
    WEB_NAMESPACES.map(async (namespace) => {
      const load = lazy[catalogPath(language, namespace)];
      if (load === undefined) return null;
      try {
        return { namespace, catalog: await load() };
      } catch (error) {
        console.warn(`i18n: ${language}/${namespace}.json did not load`, error);
        return null;
      }
    }),
  );
  return files.filter((file): file is { namespace: WebNamespace; catalog: Catalog } => file !== null);
}

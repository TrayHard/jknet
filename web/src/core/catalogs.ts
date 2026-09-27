/**
 * The read-only catalogs of JKNet Online that the reused components ask the
 * web core for.
 *
 * Bundles come from the catalogue the launcher reads (`GET /v1/bundles…`).
 * A record of a bundle is what a bundle card of the chat draws; the half the
 * launcher's core adds — which clients of this machine came out of the
 * bundle — is empty in a browser, which installs nothing.
 */

import type { BundleDetails, BundleDetailsWithLocal } from "../../../src/lib/ipc.ts";
import { invalidInput } from "./errors.ts";
import { segment, type Http } from "./http.ts";

export interface CatalogsDeps {
  http: Http;
  signedIn(): boolean;
}

export interface Catalogs {
  /** `get_bundle`: one record of the catalogue, with nothing of it installed here. */
  bundle(bundleId: string): Promise<BundleDetailsWithLocal>;
}

export function createCatalogs(deps: CatalogsDeps): Catalogs {
  const { http } = deps;
  return {
    async bundle(bundleId) {
      const id = bundleId.trim();
      if (id === "") throw invalidInput("an empty bundle id");
      // The catalogue is public; a signed-in player's token adds what they liked.
      const details = await http.request<BundleDetails>("GET", `/v1/bundles/${segment(id)}`, { auth: deps.signedIn() });
      return { ...details, local: { installedClients: [], engineKnown: {} } };
    },
  };
}

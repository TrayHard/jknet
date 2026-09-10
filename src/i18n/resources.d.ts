/**
 * The types behind `t()`.
 *
 * The English catalogs are the source language, so they are also the shape of
 * every other one: `CustomTypeOptions` derives the key space from them, which
 * makes `t("filters.mode")` autocomplete and `t("filters.mod3")` a compile
 * error. A key renamed in `src/locales/en/` therefore fails `npm run typecheck`
 * at every call site, in the same edit.
 *
 * Only English is listed. The other catalogs are checked against it by
 * `scripts/i18n-check.mjs`, which is where a missing or extra key in Russian is
 * caught; TypeScript cannot see a file that is loaded through `import()`.
 */

import type account from "../locales/en/account.json";
import type clients from "../locales/en/clients.json";
import type common from "../locales/en/common.json";
import type errors from "../locales/en/errors.json";
import type friends from "../locales/en/friends.json";
import type games from "../locales/en/games.json";
import type home from "../locales/en/home.json";
import type jkhub from "../locales/en/jkhub.json";
import type library from "../locales/en/library.json";
import type nav from "../locales/en/nav.json";
import type onboarding from "../locales/en/onboarding.json";
import type servers from "../locales/en/servers.json";
import type settings from "../locales/en/settings.json";
import type update from "../locales/en/update.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    /** `t()` answers `string`, never `null`: `returnNull` is off in the init. */
    returnNull: false;
    resources: {
      common: typeof common;
      nav: typeof nav;
      home: typeof home;
      servers: typeof servers;
      clients: typeof clients;
      library: typeof library;
      jkhub: typeof jkhub;
      friends: typeof friends;
      account: typeof account;
      settings: typeof settings;
      onboarding: typeof onboarding;
      errors: typeof errors;
      games: typeof games;
      update: typeof update;
    };
  }
}

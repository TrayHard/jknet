/// <reference types="vite/client" />

/** The commit the bundle was built from, `git rev-parse --short=7 HEAD`. */
declare const __BUILD_COMMIT__: string;
/** When the bundle was built, ISO 8601. */
declare const __BUILD_AT__: string;

interface ImportMetaEnv {
  /** The JKNet Online API: `https://api.jknet.app` unless the mode says otherwise. */
  readonly VITE_JKNET_API: string;
}

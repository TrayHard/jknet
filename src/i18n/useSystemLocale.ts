/**
 * The locale of the operating system, for the «System language» setting.
 *
 * Inside Tauri it comes from `locale()` of `@tauri-apps/plugin-os`, which reads
 * the user's Windows display language rather than the webview's. In a plain
 * browser — `npm run dev` — the webview is all there is, so `navigator.language`
 * stands in.
 *
 * The value is read once and cached at module level. It cannot change while
 * the launcher runs: Windows applies a display language change at sign-out.
 */

import { locale } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";

import { isTauri } from "../lib/runtime";

let cached: string | null = null;

/** The browser's own answer, and the only one outside the Tauri runtime. */
function browserLocale(): string | null {
  if (typeof navigator === "undefined") return null;
  return navigator.language || null;
}

/**
 * Reads the system locale once, from wherever it can be read.
 *
 * Never rejects: a plugin call that fails leaves the launcher on the browser's
 * locale, and a browser that reports none leaves it on English.
 */
export async function readSystemLocale(): Promise<string | null> {
  if (cached !== null) return cached;
  if (!isTauri()) {
    cached = browserLocale();
    return cached;
  }
  try {
    cached = (await locale()) ?? browserLocale();
  } catch {
    cached = browserLocale();
  }
  return cached;
}

/** The system locale as a piece of React state, `null` until it is read. */
export function useSystemLocale(): string | null {
  const [value, setValue] = useState<string | null>(cached);

  useEffect(() => {
    if (value !== null) return;
    let live = true;
    void readSystemLocale().then((answer) => {
      if (live) setValue(answer);
    });
    return () => {
      live = false;
    };
  }, [value]);

  return value;
}

import { openUrl } from "@tauri-apps/plugin-opener";
import type { MouseEvent } from "react";

import { isTauri } from "../../lib/runtime";

/** Descriptions and comments share the core's sanitized HTTP(S) links. */
export function openJkhubLink(event: MouseEvent<HTMLDivElement>) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href) || !isTauri()) return;
  void openUrl(href).catch(() => undefined);
}

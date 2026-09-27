/**
 * What kind of device the web app runs on, and the name its session gets.
 *
 * The kind decides the label friends read: "Online from phone" for a phone,
 * "Online in browser" for everything else, tablets included. The sign-in and
 * every socket ticket send the same value. It never follows the layout: a
 * phone turned sideways is still a phone, and a narrow desktop window is still
 * a desktop.
 *
 * The rule, in order:
 * 1. `navigator.userAgentData.mobile`, where the browser has it (Chromium);
 * 2. otherwise a coarse pointer on a screen whose short side is under 600 px
 *    (Safari and Firefox on a phone);
 * 3. otherwise a desktop.
 */

import type { WebDevice } from "../../../src/lib/ipc.ts";

export type DeviceKind = WebDevice;

/** The short side of a screen below which a touch screen is a phone. */
export const PHONE_SCREEN_MAX = 600;

/** What the rule reads, separated from `navigator` for the tests. */
export interface DeviceSignals {
  /** `navigator.userAgentData.mobile`, `undefined` where the browser has none. */
  uaDataMobile: boolean | undefined;
  /** `matchMedia("(pointer: coarse)").matches`. */
  coarsePointer: boolean;
  /** `Math.min(screen.width, screen.height)` in CSS pixels. */
  shortSide: number;
}

export function deviceKindOf(signals: DeviceSignals): DeviceKind {
  if (signals.uaDataMobile !== undefined) return signals.uaDataMobile ? "phone" : "desktop";
  return signals.coarsePointer && signals.shortSide < PHONE_SCREEN_MAX ? "phone" : "desktop";
}

interface UaData {
  mobile?: boolean;
  platform?: string;
  brands?: Array<{ brand: string; version: string }>;
}

function uaData(): UaData | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
}

/** The kind of this device, read from the browser. */
export function deviceKind(): DeviceKind {
  const data = uaData();
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const shortSide = typeof screen === "undefined" ? Infinity : Math.min(screen.width, screen.height);
  return deviceKindOf({
    uaDataMobile: typeof data?.mobile === "boolean" ? data.mobile : undefined,
    coarsePointer: coarse,
    shortSide,
  });
}

/** The longest session name the service keeps. */
export const DEVICE_NAME_MAX = 64;

/** `Android`, `iOS`, `Windows`… out of a user agent string. */
export function systemOf(userAgent: string, platform?: string): string {
  const fromPlatform = (platform ?? "").trim();
  if (fromPlatform !== "" && fromPlatform.toLowerCase() !== "unknown") {
    return fromPlatform === "macOS" || fromPlatform === "Mac OS X" ? "macOS" : fromPlatform;
  }
  if (/Android/i.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iOS";
  if (/CrOS/i.test(userAgent)) return "ChromeOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "";
}

/** `Chrome`, `Edge`, `Firefox`, `Safari`… out of the brands or the user agent. */
export function browserOf(userAgent: string, brands?: Array<{ brand: string }>): string {
  const named = (brands ?? [])
    .map((entry) => entry.brand)
    .filter((brand) => !/not.?a.?brand/i.test(brand) && brand !== "Chromium");
  if (named.length > 0) {
    const brand = named[0];
    if (/Google Chrome/i.test(brand)) return "Chrome";
    if (/Microsoft Edge/i.test(brand)) return "Edge";
    return brand;
  }
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/SamsungBrowser\//.test(userAgent)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "";
}

/** `JKNet web · Android · Chrome`, at most 64 characters. */
export function deviceNameOf(parts: { system: string; browser: string }): string {
  const name = ["JKNet web", parts.system, parts.browser].filter((part) => part !== "").join(" · ");
  return name.length > DEVICE_NAME_MAX ? name.slice(0, DEVICE_NAME_MAX) : name;
}

/** The name the sessions list shows for this browser. */
export function deviceName(): string {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const data = uaData();
  return deviceNameOf({
    system: systemOf(userAgent, data?.platform),
    browser: browserOf(userAgent, data?.brands),
  });
}

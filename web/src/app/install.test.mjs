import assert from "node:assert/strict";
import { test } from "node:test";

import { isIos, needsHomeScreen } from "./install.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0";

test("iPhones and iPads are told apart from the rest", () => {
  const cases = [
    [{ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 }, true],
    [{ userAgent: IPHONE_CHROME, platform: "iPhone", maxTouchPoints: 5 }, true],
    // An iPad asks for the desktop site and names itself a Mac.
    [{ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 5 }, true],
    [{ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 0 }, false],
    [{ userAgent: ANDROID, platform: "Linux armv81", maxTouchPoints: 5 }, false],
    [{ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 0 }, false],
  ];
  for (const [signals, ios] of cases) assert.equal(isIos({ ...signals, standalone: false }), ios, signals.userAgent);
});

test("only an iPhone or iPad in a browser tab needs the Home Screen for push", () => {
  assert.equal(needsHomeScreen({ ios: true, standalone: false }), true);
  assert.equal(needsHomeScreen({ ios: true, standalone: true }), false);
  assert.equal(needsHomeScreen({ ios: false, standalone: false }), false);
});

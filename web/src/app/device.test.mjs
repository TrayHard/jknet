import assert from "node:assert/strict";
import { test } from "node:test";

import { browserOf, deviceKindOf, deviceNameOf, systemOf } from "./device.ts";

test("the device kind of every combination of signals", () => {
  const table = [
    // userAgentData decides wherever the browser has it.
    [{ uaDataMobile: true, coarsePointer: true, shortSide: 390 }, "phone"],
    [{ uaDataMobile: true, coarsePointer: false, shortSide: 1080 }, "phone"],
    [{ uaDataMobile: false, coarsePointer: true, shortSide: 390 }, "desktop"],
    [{ uaDataMobile: false, coarsePointer: false, shortSide: 1080 }, "desktop"],
    // Without it: a coarse pointer on a small screen is a phone.
    [{ uaDataMobile: undefined, coarsePointer: true, shortSide: 390 }, "phone"],
    [{ uaDataMobile: undefined, coarsePointer: true, shortSide: 599 }, "phone"],
    // A tablet is a browser, and so is a mouse on a small screen.
    [{ uaDataMobile: undefined, coarsePointer: true, shortSide: 600 }, "desktop"],
    [{ uaDataMobile: undefined, coarsePointer: true, shortSide: 820 }, "desktop"],
    [{ uaDataMobile: undefined, coarsePointer: false, shortSide: 390 }, "desktop"],
    [{ uaDataMobile: undefined, coarsePointer: false, shortSide: 1440 }, "desktop"],
  ];
  for (const [signals, kind] of table) {
    assert.equal(deviceKindOf(signals), kind, JSON.stringify(signals));
  }
});

test("the system and the browser out of common user agents", () => {
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const windowsEdge =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  const firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
  assert.equal(systemOf(android), "Android");
  assert.equal(browserOf(android), "Chrome");
  assert.equal(systemOf(iphone), "iOS");
  assert.equal(browserOf(iphone), "Safari");
  assert.equal(systemOf(windowsEdge), "Windows");
  assert.equal(browserOf(windowsEdge), "Edge");
  assert.equal(browserOf(firefox), "Firefox");
});

test("userAgentData names win over the user agent string", () => {
  assert.equal(systemOf("anything", "Android"), "Android");
  assert.equal(
    browserOf("anything", [{ brand: "Not)A;Brand" }, { brand: "Chromium" }, { brand: "Microsoft Edge" }]),
    "Edge",
  );
  assert.equal(browserOf("anything", [{ brand: "Chromium" }, { brand: "Google Chrome" }]), "Chrome");
});

test("the session name has the service's shape and length", () => {
  assert.equal(deviceNameOf({ system: "Android", browser: "Chrome" }), "JKNet web · Android · Chrome");
  assert.equal(deviceNameOf({ system: "", browser: "" }), "JKNet web");
  assert.ok(deviceNameOf({ system: "x".repeat(80), browser: "y" }).length <= 64);
});

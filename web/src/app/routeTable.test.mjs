import assert from "node:assert/strict";
import { test } from "node:test";

import { fillPath, findRoute, matchPath, parentOf, ROUTES, SECTION_ROOTS, SECTIONS } from "./routeTable.ts";

test("every parent is a route of the same section", () => {
  for (const spec of ROUTES) {
    if (spec.parent === undefined) continue;
    const parent = ROUTES.find((other) => other.path === spec.parent);
    assert.ok(parent, `${spec.path}: parent ${spec.parent} is not a route`);
    assert.equal(parent.section, spec.section, `${spec.path}: parent in another section`);
  }
});

test("a route with a detail has a parent, a root has none", () => {
  for (const spec of ROUTES) {
    if (spec.detail !== undefined) assert.ok(spec.parent, `${spec.path} has no parent`);
    else assert.equal(spec.parent, undefined, `${spec.path} is a root with a parent`);
  }
});

test("an aside route sits on the detail route it belongs to", () => {
  const info = ROUTES.find((spec) => spec.aside !== undefined);
  assert.equal(info?.path, "/c/:conversationId/info");
  assert.equal(info?.parent, "/c/:conversationId");
});

test("every section has its root route", () => {
  for (const section of SECTIONS) {
    const root = ROUTES.find((spec) => spec.path === SECTION_ROOTS[section]);
    assert.ok(root, section);
    assert.equal(root.section, section);
    assert.equal(root.detail, undefined);
  }
});

test("only settings replaces its root on a wide screen", () => {
  const replaced = ROUTES.filter((spec) => spec.defaultDetail !== undefined);
  assert.deepEqual(
    replaced.map((spec) => [spec.path, spec.defaultDetail]),
    [["/settings", "/settings/account"]],
  );
});

test("the parents of the table's routes", () => {
  const cases = [
    ["/c/01J9", "/chats"],
    ["/c/01J9/info", "/c/01J9"],
    ["/friends/requests", "/friends"],
    ["/friends/01J8", "/friends"],
    ["/servers/jo/203.0.113.5%3A28070", "/servers"],
    ["/jkhub/ja/1234", "/jkhub"],
    ["/bundles/clan-pack", "/bundles"],
    ["/community/42", "/community"],
    ["/settings/sessions", "/settings"],
    ["/chats", undefined],
    ["/settings", undefined],
  ];
  for (const [path, parent] of cases) {
    const found = findRoute(path);
    assert.ok(found, path);
    assert.equal(parentOf(found.spec, found.params), parent, path);
  }
});

test("a static segment wins over a param", () => {
  assert.equal(findRoute("/friends/requests")?.spec.detail, "requests");
  assert.equal(findRoute("/friends/someone")?.spec.detail, "friendDetails");
});

test("an address in a path is encoded and decoded", () => {
  const path = fillPath("/servers/:game/:address", { game: "ja", address: "203.0.113.5:29070" });
  assert.equal(path, "/servers/ja/203.0.113.5%3A29070");
  assert.deepEqual(matchPath("/servers/:game/:address", path), { game: "ja", address: "203.0.113.5:29070" });
});

test("unknown paths match nothing", () => {
  assert.equal(findRoute("/"), null);
  assert.equal(findRoute("/nowhere"), null);
  assert.equal(findRoute("/c"), null);
});

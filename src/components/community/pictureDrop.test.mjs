/**
 * Tests for dropping a picture on its tile (`pictureDrop.ts`): the position
 * of the launcher's drags in the page's pixels, the tile a drag is over, the
 * claim the core hears, and the checks of a drop that need no bytes.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { boxHolds, createDropRouter, draggedFiles, dropRefusal, pagePoint } from "./pictureDrop.ts";

const MIB = 1024 * 1024;

/** A tile at a fixed box that writes down what it hears. */
function tile(box, shows) {
  const heard = { hovers: [], drops: [] };
  return {
    heard,
    zone: {
      box: () => box,
      shows,
      hover: (files) => heard.hovers.push(files),
      drop: (paths) => heard.drops.push(paths),
    },
  };
}

/** The logo and the cover side by side, as the management screen lays them out at 1280 px. */
const LOGO = { left: 300, top: 400, right: 700, bottom: 500 };
const COVER = { left: 716, top: 400, right: 1116, bottom: 500 };

describe("pagePoint", () => {
  test("divides the physical pixels of the drag by the device pixel ratio", () => {
    assert.deepEqual(pagePoint({ x: 750, y: 600 }, 1.5), { x: 500, y: 400 });
    assert.deepEqual(pagePoint({ x: 500, y: 400 }, 1), { x: 500, y: 400 });
    assert.deepEqual(pagePoint({ x: 1000, y: 802 }, 2), { x: 500, y: 401 });
  });

  test("takes a ratio it cannot use as 1", () => {
    for (const ratio of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(pagePoint({ x: 10, y: 20 }, ratio), { x: 10, y: 20 }, String(ratio));
    }
  });
});

describe("boxHolds", () => {
  test("holds its left and top edges, not its right and bottom ones", () => {
    assert.equal(boxHolds(LOGO, { x: 300, y: 400 }), true);
    assert.equal(boxHolds(LOGO, { x: 699.5, y: 499.5 }), true);
    assert.equal(boxHolds(LOGO, { x: 700, y: 450 }), false);
    assert.equal(boxHolds(LOGO, { x: 500, y: 500 }), false);
    assert.equal(boxHolds(LOGO, { x: 299, y: 450 }), false);
  });

  test("two boxes that touch never both hold a point", () => {
    const left = { left: 0, top: 0, right: 100, bottom: 50 };
    const right = { left: 100, top: 0, right: 200, bottom: 50 };
    const point = { x: 100, y: 25 };
    assert.equal(boxHolds(left, point), false);
    assert.equal(boxHolds(right, point), true);
  });
});

describe("createDropRouter", () => {
  test("a drag over a tile highlights that tile only, and moves with the pointer", () => {
    const claims = [];
    const router = createDropRouter((claimed) => claims.push(claimed));
    const logo = tile(LOGO);
    const cover = tile(COVER);
    router.add(logo.zone);
    router.add(cover.zone);

    router.handle({ type: "enter", paths: ["C:\\Pictures\\logo.png"], point: { x: 100, y: 100 } });
    assert.deepEqual(logo.heard.hovers, [], "the drag came in beside both tiles");
    router.handle({ type: "over", point: { x: 500, y: 450 } });
    assert.deepEqual(logo.heard.hovers, [1]);
    assert.deepEqual(cover.heard.hovers, []);
    router.handle({ type: "over", point: { x: 510, y: 452 } });
    assert.deepEqual(logo.heard.hovers, [1], "a move inside the tile changes nothing");
    router.handle({ type: "over", point: { x: 900, y: 450 } });
    assert.deepEqual(logo.heard.hovers, [1, null]);
    assert.deepEqual(cover.heard.hovers, [1]);
    router.handle({ type: "over", point: { x: 708, y: 450 } });
    assert.deepEqual(cover.heard.hovers, [1, null], "the gap between the tiles is neither's");
    assert.deepEqual(claims, [true, false], "the core hears the claim when it changes, not on every move");
  });

  test("a drop on a tile gives it the paths and ends the drag without a word to the core", () => {
    const claims = [];
    const router = createDropRouter((claimed) => claims.push(claimed));
    const logo = tile(LOGO);
    const cover = tile(COVER);
    router.add(logo.zone);
    router.add(cover.zone);

    const paths = ["C:\\Pictures\\cover.png"];
    router.handle({ type: "enter", paths, point: { x: 900, y: 450 } });
    router.handle({ type: "drop", paths, point: { x: 901, y: 451 } });
    assert.deepEqual(cover.heard.drops, [paths]);
    assert.deepEqual(cover.heard.hovers, [1, null]);
    assert.deepEqual(logo.heard.drops, []);
    assert.deepEqual(claims, [true], "the core ends the claim with the drop itself");

    router.handle({ type: "enter", paths, point: { x: 900, y: 450 } });
    assert.deepEqual(claims, [true, true], "the next drag claims again");
  });

  test("a drop beside every tile and a drag that leaves give nothing", () => {
    const claims = [];
    const router = createDropRouter((claimed) => claims.push(claimed));
    const logo = tile(LOGO);
    router.add(logo.zone);

    router.handle({ type: "enter", paths: ["a.png"], point: { x: 500, y: 450 } });
    router.handle({ type: "leave" });
    assert.deepEqual(logo.heard.hovers, [1, null]);
    router.handle({ type: "drop", paths: ["a.png"], point: { x: 50, y: 50 } });
    assert.deepEqual(logo.heard.drops, []);
    assert.deepEqual(claims, [true]);
  });

  test("a drag that carries several files tells the tile how many", () => {
    const router = createDropRouter();
    const logo = tile(LOGO);
    router.add(logo.zone);
    const paths = ["a.png", "b.png", "c.png"];
    router.handle({ type: "enter", paths, point: { x: 500, y: 450 } });
    router.handle({ type: "drop", paths, point: { x: 500, y: 450 } });
    assert.deepEqual(logo.heard.hovers, [3, null]);
    assert.deepEqual(logo.heard.drops, [paths], "the tile says what is wrong with them");
  });

  test("a tile covered by something laid over it is not under the drag", () => {
    const router = createDropRouter();
    // The chat drawer floats over the right half of the cover.
    const cover = tile(COVER, (point) => point.x < 916);
    router.add(cover.zone);
    router.handle({ type: "enter", paths: ["a.png"], point: { x: 1000, y: 450 } });
    router.handle({ type: "over", point: { x: 1000, y: 450 } });
    assert.deepEqual(cover.heard.hovers, []);
    router.handle({ type: "drop", paths: ["a.png"], point: { x: 1000, y: 450 } });
    assert.deepEqual(cover.heard.drops, [], "the drop is the drawer's");
    router.handle({ type: "enter", paths: ["a.png"], point: { x: 800, y: 450 } });
    router.handle({ type: "drop", paths: ["a.png"], point: { x: 800, y: 450 } });
    assert.deepEqual(cover.heard.drops, [["a.png"]]);
  });

  test("a tile that is not laid out takes nothing", () => {
    const router = createDropRouter();
    const hidden = tile(null);
    router.add(hidden.zone);
    router.handle({ type: "enter", paths: ["a.png"], point: { x: 0, y: 0 } });
    router.handle({ type: "drop", paths: ["a.png"], point: { x: 0, y: 0 } });
    assert.deepEqual(hidden.heard, { hovers: [], drops: [] });
  });

  test("a tile that goes during a drag gives up the claim, and one taken away hears nothing more", () => {
    const claims = [];
    const router = createDropRouter((claimed) => claims.push(claimed));
    const logo = tile(LOGO);
    const remove = router.add(logo.zone);
    router.handle({ type: "enter", paths: ["a.png"], point: { x: 500, y: 450 } });
    remove();
    assert.deepEqual(claims, [true, false]);
    router.handle({ type: "drop", paths: ["a.png"], point: { x: 500, y: 450 } });
    assert.deepEqual(logo.heard.drops, []);
  });

  test("a drag whose start came before the tile hovers nothing, and its drop still lands", () => {
    const router = createDropRouter();
    const logo = tile(LOGO);
    router.add(logo.zone);
    router.handle({ type: "over", point: { x: 500, y: 450 } });
    assert.deepEqual(logo.heard.hovers, []);
    router.handle({ type: "drop", paths: ["a.png"], point: { x: 500, y: 450 } });
    assert.deepEqual(logo.heard.drops, [["a.png"]]);
  });

  test("a drag without files hovers nothing", () => {
    const router = createDropRouter();
    const logo = tile(LOGO);
    router.add(logo.zone);
    router.handle({ type: "enter", paths: [], point: { x: 500, y: 450 } });
    router.handle({ type: "over", point: { x: 500, y: 450 } });
    router.handle({ type: "drop", paths: [], point: { x: 500, y: 450 } });
    assert.deepEqual(logo.heard, { hovers: [], drops: [] });
  });
});

describe("draggedFiles", () => {
  test("counts the files of a drag of the page and ignores text and links", () => {
    const file = { kind: "file" };
    const text = { kind: "string" };
    assert.equal(draggedFiles({ types: ["Files"], items: [file] }), 1);
    assert.equal(draggedFiles({ types: ["Files"], items: [file, file, file] }), 3);
    assert.equal(draggedFiles({ types: ["text/plain", "text/uri-list"], items: [text, text] }), 0);
    assert.equal(draggedFiles({ types: ["Files"], items: null }), 1, "a browser that hides the entries");
    assert.equal(draggedFiles(null), 0);
    assert.equal(draggedFiles(undefined), 0);
  });
});

describe("dropRefusal", () => {
  test("refuses several files at once", () => {
    assert.deepEqual(dropRefusal([{ name: "a.png", size: 10 }, { name: "b.png", size: 10 }], "logo"), { reason: "several" });
    assert.deepEqual(dropRefusal([{ name: "C:\\a.png" }, { name: "C:\\b.png" }], "cover"), { reason: "several" });
  });

  test("refuses a file larger than its kind takes, by name, before reading it", () => {
    assert.deepEqual(dropRefusal([{ name: "logo.png", size: MIB + 1 }], "logo"), {
      reason: "tooBig",
      fileName: "logo.png",
      maxBytes: MIB,
    });
    assert.equal(dropRefusal([{ name: "logo.png", size: MIB }], "logo"), null, "the limit itself fits");
    for (const kind of ["banner", "cover"]) {
      assert.equal(dropRefusal([{ name: "cover.webp", size: MIB + 1 }], kind), null, kind);
      assert.deepEqual(dropRefusal([{ name: "cover.webp", size: 3 * MIB + 1 }], kind), {
        reason: "tooBig",
        fileName: "cover.webp",
        maxBytes: 3 * MIB,
      });
    }
  });

  test("leaves the type to the first bytes, and a size it does not know to the core", () => {
    assert.equal(dropRefusal([{ name: "photo.jfif", size: 2048 }], "banner"), null);
    assert.equal(dropRefusal([{ name: "notes.txt", size: 12 }], "logo"), null, "the bytes refuse it, as for a picked file");
    assert.equal(dropRefusal([{ name: "C:\\Users\\Quinn\\Pictures\\huge.png" }], "logo"), null);
    assert.equal(dropRefusal([], "logo"), null);
  });
});

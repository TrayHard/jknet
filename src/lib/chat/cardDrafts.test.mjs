/**
 * Tests for src/lib/chat/cardDrafts.ts: the cards a window builds and reads.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  bindCard,
  bindLines,
  bundleCard,
  cardDetail,
  cardTitle,
  clampChars,
  configCard,
  demoGame,
  fileExtension,
  fitsConfigCard,
  hostInviteCard,
  isScreenshotName,
  jkhubFileUrl,
  jkhubModCard,
  lineCount,
  mapCard,
  parseCharColor,
  previewLines,
  profileCard,
  readCard,
  serverCard,
  stripColors,
} from "./cardDrafts.ts";

const SERVER = {
  address: "203.0.113.24:29070",
  hostnameRaw: "^1Kyle's ^7duel server",
  hostnameClean: "Kyle's duel server",
  game: "ja",
  map: "mp/ffa3",
  gametype: 3,
  modName: "base",
};

const PROFILE = {
  id: "p1",
  name: "Duel",
  nickname: "^4Kyle ^7Katarn",
  model: "kyle/default",
  saber1: "single_1",
  saber2: "single_3",
  color1: 4,
  color2: 3,
  charColor: { red: 255, green: 128, blue: 0 },
  tokensOverride: null,
};

describe("serverCard", () => {
  test("carries the address, the coloured name, the game, the map and the mode", () => {
    assert.deepEqual(serverCard(SERVER), {
      type: "server",
      v: 1,
      fallbackText: "Server: Kyle's duel server (203.0.113.24:29070)",
      address: "203.0.113.24:29070",
      name: "^1Kyle's ^7duel server",
      game: "ja",
      map: "mp/ffa3",
      gametype: 3,
    });
  });

  test("names the mod unless it is base", () => {
    assert.equal(serverCard({ ...SERVER, modName: "japlus" }).mod, "japlus");
    assert.equal("mod" in serverCard({ ...SERVER, modName: "BASE" }), false);
  });

  test("a server without a name is named by its address", () => {
    const card = serverCard({ ...SERVER, hostnameRaw: "^1^2", hostnameClean: "" });
    assert.equal(card.name, SERVER.address);
    assert.equal(card.fallbackText, `Server: ${SERVER.address} (${SERVER.address})`);
  });

  test("a long name is cut to 64 characters and loses control characters", () => {
    const card = serverCard({ ...SERVER, hostnameRaw: `‮${"x".repeat(80)}\u0007` });
    assert.equal(card.name, "x".repeat(64));
  });
});

describe("hostInviteCard", () => {
  test("carries the session and the name only, never an address or a password", () => {
    const card = hostInviteCard("9C41D27A0B3E5F18", "Jan's game");
    assert.deepEqual(card, {
      type: "hostInvite",
      v: 1,
      fallbackText: "Join my server: Jan's game",
      sessionId: "9c41d27a0b3e5f18",
      name: "Jan's game",
    });
    for (const field of ["hostId", "game", "map", "gametype", "mod", "password", "address", "relayAddress", "lanAddresses"]) {
      assert.equal(field in card, false, field);
    }
  });

  test("without a name the fallback says so and the field stays out", () => {
    const card = hostInviteCard("9c41d27a0b3e5f18", "  ");
    assert.equal(card.fallbackText, "Join my private server");
    assert.equal("name" in card, false);
  });
});

describe("bundle, JKHub, map and config cards", () => {
  test("bundleCard", () => {
    assert.deepEqual(bundleCard({ id: "01K5BUNDLE00000000000000AB", slug: "duel-pack", name: "Duel Pack", game: "ja" }), {
      type: "bundle",
      v: 1,
      fallbackText: "Bundle: Duel Pack",
      bundleId: "01K5BUNDLE00000000000000AB",
      slug: "duel-pack",
      name: "Duel Pack",
      game: "ja",
    });
  });

  test("jkhubModCard takes the game of the player for a file of both games", () => {
    const card = jkhubModCard({ id: 4391, slug: "legends-hilt-pack", title: "Legends hilt pack", game: "both" }, "jo");
    assert.equal(card.game, "jo");
    assert.equal(card.fileId, 4391);
    assert.equal(card.fallbackText, "JKHub: Legends hilt pack");
    assert.equal(jkhubModCard({ id: 1, slug: "a", title: "A", game: "ja" }, "jo").game, "ja");
  });

  test("mapCard with and without a title", () => {
    assert.deepEqual(mapCard({ name: "mp/duel5", title: "Duel Temple" }, "ja"), {
      type: "map",
      v: 1,
      fallbackText: "Map: Duel Temple (mp/duel5)",
      game: "ja",
      name: "mp/duel5",
      title: "Duel Temple",
    });
    const plain = mapCard({ name: "mp/ffa3", title: null }, "ja");
    assert.equal(plain.fallbackText, "Map: mp/ffa3");
    assert.equal("title" in plain, false);
  });

  test("configCard trims the text and names a nameless config", () => {
    const card = configCard({ name: "", text: "\nseta cg_fov 100\n" });
    assert.equal(card.name, "config.cfg");
    assert.equal(card.text, "seta cg_fov 100");
    assert.equal(card.fallbackText, "Config: config.cfg");
  });

  test("fitsConfigCard measures UTF-8 bytes", () => {
    assert.equal(fitsConfigCard("a".repeat(32 * 1024)), true);
    assert.equal(fitsConfigCard("a".repeat(32 * 1024 + 1)), false);
    assert.equal(fitsConfigCard("ж".repeat(16 * 1024 + 1)), false);
  });
});

describe("profileCard", () => {
  test("writes the values as the cvars take them", () => {
    assert.deepEqual(profileCard(PROFILE), {
      type: "profile",
      v: 1,
      fallbackText: "Player profile: Kyle Katarn",
      nickname: "^4Kyle ^7Katarn",
      model: "kyle/default",
      saber1: "single_1",
      saber2: "single_3",
      color1: "4",
      color2: "3",
      charColor: "255 128 0",
    });
  });

  test("fills the engine's defaults where the profile leaves them", () => {
    const card = profileCard({ ...PROFILE, saber1: null, saber2: "none", color1: null, color2: null, charColor: null });
    assert.equal(card.saber1, "Kyle");
    assert.equal(card.color1, "4");
    assert.equal("saber2" in card, false);
    assert.equal("color2" in card, false);
    assert.equal("charColor" in card, false);
  });

  test("a profile without a nickname or a model makes no card", () => {
    assert.equal(profileCard({ ...PROFILE, nickname: "^1" }), null);
    assert.equal(profileCard({ ...PROFILE, model: null }), null);
  });
});

describe("bindCard and bindLines", () => {
  test("keys go upper case and the fallback names the bind", () => {
    const card = bindCard([{ key: "f", command: "vstr e1" }]);
    assert.deepEqual(card.binds, [{ key: "F", command: "vstr e1" }]);
    assert.equal(card.fallbackText, "Bind F: vstr e1");
  });

  test("several binds list their keys; an empty command unbinds", () => {
    assert.equal(
      bindCard([{ key: "F1", command: "say gg" }, { key: "F2", command: "" }]).fallbackText,
      "2 key binds: F1, F2",
    );
    assert.equal(bindCard([{ key: "F2", command: "" }]).fallbackText, "Unbind F2");
  });

  test("at most 50 binds", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `K${i}`, command: "say hi" }));
    assert.equal(bindCard(many).binds.length, 50);
  });

  test("bindLines writes quoted lines and drops quotes inside commands", () => {
    assert.equal(
      bindLines([
        { key: "f", command: 'say "hi"' },
        { key: "MOUSE2", command: "" },
      ]),
      'bind "F" "say hi"\nunbind "MOUSE2"',
    );
  });
});

describe("readCard", () => {
  test("reads what the builders write", () => {
    for (const card of [
      serverCard(SERVER),
      hostInviteCard("9c41d27a0b3e5f18", "Jan's game"),
      bundleCard({ id: "01K5BUNDLE00000000000000AB", slug: "duel-pack", name: "Duel Pack", game: "ja" }),
      jkhubModCard({ id: 4391, slug: "legends", title: "Legends", game: "ja" }, "ja"),
      mapCard({ name: "mp/duel5", title: "Duel Temple" }, "ja"),
      profileCard(PROFILE),
      bindCard([{ key: "F", command: "vstr e1" }]),
      configCard({ name: "duel.cfg", text: "seta cg_fov 100" }),
    ]) {
      const parsed = readCard(card);
      assert.notEqual(parsed, null, card.type);
      assert.equal(parsed.type, card.type);
    }
  });

  test("an unknown type, another version or a missing field reads as null", () => {
    assert.equal(readCard({ type: "poll", v: 1, fallbackText: "Vote" }), null);
    assert.equal(readCard({ ...serverCard(SERVER), v: 2 }), null);
    assert.equal(readCard({ type: "server", v: 1, fallbackText: "x", name: "x", game: "ja" }), null);
    assert.equal(readCard({ type: "map", v: 1, fallbackText: "x", name: "mp/ffa3", game: "q3" }), null);
    assert.equal(readCard({ type: "bind", v: 1, fallbackText: "x", binds: [] }), null);
    assert.equal(readCard({ type: "jkhubMod", v: 1, fallbackText: "x", fileId: -3, game: "ja" }), null);
  });

  test("fields of the wrong shape read as absent", () => {
    const parsed = readCard({ type: "server", v: 1, fallbackText: "x", address: "203.0.113.1:29070", game: "jo", gametype: "3", map: 7 });
    assert.equal(parsed.fields.gametype, null);
    assert.equal(parsed.fields.map, null);
    assert.equal(parsed.fields.name, "203.0.113.1:29070");
  });

  test("a hostInvite from the service carries what the service filled in", () => {
    const parsed = readCard({
      type: "hostInvite",
      v: 1,
      fallbackText: "Join my server: Jan's game",
      sessionId: "9c41d27a0b3e5f18",
      name: "Jan's game",
      hostId: "01K5JAN0000000000000000000",
      game: "ja",
      map: "mp/duel5",
      gametype: 3,
    });
    assert.equal(parsed.fields.hostId, "01K5JAN0000000000000000000");
    assert.equal(parsed.fields.map, "mp/duel5");
  });

  test("binds without a key are skipped", () => {
    const parsed = readCard({ type: "bind", v: 1, fallbackText: "x", binds: [{ key: "", command: "quit" }, { key: "F", command: 3 }, "x"] });
    assert.deepEqual(parsed.fields.binds, [{ key: "F", command: "" }]);
  });
});

describe("titles and details", () => {
  test("the title drops colour codes; the detail tells cards apart", () => {
    const server = readCard(serverCard(SERVER));
    assert.equal(cardTitle(server), "Kyle's duel server");
    assert.equal(cardDetail(server), SERVER.address);
    const map = readCard(mapCard({ name: "mp/duel5", title: "Duel Temple" }, "ja"));
    assert.equal(cardTitle(map), "Duel Temple");
    assert.equal(cardDetail(map), "mp/duel5");
    const binds = readCard(bindCard([{ key: "F1", command: "say gg" }, { key: "F2", command: "kill" }]));
    assert.equal(cardTitle(binds), "F1, F2");
    assert.equal(cardDetail(binds), null);
  });
});

describe("text helpers", () => {
  test("stripColors follows Q_IsColorString", () => {
    assert.equal(stripColors("^1Red^7 and ^^x"), "Red and ^^x");
  });

  test("clampChars never cuts a surrogate pair", () => {
    assert.equal(clampChars("⚔️🏆abc", 2), "⚔️");
    assert.equal(clampChars("🏆🏆🏆", 2), "🏆🏆");
  });

  test("lineCount and previewLines", () => {
    assert.equal(lineCount(""), 0);
    assert.equal(lineCount("a\r\nb\rc\nd"), 4);
    assert.deepEqual(previewLines("\n  \nseta a 1\n\nseta b 2  \nseta c 3", 2), ["seta a 1", "seta b 2"]);
  });

  test("parseCharColor", () => {
    assert.deepEqual(parseCharColor("255 128 0"), { red: 255, green: 128, blue: 0 });
    assert.deepEqual(parseCharColor("1,2,3"), { red: 1, green: 2, blue: 3 });
    assert.equal(parseCharColor("256 0 0"), null);
    assert.equal(parseCharColor("1 2"), null);
    assert.equal(parseCharColor(null), null);
  });
});

describe("files", () => {
  test("fileExtension", () => {
    assert.equal(fileExtension("shot0117.JPG"), "jpg");
    assert.equal(fileExtension("demos/duel.dm_26"), "dm_26");
    assert.equal(fileExtension(".hidden"), "");
    assert.equal(fileExtension("name."), "");
    assert.equal(fileExtension("setup.exe.png"), "png");
  });

  test("demoGame by extension", () => {
    assert.equal(demoGame("duel.dm_26"), "ja");
    assert.equal(demoGame("duel.dm_25"), "ja");
    assert.equal(demoGame("duel.DM_15"), "jo");
    assert.equal(demoGame("duel.dm_16"), "jo");
    assert.equal(demoGame("duel.zip"), null);
  });

  test("isScreenshotName", () => {
    assert.equal(isScreenshotName("shot.png"), true);
    assert.equal(isScreenshotName("shot.jpeg"), true);
    assert.equal(isScreenshotName("shot.tga"), false);
  });

  test("jkhubFileUrl", () => {
    assert.equal(jkhubFileUrl(4391, "legends-hilt-pack"), "https://jkhub.org/files/file/4391-legends-hilt-pack/");
    assert.equal(jkhubFileUrl(4391, ""), "https://jkhub.org/files/file/4391/");
    assert.equal(jkhubFileUrl(1, "a b/c"), "https://jkhub.org/files/file/1-a%20b%2Fc/");
  });
});

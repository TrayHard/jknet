import assert from "node:assert/strict";
import test from "node:test";
import { MOD_CATALOG, serverConfigFieldSections, serverConfigFields } from "./serverConfigCatalog.ts";

const EXPECTED_MOD_IDS = ["base", "japlus", "japro", "mbii", "lugormod", "makermod"];

test("server configuration catalog has valid unique field schemas", () => {
  assert.deepEqual(MOD_CATALOG.map((mod) => mod.id), EXPECTED_MOD_IDS);
  assert.equal(new Set(MOD_CATALOG.map((mod) => mod.id)).size, MOD_CATALOG.length);

  for (const mod of MOD_CATALOG) {
    assert.ok(mod.name);
    assert.ok(mod.games.length);
    assert.equal(new Set(mod.games).size, mod.games.length);
    assert.equal(new Set(mod.modFolders.map((folder) => folder.toLowerCase())).size, mod.modFolders.length);
    assert.equal(new Set(mod.fields.map((field) => field.name)).size, mod.fields.length, mod.id);

    for (const field of mod.fields) {
      assert.match(field.name, /^\w+$/);
      assert.ok(field.label);
      assert.ok(field.group);
      assert.ok(["number", "boolean", "select", "flags", "text"].includes(field.type));
      if (field.defaultValue !== undefined) assert.equal(typeof field.defaultValue, "string");
      if (field.min !== undefined && field.max !== undefined) assert.ok(field.min <= field.max, field.name);
      if (field.type === "select") {
        assert.ok(field.options?.length, field.name);
        assert.equal(new Set(field.options.map((option) => option.value)).size, field.options.length, field.name);
        if (field.defaultValue !== undefined) {
          assert.ok(field.options.some((option) => option.value === field.defaultValue), field.name);
        }
      }
      if (field.type === "flags") {
        assert.ok(field.flags?.length, field.name);
        assert.ok(field.flags.every((flag) => Number.isSafeInteger(flag.value) && flag.value > 0 && (flag.value & (flag.value - 1)) === 0), field.name);
        assert.equal(new Set(field.flags.map((flag) => flag.value)).size, field.flags.length, field.name);
        if (field.defaultValue !== undefined) {
          const value = Number(field.defaultValue);
          assert.ok(Number.isSafeInteger(value) && value >= 0, field.name);
          const validBits = field.flags.reduce((bits, flag) => bits | flag.value, 0);
          assert.equal(value & ~validBits, 0, field.name);
        }
      }
    }
  }
});

test("base fields follow the selected game's private-host modes", () => {
  const ja = serverConfigFields("ja", "base");
  const jo = serverConfigFields("jo", "base");

  assert.deepEqual(ja.find((field) => field.name === "g_gametype")?.options?.map((option) => option.value), ["0", "1", "2", "3", "4", "6", "7", "8", "9"]);
  assert.deepEqual(jo.find((field) => field.name === "g_gametype")?.options?.map((option) => option.value), ["0", "1", "2", "3", "5", "7", "8"]);
  assert.ok(jo.some((field) => field.name === "map"));
  assert.ok(jo.some((field) => field.name === "duel_fraglimit"));
  assert.ok(jo.some((field) => field.name === "bot_minplayers"));
  assert.ok(!jo.some((field) => field.name === "g_forcePowerDisable"));
});

test("Movie Battles replaces incompatible base controls", () => {
  const fields = serverConfigFields("ja", "mbii");
  const names = fields.map((field) => field.name);

  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(fields.find((field) => field.name === "g_gametype")?.options?.map((option) => option.value), ["7", "3", "4"]);
  assert.ok(fields.some((field) => field.name === "fraglimit"));
  assert.ok(!fields.some((field) => field.name === "duel_fraglimit"));
  assert.ok(!fields.some((field) => field.name === "capturelimit"));
  assert.ok(!fields.some((field) => field.name === "bot_minplayers"));
});

test("common and mod controls stay in separate sections", () => {
  const maker = serverConfigFieldSections("ja", "makermod");
  assert.ok(maker.common.some((field) => field.name === "map"));
  assert.ok(!maker.common.some((field) => field.name === "g_allowMapVote"));
  assert.ok(maker.mod.some((field) => field.name === "g_allowMapVote"));
  assert.ok(!maker.mod.some((field) => field.name === "map"));

  const base = serverConfigFieldSections("ja", "base");
  assert.ok(base.common.length > 0);
  assert.deepEqual(base.mod, []);

  const mbii = serverConfigFieldSections("ja", "mbii");
  for (const name of ["g_gametype", "fraglimit"]) {
    assert.ok(!mbii.common.some((field) => field.name === name));
    assert.equal(mbii.mod.filter((field) => field.name === name).length, 1);
  }
  assert.equal(new Set([...mbii.common, ...mbii.mod].map((field) => field.name)).size, mbii.common.length + mbii.mod.length);
});

import assert from "node:assert/strict";
import test from "node:test";
import { hostConfigCompatible, hostConfigText, hostModId } from "./hostConfig.ts";

const client = { id: "local", engineId: "openjk", name: "Practice", canHost: true, reason: null };
const doc = { id: "rules", name: "Practice", game: "ja", modId: "base", text: "" };
const settings = {
  clientId: "local", map: "mp/duel1", gametype: 3, maxPlayers: 5, timeLimit: 13,
  scoreLimit: 7, bots: 1, serverName: "Practice", password: "private-token", network: "internet",
  joinPolicy: "friends", joinUserIds: ["private-account"], inviteUserIds: [], joinAfterStart: false,
  chatFromWeb: true,
};

test("a config matches the client's actual mod without guessing unknown folders", () => {
  assert.equal(hostConfigCompatible(doc, client), true);
  assert.equal(hostConfigCompatible({ ...doc, modId: "mbii" }, { ...client, modFolder: "MBII" }), true);
  assert.equal(hostConfigCompatible(doc, { ...client, modFolder: "MBII" }), false);
  assert.equal(hostConfigCompatible({ ...doc, modId: "japro" }, { ...client, modFolder: "japlus" }), false);
  assert.equal(hostConfigCompatible(doc, undefined), false);
  assert.equal(hostModId({ ...client, modFolder: "custom-unknown" }), null);
});

test("saving match settings excludes connection credentials and retains advanced rules", () => {
  const prior = "// Authored rules\r\nset g_gravity 450\r\n";
  const saved = hostConfigText(settings, "duel_fraglimit", prior);
  assert.ok(saved.startsWith(prior.trimEnd()));
  assert.match(saved, /set duel_fraglimit "7"/);
  assert.match(saved, /set sv_maxclients "5"/);
  assert.match(saved, /map mp\/duel1/);
  for (const value of ["private-token", "private-account", "password", "network", "rcon", "internet"]) {
    assert.ok(!saved.includes(value), value);
  }
});

test("score cvar comes from the game's host schema, including JO CTF and MBII", () => {
  assert.match(hostConfigText({ ...settings, gametype: 7 }, "capturelimit"), /set capturelimit "7"/);
  assert.match(hostConfigText({ ...settings, gametype: 7 }, "fraglimit"), /set fraglimit "7"/);
  assert.ok(!hostConfigText({ ...settings, gametype: 7 }, null).includes("limit \"7\""));
});

test("a typed name or map cannot turn a saved match into extra cfg commands", () => {
  const saved = hostConfigText({ ...settings, serverName: 'A"\nquit; B', map: "mp/duel1;quit" }, "fraglimit");
  assert.ok(!saved.includes("\nquit"));
  assert.ok(!saved.includes(";"));
  assert.ok(!saved.includes("\nmap "));
});

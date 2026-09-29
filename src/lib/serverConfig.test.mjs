import test from "node:test";
import assert from "node:assert/strict";
import { decodeServerConfigBytes, detectServerConfigMod, hasServerConfigHeader, parseServerConfigEnvelope, removeServerConfigSensitive, serverConfigEnvelope, serverConfigValues, setServerConfigValue, removeServerConfigValue, serverConfigSensitiveKeys, serverConfigFilename, serverConfigDropProblem, serverConfigImportName } from "./serverConfig.ts";

test("cfg bytes recognize Unicode and legacy Windows encodings", () => {
  const bytes = values => new Uint8Array(values);
  assert.equal(decodeServerConfigBytes(new TextEncoder().encode("// Привет\nset g_speed 250\n")), "// Привет\nset g_speed 250\n");
  assert.equal(decodeServerConfigBytes(bytes([0x2f, 0x2f, 0x20, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a])), "// Привет\n");
  assert.equal(decodeServerConfigBytes(bytes([0x2f, 0x2f, 0x20, 0x53, 0x63, 0x68, 0xf6, 0x6e, 0x65, 0x20, 0x47, 0x72, 0xfc, 0xdf, 0x65, 0x0a])), "// Schöne Grüße\n");
  assert.equal(decodeServerConfigBytes(bytes([0xff, 0xfe, 0x2f, 0x00, 0x2f, 0x00, 0x20, 0x00, 0x55, 0x00, 0x54, 0x00, 0x46, 0x00, 0x0a, 0x00])), "// UTF\n");
  assert.throws(() => decodeServerConfigBytes(bytes([0, 1, 2])));
});

test("a cfg drop accepts exactly one cfg on Windows or the web", () => {
  assert.equal(serverConfigDropProblem([String.raw`C:\Games\duel.CFG`]), null);
  assert.equal(serverConfigDropProblem(["/home/player/movie.cfg"]), null);
  assert.equal(serverConfigDropProblem([]), "oneCfg");
  assert.equal(serverConfigDropProblem(["one.cfg", "two.cfg"]), "oneCfg");
  assert.equal(serverConfigDropProblem(["rules.txt"]), "oneCfg");
  assert.equal(serverConfigDropProblem([".cfg"]), "oneCfg");
  assert.equal(serverConfigImportName(String.raw`C:\Configs\Weekend.CFG`), "Weekend");
  assert.equal(serverConfigImportName("/tmp/base.cfg"), "base");
});

test("plain cfg import detects unambiguous mod signatures", () => {
  assert.equal(detectServerConfigMod("mremap textures/a textures/b\nmweather fog", "ja"), "makermod");
  assert.equal(detectServerConfigMod("// mremap ignored\nset g_gravity 600", "ja"), "base");
  assert.equal(detectServerConfigMod("set fs_game MBII", "ja"), "mbii");
  assert.equal(detectServerConfigMod("set fs_game makermod", "jo"), "base");
});

test("server cfg context travels as a comment without changing the body", () => {
  const doc = { name: "Friends", game: "ja", modId: "japlus", text: '// comment\r\nset g_gametype "0"\r\n' };
  assert.deepEqual(parseServerConfigEnvelope(serverConfigEnvelope(doc)), doc);
  assert.deepEqual(parseServerConfigEnvelope("\uFEFF" + serverConfigEnvelope(doc)), doc);
  assert.equal(parseServerConfigEnvelope(doc.text), null);
  assert.equal(parseServerConfigEnvelope(serverConfigEnvelope({ ...doc, game: "jo" })), null);
  assert.equal(parseServerConfigEnvelope(serverConfigEnvelope({ ...doc, modId: "unknown" })), null);
  assert.equal(parseServerConfigEnvelope('// JKNet server config: {"v":2,"game":"ja","modId":"base","name":"Test"}\n'), null);
  assert.equal(parseServerConfigEnvelope('// JKNet server config: null'), null);
  assert.equal(parseServerConfigEnvelope(serverConfigEnvelope({ ...doc, name: "\n" })), null);
});

test("a malformed envelope with a BOM is rejected rather than treated as plain cfg", () => {
  for (const text of ['\uFEFF// JKNet server config: {broken}\nset g_speed 300', '\uFEFF// JKNet server config:{"v":1}\n', '\uFEFF// JKNet server config: {"v":2,"game":"ja","modId":"base","name":"Test"}\n']) {
    assert.equal(hasServerConfigHeader(text), true);
    assert.equal(parseServerConfigEnvelope(text), null);
  }
  assert.equal(hasServerConfigHeader('\uFEFF// ordinary cfg\nset g_speed 300'), false);
});

test("field edit keeps comments, unknown commands, CRLF and previous assignments intact", () => {
  const text = '// settings\r\nset g_speed "250" // initial\r\nset custom_setting "a;b"; set g_speed "300" // effective\r\nmap "mp/ffa3"';
  const changed = setServerConfigValue(text, "g_speed", "320");
  assert.equal(changed, text.replace('g_speed "300"', 'g_speed "320"'));
  assert.equal(serverConfigValues(changed).get("g_speed"), "320");
  assert.equal(serverConfigValues(changed).get("custom_setting"), "a;b");
  assert.equal(setServerConfigValue(text, "timelimit", "15"), text + '\r\nset timelimit "15"\r\n');
  assert.equal(setServerConfigValue('', 'map', 'mp/ffa3'), 'map "mp/ffa3"\n');
  assert.throws(() => setServerConfigValue(text, "g_speed", '2";quit'));
});

test("quoted names and case share one effective assignment; reset retains comments", () => {
  const text = 'seta "G_SPEED" "200" // user comment\nG_speed 300; echo "keep"\n';
  assert.equal(serverConfigValues(text).get("g_speed"), "300");
  assert.equal(setServerConfigValue(text, "g_speed", "350"), text.replace("G_speed 300", 'G_speed "350"'));
  assert.equal(removeServerConfigValue(text, "g_speed"), ' // user comment\n; echo "keep"\n');
});

test("secrets cannot be shared through case, quoted keys, compound or malformed assignments", () => {
  for (const text of ['set rconPassword "hidden"', 'seta "G_PASSWORD" "hidden"', 'set x 1; admin_token hidden', 'set adminSecret "unterminated', 'rcon password status', 'set x "set rconPassword hunter"']) {
    assert.ok(serverConfigSensitiveKeys(text).length > 0, text);
  }
  assert.deepEqual(serverConfigSensitiveKeys('// rconPassword "example"\nset g_password ""\nset g_speed 250'), []);
  assert.equal(serverConfigFilename('../duel:best.cfg'), '.._duel_best.cfg');
});

test("detected secrets can be removed before sharing without touching other rules", () => {
  const text = '// access\nset rconPassword "hidden"; set g_speed 250\nset x "set admin_token hunter"\n/* keep */ set sv_hostname "Friends"\n';
  const cleaned = removeServerConfigSensitive(text);
  assert.deepEqual(serverConfigSensitiveKeys(cleaned), []);
  assert.match(cleaned, /\/\/ access/);
  assert.match(cleaned, /set g_speed 250/);
  assert.match(cleaned, /\/\* keep \*\/ set sv_hostname/);
});

test("block comments never contribute assignments or secrets", () => {
  const text = '/* set g_gravity 200\nset rconPassword hidden */\nset g_gravity 800 // actual\n';
  assert.equal(serverConfigValues(text).get("g_gravity"), "800");
  assert.equal(setServerConfigValue(text, "g_gravity", "600"), text.replace('g_gravity 800', 'g_gravity "600"'));
  assert.deepEqual(serverConfigSensitiveKeys(text), []);
  assert.equal(removeServerConfigValue(text, "g_gravity"), '/* set g_gravity 200\nset rconPassword hidden */\n // actual\n');
});

test("edits preserve UTF-16 offsets and inline block comments", () => {
  const text = '// 🙂\n/* shared rule */ set g_speed 250; set custom "🙂"\n';
  assert.equal(setServerConfigValue(text, "g_speed", "300"), text.replace("g_speed 250", 'g_speed "300"'));
  assert.equal(removeServerConfigValue(text, "g_speed"), '// 🙂\n/* shared rule */; set custom "🙂"\n');
});

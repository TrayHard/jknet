/**
 * The danger scan of config and bind cards: the cases of the launcher's
 * `src-tauri/src/chat/cards.rs` tests, answered the same way.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { scanCommands, scanCommandsCommand, splitCommands, tokenize, SCAN_BYTES_MAX } from "./scan.ts";

const reasons = (text) => scanCommands(text).map((danger) => [danger.line, danger.reason]);

test("every listed command is named", () => {
  const text = [
    "quit",
    "exec autoexec.cfg",
    "writeconfig mine",
    "rcon status",
    "connect 203.0.113.5",
    "reconnect",
    "unbindall",
    "seta cl_allowDownload 1",
    "set fs_game evil",
    "sv_cheats 1",
    "seta rconPassword secret",
    "execq other",
    "/quit",
    "",
  ].join("\n");
  assert.deepEqual(reasons(text), [
    [1, "quit"],
    [2, "exec"],
    [3, "write_config"],
    [4, "rcon"],
    [5, "connect"],
    [6, "reconnect"],
    [7, "unbind_all"],
    [8, "allow_download"],
    [9, "filesystem"],
    [10, "server_cvar"],
    [11, "rcon"],
    [12, "exec"],
    [13, "quit"],
  ]);
});

test("ordinary configs are quiet", () => {
  const text = [
    "// my duel config",
    'seta name "^1Kyle"',
    "bind MOUSE1 +attack",
    'bind F1 "say gg; wait; say quit is not a command here"',
    'set duel "say duel?"',
    "bind F2 vstr duel",
    "echo quit",
    "fs_game",
    "cg_fov 110 // quit in a comment",
    "/* exec in a",
    " block comment */",
    "",
  ].join("\n");
  assert.deepEqual(scanCommands(text), []);
});

test("what a key runs is named on its bind line", () => {
  assert.deepEqual(scanCommands('bind x "say bye; quit"\nbind y "bind z exec evil"\n'), [
    { line: 1, command: "quit", reason: "quit", via: ["bind X"] },
    { line: 2, command: "bind z exec evil", reason: "nested_bind", via: ["bind Y"] },
    { line: 2, command: "exec evil", reason: "exec", via: ["bind Y", "bind Z"] },
  ]);
});

test("a binding is cut at every semicolon, even in quotes", () => {
  assert.deepEqual(scanCommands('bind x "say a;quit"\n'), [{ line: 1, command: "quit", reason: "quit", via: ["bind X"] }]);
});

test("vstr chains are followed, a value set later counts too", () => {
  const text = 'set a "say hi; vstr b"\nset b "vstr c"\nset c "seta fs_game evil"\nbind x vstr a\n';
  assert.deepEqual(scanCommands(text), [
    { line: 4, command: "seta fs_game evil", reason: "filesystem", via: ["bind X", "vstr a", "vstr b", "vstr c"] },
  ]);
  assert.deepEqual(reasons("vstr later\nset later quit\n"), [[1, "quit"]]);
});

test("a toggle is dangerous when any of its steps is", () => {
  const text = [
    'set t1 "say on; set t vstr t2"',
    'set t2 "say off; set t vstr t3"',
    'set t3 "connect 203.0.113.9; set t vstr t1"',
    "set t vstr t1",
    "bind v vstr t",
    "",
  ].join("\n");
  const found = reasons(text);
  assert.ok(found.some(([line, reason]) => line === 5 && reason === "connect"), JSON.stringify(found));
  assert.ok(found.every(([line]) => line === 4 || line === 5), JSON.stringify(found));
});

test("a bind inside a variable is a nested bind", () => {
  const found = scanCommands('set menu "bind 1 say one; bind 2 unbindall"\nbind m vstr menu\n').map((danger) => [
    danger.line,
    danger.reason,
    danger.command,
  ]);
  assert.deepEqual(found, [
    [2, "nested_bind", "bind 1 say one"],
    [2, "nested_bind", "bind 2 unbindall"],
    [2, "unbind_all", "unbindall"],
  ]);
});

test("loops end, and chains too deep say the scan stopped", () => {
  assert.deepEqual(scanCommands('set loop "say x; vstr loop"\nvstr loop\n'), []);
  let text = "";
  for (let index = 0; index < 20; index += 1) text += `set v${index} "vstr v${index + 1}"\n`;
  text += "set v20 quit\nvstr v0\n";
  assert.ok(scanCommands(text).some((danger) => danger.reason === "too_complex" && danger.line === 1));
});

test("a huge text stops with a note", () => {
  const found = scanCommands('bind x "say a; say b; say c; say d"\n'.repeat(60_000));
  assert.equal(found.at(-1)?.reason, "too_complex");
});

test("lines count like the editor, two commands on a line are named on it", () => {
  assert.deepEqual(reasons("say a\r\nsay b\rquit\n\nconnect x"), [
    [3, "quit"],
    [5, "connect"],
  ]);
  assert.deepEqual(reasons("say hi; quit; exec x\n"), [
    [1, "quit"],
    [1, "exec"],
  ]);
});

test("the tokenizer and the splitter follow the engine", () => {
  assert.deepEqual(tokenize('bind x "say hi"'), ["bind", "x", "say hi"]);
  assert.deepEqual(tokenize("  say  hi // quit"), ["say", "hi"]);
  assert.deepEqual(tokenize("say /* quit */ hi"), ["say", "hi"]);
  assert.deepEqual(tokenize('say "open'), ["say", "open"]);
  assert.deepEqual(tokenize('a"b"'), ["a", "b"]);
  assert.deepEqual(tokenize("сказать привет"), ["сказать", "привет"]);
  const text = 'a; b // c; d\n"e; f"; g /* h\n i */ j';
  assert.deepEqual(
    splitCommands(text).map((span) => text.slice(span.start, span.end)),
    ["a", "b", '"e; f"', "g", "j"],
  );
});

test("the answer has the launcher's shape, and an oversized text is refused", () => {
  assert.deepEqual(scanCommandsCommand("bind x writeconfig a\n"), [
    { line: 1, command: "writeconfig a", reason: "write_config", via: ["bind X"] },
  ]);
  assert.throws(() => scanCommandsCommand("x".repeat(SCAN_BYTES_MAX + 1)), (error) => error.code === "invalidInput");
});

test("the config card the review names is flagged on the web too", () => {
  const lines = ["seta cg_fov 100", "seta r_gamma 1.2", "seta cg_draw2d 1", "seta cg_drawfps 1"];
  for (let index = 0; index < 85; index += 1) lines.push(`seta cg_x${index} ${index}`);
  lines.push('bind x "say hi; quit"');
  assert.deepEqual(reasons(lines.join("\n")), [[90, "quit"]]);
});

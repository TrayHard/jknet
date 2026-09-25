/**
 * Tests for src/lib/vstrChain.ts: parsing, the press sandbox, bind systems,
 * diagnostics and every edit, each edit checked by simulating the new text.
 *
 * Node strips the TypeScript types itself (Node 22.18 and later), so the
 * module runs without a build step and without a test framework.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CHAIN_TEMPLATES } from "./chainTemplates.ts";
import {
  ChainEditError,
  addBranch,
  bindingOf,
  chainSystems,
  changeKey,
  createMenu,
  createToggle,
  cycleEditable,
  exploreChain,
  insertCycleStep,
  keyCycle,
  keyInfo,
  loadChainState,
  overrideBinding,
  overrideVariable,
  pressKey,
  removeBranch,
  removeCycleStep,
  reorderCycle,
  replayPresses,
  setStepCommands,
  splitBinding,
  splitCommands,
  systemOf,
  tokenizeCommand,
  variableInfo,
  variableOf,
  withStartBinding,
} from "./vstrChain.ts";

const edited = (text, source = "Draft") => ({ text, source, kind: "edited" });
const inherited = (text, source = "client.cfg") => ({ text, source, kind: "inherited" });
const layer = (text, source = "Layer") => ({ text, source, kind: "layer" });

/** Sources with the edited one replaced by `text`, as the editor passes them after an edit. */
const withText = (sources, text) => sources.map((source) => (source.kind === "edited" ? { ...source, text } : source));

const bodyName = (step) => (step.body?.kind === "variable" ? step.body.name : step.body?.kind ?? null);
const cycleBodies = (sources, key) => keyCycle(loadChainState(sources), key).steps.map(bodyName);
const texts = (commands) => commands.map((command) => command.text);

/**
 * Two toggles in the idiom of the RUJKA Edition configs, written for these
 * tests: each variable does its work and rebinds its own key to the other one.
 */
const REBIND_TOGGLES = [
  'bind HOME "vstr gun_hide"',
  'set gun_hide "seta cg_drawTimer 1;set cg_drawGun 0;echo ^1Gun hidden;bind HOME vstr gun_show"',
  'set gun_show "set cg_drawGun 1;echo ^2Gun shown;bind HOME vstr gun_hide"',
  'bind END "vstr hud_off"',
  'set hud_off "seta cg_drawTimer 1;set cg_draw2D 0;echo ^1HUD off;bind END vstr hud_on"',
  'set hud_on "set cg_draw2D 1;echo ^2HUD on;bind END vstr hud_off"',
  "",
].join("\n");

/** Weapon binds the menu borrows, as a client's own config holds them. */
const CLIENT = 'bind 1 "weapon 1"\nbind 2 "weapon 2"\nbind 3 "weapon 3"\nbind 4 "weapon 4"\nbind 5 "weapon 5"\nbind 6 "weapon 6"\n';

/** F5 opens a menu over 1–4; 3 opens a submenu over 1–3; its third item is missing. */
const MENU = [
  "// Weapon menu",
  'bind F5 "vstr menu_open"',
  'set menu_open "echo Menu: 1 heal 2 protect 3 taunts 4 close; bind 1 vstr menu_heal; bind 2 vstr menu_protect; bind 3 vstr sub_open; bind 4 vstr menu_close; bind F5 vstr menu_close"',
  'set menu_close "bind 1 weapon 1; bind 2 weapon 2; bind 3 weapon 3; bind 4 weapon 4; bind F5 vstr menu_open"',
  'set menu_heal "force_heal; vstr menu_close"',
  'set menu_protect "force_protect; vstr menu_close"',
  'set sub_open "echo Taunts: 1 bow 2 meditate 3 flourish; bind 1 vstr sub_bow; bind 2 vstr sub_meditate; bind 3 vstr sub_flourish"',
  'set sub_bow "bow; vstr menu_close"',
  'set sub_meditate "meditate; vstr menu_close"',
  "",
].join("\n");

const menuSources = () => [inherited(CLIENT), edited(MENU, "Weapon menu")];

function pressOf(node, key) {
  const found = node.presses.find((press) => press.key === key);
  assert.ok(found, `no press of ${key} in node ${node.id}`);
  return found;
}

function assertChainError(run, code) {
  assert.throws(run, (error) => error instanceof ChainEditError && error.code === code);
}

describe("parsing follows the engine", () => {
  test("config text splits at ; and line breaks outside quotes, comments dropped", () => {
    const text = 'set a "x; y" // c; d\nbind F1 "say hi";echo z';
    const spans = splitCommands(text);
    assert.deepEqual(texts(spans), ['set a "x; y"', 'bind F1 "say hi"', "echo z"]);
    for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
  });

  test("a block comment keeps its line together and ends a command", () => {
    assert.deepEqual(texts(splitCommands("set a 1 /* x; y\n z */ set b 2")), ["set a 1", "set b 2"]);
  });

  test("a binding splits at every ;, and a comment ends with its part", () => {
    assert.deepEqual(texts(splitBinding("+attack; vstr x // note; echo y")), ["+attack", "vstr x", "echo y"]);
  });

  test("a closed block comment in a binding ends a command, and the next one runs", () => {
    const text = [
      'bind F5 "vstr menu_open /* open the menu */ vstr menu_extra"',
      'set menu_open "echo open"',
      'set menu_extra "echo extra"',
    ].join("\n");
    const state = loadChainState([edited(text)]);
    assert.ok(state.chainVariables.has("menu_extra"));
    const step = pressKey(state, "F5");
    assert.deepEqual(texts(step.commands), ["vstr menu_open", "vstr menu_extra"]);
    assert.deepEqual(step.calls, ["menu_open", "menu_extra"]);
    assert.deepEqual(texts(step.visible), []);
    assert.deepEqual(step.diagnostics, []);
    const spans = splitBinding("vstr a /* x */ vstr b");
    assert.deepEqual(spans.map((span) => [span.text, span.start, span.end]), [["vstr a", 0, 6], ["vstr b", 15, 21]]);
  });

  test("a block comment left open runs over the parts after it, as in the buffer", () => {
    // Each part reaches the buffer on a line of its own, and a line break does
    // not end a block comment (cmd.cpp:225): the second vstr never runs.
    assert.deepEqual(texts(splitBinding("vstr a /* note; vstr b")), ["vstr a"]);
    assert.deepEqual(texts(splitBinding("vstr a /* note; still a note */ vstr b; echo c")), ["vstr a", "vstr b", "echo c"]);
    const step = pressKey(loadChainState([edited('bind F5 "vstr a /* note; vstr b"\nset a "echo a"\nset b "echo b"')]), "F5");
    assert.deepEqual(texts(step.commands), ["vstr a"]);
    assert.equal(bodyName(step), "a");
    assert.deepEqual(texts(step.visible), ["echo a"]);
  });

  test("a bind inside a variable splits at the block comment when the variable runs", () => {
    // `arm` runs `bind F6 vstr fire /* then *` and then `vstr reload` on its own:
    // the comment ends the bind before its closing mark, as the buffer cuts it.
    const text = [
      'set arm "bind F6 vstr fire /* then */ vstr reload"',
      'set fire "echo fire"',
      'set reload "echo reload"',
      'bind F5 "vstr arm"',
      'bind F7 "vstr hold /* keep */ vstr fire"',
      'set hold "echo hold"',
    ].join("\n");
    const state = loadChainState([edited(text)]);
    const arm = pressKey(state, "F5");
    assert.deepEqual(arm.rebinds, [{ key: "F6", command: "vstr fire", restore: false }]);
    assert.deepEqual(arm.calls, ["reload"]);
    const fire = pressKey(arm.state, "F6");
    assert.deepEqual(texts(fire.commands), ["vstr fire"]);
    assert.equal(bodyName(fire), "fire");
    // A top-level bind keeps the comment in its quoted binding; the press splits it there.
    assert.deepEqual(pressKey(state, "F7").calls, ["hold", "fire"]);
    assert.ok(systemOf(state, "F7").variables.includes("fire"));
  });

  test("tokens follow Cmd_TokenizeString", () => {
    assert.deepEqual(tokenizeCommand('set a "b c" d'), ["set", "a", "b c", "d"]);
    assert.deepEqual(tokenizeCommand("echo http://example.test"), ["echo", "http:"]);
    assert.deepEqual(tokenizeCommand('a"b c"'), ["a", "b c"]);
    assert.deepEqual(tokenizeCommand("  // only a comment"), []);
  });
});

describe("start state", () => {
  test("later sources win and every definition keeps its source", () => {
    const state = loadChainState([
      inherited('set greet "say hello"\nbind F2 "say old"'),
      layer('bind F2 "vstr greet"'),
      edited('bind F3 "vstr greet"'),
    ]);
    assert.equal(bindingOf(state, "f2"), "vstr greet");
    assert.deepEqual(keyInfo(state, "F2"), {
      key: "F2",
      command: "vstr greet",
      source: "Layer",
      kind: "layer",
      editable: false,
      overridable: true,
    });
    const greet = variableInfo(state, "GREET");
    assert.equal(greet.source, "client.cfg");
    assert.equal(greet.editable, false);
    assert.equal(greet.overridable, true);
  });

  test("a config that runs vstr while it loads leaves the state that vstr made", () => {
    const text = [
      'set init "bind F4 vstr mode_a"',
      'set mode_a "echo A; bind F4 vstr mode_b"',
      'set mode_b "echo B; bind F4 vstr mode_a"',
      "vstr init",
    ].join("\n");
    const state = loadChainState([edited(text)]);
    assert.equal(bindingOf(state, "F4"), "vstr mode_a");
    assert.equal(keyInfo(state, "F4").editable, true);
    assert.deepEqual(cycleBodies([edited(text)], "F4"), ["mode_a", "mode_b"]);
  });

  test("set, seta, toggle, arithmetic, reset and unset change variables like the engine", () => {
    const state = loadChainState([
      edited("seta a 1\ntoggle a\nset b x\ntoggle b x y z\ntoggle b x y z\ncvarAdd n 2\ncvarMult n 1.5\nset c first\nset c second\nreset c\nset d 1\nunset d\nset e 1\ne 5"),
    ]);
    assert.equal(variableOf(state, "a").value, "0");
    assert.equal(variableOf(state, "b").value, "z");
    assert.equal(variableOf(state, "n").value, "3");
    assert.equal(variableOf(state, "c").value, "first");
    assert.equal(variableOf(state, "d"), undefined);
    assert.equal(variableOf(state, "e").value, "5");
  });
});

describe("toggles and cycles on one key", () => {
  test("the two-state template toggles through a pointer variable", () => {
    const sources = [edited(CHAIN_TEMPLATES.cycle)];
    const state = loadChainState(sources);
    const cycle = keyCycle(state, "F7");
    assert.equal(cycle.loopsTo, 0);
    assert.deepEqual(cycle.steps.map(bodyName), ["view_off", "view_on"]);
    const [first, second] = cycle.steps;
    assert.deepEqual(first.pointers, ["view_toggle"]);
    assert.deepEqual(texts(first.visible), ["set cg_drawGun 0"]);
    assert.deepEqual(first.assignments, [{ name: "view_toggle", value: "vstr view_on" }]);
    assert.deepEqual(texts(second.visible), ["set cg_drawGun 1"]);
    const graph = exploreChain(state, "F7");
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(
      graph.nodes.map((node) => node.presses.map((press) => [press.key, press.kind, press.to])),
      [[["F7", "branch", 1]], [["F7", "link", 0]]],
    );
    assert.ok(cycleEditable(sources, "F7"));
  });

  test("a RUJKA-like toggle rebinds its own key", () => {
    const state = loadChainState([edited(REBIND_TOGGLES)]);
    const cycle = keyCycle(state, "HOME");
    assert.equal(cycle.loopsTo, 0);
    assert.deepEqual(cycle.steps.map(bodyName), ["gun_hide", "gun_show"]);
    assert.deepEqual(cycle.steps[0].pointers, []);
    assert.deepEqual(texts(cycle.steps[0].visible), ["seta cg_drawTimer 1", "set cg_drawGun 0", "echo ^1Gun hidden"]);
    assert.deepEqual(cycle.steps[0].rebinds, [{ key: "HOME", command: "vstr gun_show", restore: false }]);
    assert.deepEqual(cycle.steps[1].rebinds, [{ key: "HOME", command: "vstr gun_hide", restore: true }]);
    // cg_drawTimer is set by both toggles but no chain runs it: they stay two systems.
    assert.deepEqual(
      chainSystems(state).map((system) => system.roots),
      [["HOME"], ["END"]],
    );
  });

  test("the three-state template cycles and comes back", () => {
    const state = loadChainState([edited(CHAIN_TEMPLATES.cycle3)]);
    const cycle = keyCycle(state, "F8");
    assert.equal(cycle.loopsTo, 0);
    assert.deepEqual(cycle.steps.map(bodyName), ["crosshair_1", "crosshair_2", "crosshair_3"]);
    const graph = exploreChain(state, "F8");
    assert.equal(graph.nodes.length, 3);
    assert.deepEqual(pressOf(graph.nodes[2], "F8").to, 0);
  });

  test("a key that starts on a lead-in step loops back past it", () => {
    const text = 'set cyc "vstr intro"\nset intro "echo first; set cyc vstr c1"\nset c1 "echo one; set cyc vstr c2"\nset c2 "echo two; set cyc vstr c1"\nbind F9 "vstr cyc"';
    const cycle = keyCycle(loadChainState([edited(text)]), "F9");
    assert.deepEqual(cycle.steps.map(bodyName), ["intro", "c1", "c2"]);
    assert.equal(cycle.loopsTo, 1);
    assert.equal(cycleEditable([edited(text)], "F9"), false);
  });

  test("keys that share a pointer form one system; a shared helper does not join keys", () => {
    const text = [
      'set mode "vstr mode_a"',
      'set mode_a "echo A; set mode vstr mode_b; set back vstr mode_b"',
      'set mode_b "echo B; set mode vstr mode_a; set back vstr mode_a"',
      'set back "vstr mode_b"',
      'set beep "echo beep"',
      'bind F7 "vstr mode"',
      'bind F8 "vstr back"',
      'bind F9 "vstr beep"',
      'bind F10 "vstr beep"',
    ].join("\n");
    const systems = chainSystems(loadChainState([edited(text)])).map((system) => system.roots);
    assert.deepEqual(systems, [["F7", "F8"], ["F9"], ["F10"]]);
  });
});

describe("a menu with a submenu branches on key presses", () => {
  test("the graph follows every key the menu rebinds", () => {
    const state = loadChainState(menuSources());
    const system = systemOf(state, "F5");
    assert.deepEqual(system.roots, ["F5"]);
    for (const key of ["F5", "1", "2", "3", "4"]) assert.ok(system.keys.includes(key), key);
    assert.deepEqual(systemOf(state, "3"), system);

    const graph = exploreChain(state, "F5");
    assert.equal(graph.nodes.length, 3);
    const open = pressOf(graph.nodes[0], "F5");
    assert.equal(open.kind, "branch");
    assert.equal(bodyName(open.step), "menu_open");
    assert.deepEqual(texts(open.step.visible), ["echo Menu: 1 heal 2 protect 3 taunts 4 close"]);
    assert.deepEqual(
      open.step.rebinds.map((change) => [change.key, change.command, change.restore]),
      [
        ["1", "vstr menu_heal", false],
        ["2", "vstr menu_protect", false],
        ["3", "vstr sub_open", false],
        ["4", "vstr menu_close", false],
        ["F5", "vstr menu_close", false],
      ],
    );

    const menu = graph.nodes[1];
    assert.deepEqual(menu.path, ["F5"]);
    const heal = pressOf(menu, "1");
    assert.equal(heal.kind, "link");
    assert.equal(heal.to, 0);
    assert.deepEqual(texts(heal.step.visible), ["force_heal"]);
    assert.deepEqual(heal.step.calls, ["menu_close"]);
    assert.ok(heal.step.rebinds.every((change) => change.restore));
    assert.equal(pressOf(menu, "F5").to, 0);
    assert.equal(pressOf(menu, "4").to, 0);
    const taunts = pressOf(menu, "3");
    assert.equal(taunts.kind, "branch");
    assert.deepEqual(taunts.path, ["F5", "3"]);

    const submenu = graph.nodes[taunts.to];
    assert.equal(pressOf(submenu, "1").to, 0);
    assert.deepEqual(texts(pressOf(submenu, "2").step.visible), ["meditate"]);
    const flourish = pressOf(submenu, "3");
    assert.equal(flourish.kind, "leaf");
    assert.equal(flourish.step.missing, "sub_flourish");
    assert.equal(pressOf(submenu, "4").to, 0);
    // Unchanged plain keys are no branch of the start state.
    assert.deepEqual(graph.nodes[0].presses.map((press) => press.key), ["F5"]);
    assert.deepEqual(
      graph.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject, diagnostic.path]),
      [["missing", "sub_flourish", ["F5", "3", "3"]]],
    );
    assert.equal(graph.variables.find((variable) => variable.name === "sub_flourish").value, null);
  });

  test("the menu template opens, goes to its submenu and back", () => {
    const state = loadChainState([inherited(CLIENT), edited(CHAIN_TEMPLATES.menu)]);
    const graph = exploreChain(state, "F5");
    assert.equal(graph.nodes.length, 3);
    const menu = graph.nodes[1];
    const taunts = pressOf(menu, "4");
    assert.equal(taunts.kind, "branch");
    const back = pressOf(graph.nodes[taunts.to], "4");
    assert.equal(back.kind, "link");
    assert.equal(back.to, 1);
    assert.equal(pressOf(menu, "5").to, 0);
    assert.deepEqual(graph.diagnostics, []);
  });
});

describe("diagnostics", () => {
  test("a missing variable runs nothing and is reported where it is called", () => {
    const step = pressKey(loadChainState([edited('bind F9 "echo a; vstr nothing"')]), "F9");
    assert.deepEqual(
      step.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject, diagnostic.container, diagnostic.index]),
      [["missing", "nothing", { kind: "binding", key: "F9" }, 1]],
    );
    assert.equal(step.outcome, "done");
  });

  test("a variable that runs itself without wait hangs the game", () => {
    const state = loadChainState([edited('set spin "echo x; vstr spin"\nbind F10 "vstr spin"')]);
    const step = pressKey(state, "F10");
    assert.equal(step.outcome, "immediateLoop");
    assert.deepEqual(step.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject]), [["immediateLoop", "spin"]]);
    const press = pressOf(exploreChain(state, "F10").nodes[0], "F10");
    assert.equal(press.kind, "leaf");
    assert.equal(press.to, null);
  });

  test("a loop with wait repeats every frame", () => {
    const state = loadChainState([edited('set spam "+attack; wait; -attack; wait; vstr spam"\nbind F11 "vstr spam"')]);
    const step = pressKey(state, "F11");
    assert.equal(step.outcome, "frameLoop");
    assert.equal(step.frames, 2);
    assert.deepEqual(step.diagnostics.map((diagnostic) => diagnostic.kind), ["frameLoop"]);
  });

  test("a key that starts and stops a frame loop is a two-step cycle", () => {
    const text = [
      'set loop_start "bind F11 vstr loop_stop; set loop vstr loop_body; vstr loop"',
      'set loop_stop "set loop echo stopped; bind F11 vstr loop_start"',
      'set loop_body "echo tick; wait; vstr loop"',
      'bind F11 "vstr loop_start"',
    ].join("\n");
    // `loop` is undefined until the first press, so the first start is a lead-in.
    const leadIn = keyCycle(loadChainState([edited(text)]), "F11");
    assert.deepEqual(leadIn.steps.map((step) => step.outcome), ["frameLoop", "done", "frameLoop"]);
    assert.equal(leadIn.loopsTo, 1);
    const cycle = keyCycle(loadChainState([edited(`set loop "echo stopped"\n${text}`)]), "F11");
    assert.deepEqual(cycle.steps.map((step) => step.outcome), ["frameLoop", "done"]);
    assert.equal(cycle.loopsTo, 0);
  });

  test("two variables that run each other hang the game, and with wait repeat every frame", () => {
    const hang = pressKey(loadChainState([edited('set ping "vstr pong"\nset pong "vstr ping"\nbind F1 "vstr ping"')]), "F1");
    assert.equal(hang.outcome, "immediateLoop");
    assert.deepEqual(hang.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject]), [["immediateLoop", "ping"]]);
    const repeat = pressKey(
      loadChainState([edited('set ping "vstr pong"\nset pong "echo pong; wait; vstr ping"\nbind F1 "vstr ping"')]),
      "F1",
    );
    assert.equal(repeat.outcome, "frameLoop");
    assert.equal(repeat.frames, 1);
    assert.deepEqual(repeat.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject]), [["frameLoop", "ping"]]);
    assert.equal(bodyName(repeat), "pong");
  });

  test("a variable that changes itself before it runs again is no loop", () => {
    const step = pressKey(loadChainState([edited('set once "set once echo done; vstr once"\nbind F1 "vstr once"')]), "F1");
    assert.equal(step.outcome, "done");
    assert.deepEqual(step.diagnostics, []);
  });

  test("exec is opaque, and a variable missing after it may come from the file", () => {
    const step = pressKey(loadChainState([edited('bind F12 "exec extra; vstr from_file"')]), "F12");
    assert.deepEqual(
      step.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject, diagnostic.afterOpaque ?? false]),
      [
        ["opaque", "exec extra", false],
        ["missing", "from_file", true],
      ],
    );
  });

  test("vstr without exactly one variable only prints its usage", () => {
    const step = pressKey(loadChainState([edited('bind F1 "vstr"')]), "F1");
    assert.deepEqual(step.diagnostics.map((diagnostic) => diagnostic.kind), ["usage"]);
  });

  test("caps stop runaway expansions and graphs", () => {
    const doubling = ['set a0 "echo x"', ...Array.from({ length: 8 }, (_, i) => `set a${i + 1} "vstr a${i}; vstr a${i}"`), 'bind F1 "vstr a8"'].join("\n");
    const step = pressKey(loadChainState([edited(doubling)]), "F1", { maxCommands: 50 });
    assert.equal(step.outcome, "limit");
    assert.deepEqual(step.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject]), [["limit", "commands"]]);
    const graph = exploreChain(loadChainState(menuSources()), "F5", { maxNodes: 2 });
    assert.equal(graph.truncated, true);
    assert.equal(graph.nodes.length, 2);
    assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.kind === "limit" && diagnostic.subject === "nodes"));
  });

  test("a load-time loop is reported with the source command", () => {
    const state = loadChainState([edited('set spin "vstr spin"\nvstr spin\nbind F1 "say after"')]);
    assert.deepEqual(
      state.loadDiagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.subject, diagnostic.path]),
      [["immediateLoop", "spin", null]],
    );
    assert.equal(bindingOf(state, "F1"), "say after");
  });
});

describe("previews and read-only sources", () => {
  test("a typed command is previewed without touching the config", () => {
    const state = loadChainState([edited(CHAIN_TEMPLATES.cycle)]);
    const preview = withStartBinding(state, "F6", "vstr view_toggle");
    assert.deepEqual(keyCycle(preview, "F6").steps.map(bodyName), ["view_off", "view_on"]);
    assert.equal(keyInfo(preview, "F6").source, null);
  });

  test("a variable from another source is read-only, and an override appends a copy", () => {
    const sources = [inherited('set greet "say hello"'), edited('// Mine\nbind F2 "vstr greet"\n')];
    assert.equal(overrideVariable(sources, "greet"), '// Mine\nbind F2 "vstr greet"\nset greet "say hello"\n');
    const changed = setStepCommands(sources, ["F2"], ["say hi"]);
    assert.equal(changed, '// Mine\nbind F2 "vstr greet"\nset greet "say hi"\n');
    const after = loadChainState(withText(sources, changed));
    assert.equal(variableInfo(after, "greet").editable, true);
    assert.deepEqual(texts(pressKey(after, "F2").visible), ["say hi"]);
  });

  test("a binding from another source is overridden the same way", () => {
    const sources = [inherited('bind F2 "vstr greet"\nset greet "say hello"'), edited("")];
    assert.equal(overrideBinding(sources, "F2"), 'bind F2 "vstr greet"\n');
  });

  test("a cycle kept in another source is rewired only after its variables are overridden", () => {
    const sources = [inherited(REBIND_TOGGLES), edited("")];
    assert.equal(cycleEditable(sources, "HOME"), false);
    let text = overrideVariable(sources, "gun_hide");
    text = overrideVariable(withText(sources, text), "gun_show");
    assert.equal(cycleEditable(withText(sources, text), "HOME"), true);
    const swapped = reorderCycle(withText(sources, text), "HOME", [1, 0]);
    assert.ok(swapped.endsWith('bind HOME "vstr gun_show"\n'));
    assert.deepEqual(cycleBodies(withText(sources, swapped), "HOME"), ["gun_show", "gun_hide"]);
  });

  test("a later config shadows the edited one, so edits are refused", () => {
    const sources = [edited('bind F2 "vstr greet"'), layer('set greet "say hello"')];
    const info = variableInfo(loadChainState(sources), "greet");
    assert.equal(info.editable, false);
    assert.equal(info.overridable, false);
    assertChainError(() => setStepCommands(sources, ["F2"], ["say hi"]), "shadowed");
    assertChainError(() => overrideVariable(sources, "greet"), "shadowed");
  });
});

describe("edits write config text and re-simulate as expected", () => {
  const toggleText = `// Keep this comment\nbind W "+forward"\n${CHAIN_TEMPLATES.cycle}seta cg_fov "100"\n`;

  /** Lines of `before` that `after` must keep untouched. */
  function assertKept(before, after, changed) {
    const kept = before.split("\n").filter((line) => !changed.some((part) => line.includes(part)));
    for (const line of kept) assert.ok(after.split("\n").includes(line), `lost line: ${line}`);
  }

  test("visible commands of a step change and its link stays", () => {
    const sources = [edited(toggleText)];
    const text = setStepCommands(sources, ["F7"], ["set cg_drawGun 0", "echo ^1Gun hidden"]);
    assert.ok(text.includes('set view_off "set cg_drawGun 0; echo ^1Gun hidden; set view_toggle vstr view_on"'));
    assertKept(toggleText, text, ["view_off"]);
    const cycle = keyCycle(loadChainState([edited(text)]), "F7");
    assert.equal(cycle.loopsTo, 0);
    assert.deepEqual(texts(cycle.steps[0].visible), ["set cg_drawGun 0", "echo ^1Gun hidden"]);
    const second = setStepCommands([edited(text)], ["F7", "F7"], ["echo shown"]);
    assert.ok(second.includes('set view_on "echo shown; set view_toggle vstr view_on"') === false);
    assert.ok(second.includes('set view_on "echo shown; set view_toggle vstr view_off"'));
  });

  test("a step that ends in a missing variable defines it", () => {
    const sources = menuSources();
    const text = setStepCommands(sources, ["F5", "3", "3"], ["flourish", "vstr menu_close"]);
    assert.ok(text.endsWith('set sub_flourish "flourish; vstr menu_close"\n'));
    const graph = exploreChain(loadChainState(withText(sources, text)), "F5");
    assert.deepEqual(graph.diagnostics, []);
    assert.equal(pressOf(graph.nodes[2], "3").to, 0);
  });

  test("a plain key's binding is its own step", () => {
    const sources = [edited('bind F3 "say hi; vstr cheer"\nset cheer "echo yay"\n')];
    const text = setStepCommands(sources, ["F3"], ["say bye"]);
    assert.equal(text, 'bind F3 "say bye; vstr cheer"\nset cheer "echo yay"\n');
  });

  test("steps of a cycle reorder by rewiring the pointer", () => {
    const sources = [edited(CHAIN_TEMPLATES.cycle3)];
    const text = reorderCycle(sources, "F8", [0, 2, 1]);
    assert.deepEqual(cycleBodies([edited(text)], "F8"), ["crosshair_1", "crosshair_3", "crosshair_2"]);
    assert.equal(keyCycle(loadChainState([edited(text)]), "F8").loopsTo, 0);
    const rotated = reorderCycle(sources, "F8", [2, 0, 1]);
    assert.ok(rotated.includes('set crosshair_cycle "vstr crosshair_3"'));
    assert.deepEqual(cycleBodies([edited(rotated)], "F8"), ["crosshair_3", "crosshair_1", "crosshair_2"]);
  });

  test("a RUJKA-like toggle reorders by rewriting its binding", () => {
    const text = reorderCycle([edited(REBIND_TOGGLES)], "HOME", [1, 0]);
    assert.ok(text.startsWith('bind HOME "vstr gun_show"\n'));
    assert.deepEqual(cycleBodies([edited(text)], "HOME"), ["gun_show", "gun_hide"]);
    assertKept(REBIND_TOGGLES, text, ['bind HOME "vstr gun_hide"']);
  });

  test("steps insert anywhere in a cycle, in the chain's own idiom", () => {
    const sources = [edited(CHAIN_TEMPLATES.cycle)];
    const middle = insertCycleStep(sources, "F7", 1, ["echo middle"]);
    assert.deepEqual(cycleBodies([edited(middle)], "F7"), ["view_off", "view_3", "view_on"]);
    assert.ok(middle.includes('set view_3 "echo middle; set view_toggle vstr view_on"'));
    const first = insertCycleStep(sources, "F7", 0, ["echo first"]);
    assert.deepEqual(cycleBodies([edited(first)], "F7"), ["view_3", "view_off", "view_on"]);
    const rebind = insertCycleStep([edited(REBIND_TOGGLES)], "HOME", 2, ["echo ^3Gun extra"]);
    assert.ok(rebind.includes('set gun_3 "echo ^3Gun extra; bind HOME vstr gun_hide"'));
    assert.deepEqual(cycleBodies([edited(rebind)], "HOME"), ["gun_hide", "gun_show", "gun_3"]);
  });

  test("a plain key becomes a toggle when a step is added", () => {
    const text = insertCycleStep([edited('bind F3 "say hi"\n')], "F3", 1, ["say bye"]);
    const cycle = keyCycle(loadChainState([edited(text)]), "F3");
    assert.equal(cycle.loopsTo, 0);
    assert.deepEqual(cycle.steps.map((step) => texts(step.visible)), [["say hi"], ["say bye"]]);
    assert.ok(text.startsWith('bind F3 "vstr f3_toggle"\n'));
  });

  test("steps remove, their variable goes, and the last step stays", () => {
    const sources = [edited(CHAIN_TEMPLATES.cycle3)];
    const text = removeCycleStep(sources, "F8", 1);
    assert.deepEqual(cycleBodies([edited(text)], "F8"), ["crosshair_1", "crosshair_3"]);
    assert.ok(!text.includes("set crosshair_2 "));
    const first = removeCycleStep(sources, "F8", 0);
    assert.deepEqual(cycleBodies([edited(first)], "F8"), ["crosshair_2", "crosshair_3"]);
    const one = removeCycleStep([edited(text)], "F8", 1);
    assert.deepEqual(cycleBodies([edited(one)], "F8"), ["crosshair_1"]);
    assertChainError(() => removeCycleStep([edited(one)], "F8", 0), "lastStep");
  });

  test("a toggle moves to another key everywhere it writes the key", () => {
    const text = changeKey([edited(REBIND_TOGGLES)], "HOME", "INS");
    assert.ok(text.startsWith('bind INS "vstr gun_hide"\n'));
    assert.ok(text.includes("bind INS vstr gun_show"));
    assert.ok(text.includes("bind INS vstr gun_hide"));
    assert.ok(!text.includes("HOME"));
    assertKept(REBIND_TOGGLES, text, ["HOME"]);
    const state = loadChainState([edited(text)]);
    assert.equal(bindingOf(state, "HOME"), "");
    assert.deepEqual(cycleBodies([edited(text)], "INS"), ["gun_hide", "gun_show"]);
  });

  test("a toggle bound by another source moves with an unbind of the old key", () => {
    const sources = [inherited(REBIND_TOGGLES), edited("")];
    const text = changeKey(sources, "HOME", "INS");
    assert.ok(text.includes('set gun_hide "seta cg_drawTimer 1;set cg_drawGun 0;echo ^1Gun hidden;bind INS vstr gun_show"'));
    assert.ok(text.includes('bind INS "vstr gun_hide"'));
    assert.ok(text.includes("unbind HOME"));
    const state = loadChainState(withText(sources, text));
    assert.equal(bindingOf(state, "HOME"), "");
    assert.deepEqual(keyCycle(state, "INS").steps.map(bodyName), ["gun_hide", "gun_show"]);
  });

  test("a menu key moves, and the close step gives the new key its own binding back", () => {
    const sources = menuSources();
    const text = changeKey(sources, "3", "6");
    assert.ok(text.includes("bind 6 vstr sub_open"));
    assert.ok(text.includes("bind 6 weapon 6"));
    assert.ok(text.includes("bind 6 vstr sub_flourish"));
    assert.ok(!/bind 3 /.test(text));
    const graph = exploreChain(loadChainState(withText(sources, text)), "F5");
    assert.equal(pressOf(graph.nodes[1], "6").kind, "branch");
    assert.ok(!graph.nodes[1].presses.some((press) => press.key === "3"));
    assert.ok(pressOf(graph.nodes[1], "1").step.rebinds.some((change) => change.key === "6" && change.restore));
  });

  test("the menu's own key moves as the root of the system", () => {
    const text = changeKey(menuSources(), "F5", "F6");
    assert.ok(text.includes('bind F6 "vstr menu_open"'));
    assert.ok(text.includes("bind F6 vstr menu_close"));
    assert.ok(text.includes("bind F6 vstr menu_open"));
    assert.ok(!text.includes("F5"));
  });

  test("a branch adds to a menu step, closes like its siblings and is given back", () => {
    const sources = menuSources();
    const text = addBranch(sources, ["F5"], "5", ["force_speed"]);
    assert.ok(text.includes("bind 4 vstr menu_close; bind 5 vstr menu_open_5; bind F5 vstr menu_close"));
    assert.ok(text.includes('set menu_open_5 "force_speed; vstr menu_close"'));
    assert.ok(text.includes("bind 4 weapon 4; bind 5 weapon 5; bind F5 vstr menu_open"));
    assert.ok(!text.includes("bind 3 vstr sub_flourish; bind 5"));
    const graph = exploreChain(loadChainState(withText(sources, text)), "F5");
    const speed = pressOf(graph.nodes[1], "5");
    assert.equal(speed.to, 0);
    assert.deepEqual(texts(speed.step.visible), ["force_speed"]);
    assertChainError(() => addBranch(sources, ["F5"], "4", ["echo again"]), "branchExists");
    assertChainError(() => addBranch(sources, ["F5"], "F5", ["echo self"]), "unsupported");
  });

  test("a branch removes with its variable, and its restore goes when nothing moves the key", () => {
    const sources = menuSources();
    const withoutTwo = removeBranch(sources, ["F5"], "2");
    assert.ok(!withoutTwo.includes("vstr menu_protect"));
    assert.ok(!withoutTwo.includes("set menu_protect"));
    assert.ok(withoutTwo.includes("bind 2 weapon 2"), "the submenu still moves 2");
    const withoutFour = removeBranch(sources, ["F5"], "4");
    assert.ok(!withoutFour.includes("bind 4 "));
    assert.ok(withoutFour.includes("set menu_close"));
    const graph = exploreChain(loadChainState(withText(sources, withoutFour)), "F5");
    assert.ok(!graph.nodes[1].presses.some((press) => press.key === "4"));
    assertChainError(() => removeBranch(sources, ["F5"], "7"), "noBranch");
  });

  test("new toggles and menus are generated in the pointer idiom", () => {
    const sources = [inherited(CLIENT), edited('bind W "+forward"\n')];
    const toggle = createToggle(sources, "F9", [["echo a"], ["echo b"], ["echo c"]]);
    assert.equal(
      toggle,
      'bind W "+forward"\nset f9_toggle_1 "echo a; set f9_toggle vstr f9_toggle_2"\nset f9_toggle_2 "echo b; set f9_toggle vstr f9_toggle_3"\nset f9_toggle_3 "echo c; set f9_toggle vstr f9_toggle_1"\nset f9_toggle "vstr f9_toggle_1"\nbind F9 "vstr f9_toggle"\n',
    );
    assert.deepEqual(cycleBodies(withText(sources, toggle), "F9"), ["f9_toggle_1", "f9_toggle_2", "f9_toggle_3"]);
    const again = createToggle(withText(sources, toggle), "F9", [["echo x"], ["echo y"]]);
    assert.ok(again.includes('set f9_toggle2 "vstr f9_toggle2_1"'));

    const menu = createMenu(sources, "F6", {
      open: ["echo 1 heal 2 protect"],
      items: [
        { key: "1", commands: ["force_heal"] },
        { key: "2", commands: ["force_protect"] },
      ],
    });
    assert.ok(menu.includes('set f6_menu_open "echo 1 heal 2 protect; bind 1 vstr f6_menu_1; bind 2 vstr f6_menu_2; bind F6 vstr f6_menu_close"'));
    assert.ok(menu.includes('set f6_menu_close "bind 1 weapon 1; bind 2 weapon 2; bind F6 vstr f6_menu_open"'));
    const graph = exploreChain(loadChainState(withText(sources, menu)), "F6");
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(graph.nodes[1].presses.map((press) => [press.key, press.to]), [["F6", 0], ["1", 0], ["2", 0]]);
  });

  test("invalid input is refused like appendBind", () => {
    const sources = [edited(CHAIN_TEMPLATES.cycle)];
    assertChainError(() => setStepCommands(sources, ["F7"], ['say "hi"']), "syntax");
    assertChainError(() => setStepCommands(sources, ["F7"], ["echo a\necho b"]), "syntax");
    assertChainError(() => setStepCommands(sources, ["F7"], ["echo http://example.test"]), "syntax");
    assertChainError(() => createToggle(sources, "F 7", [["echo a"]]), "syntax");
    assertChainError(() => changeKey(sources, "F7", 'F"8'), "syntax");
    assert.throws(() => createToggle(sources, "F9", [["echo a"]], "bad name"), { message: "Invalid bind syntax" });
    assertChainError(() => setStepCommands([inherited(CHAIN_TEMPLATES.cycle)], ["F7"], ["echo a"]), "noEditedSource");
  });

  test("a step the chain itself rewrites cannot be edited as text", () => {
    const text = 'set t "vstr a"\nset a "echo A; set t echo done"\nbind F1 "vstr t"';
    const state = loadChainState([edited(text)]);
    assert.equal(replayPresses(state, ["F1", "F1"]).step.body.kind, "variable");
    assertChainError(() => setStepCommands([edited(text)], ["F1", "F1"], ["echo x"]), "notEditable");
  });
});

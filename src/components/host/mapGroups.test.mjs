import assert from "node:assert/strict";
import test from "node:test";

import { groupHostMaps } from "./mapGroups.ts";

const modes = [
  { id: "ffa", label: "Free for all" },
  { id: "duel", label: "Duel" },
  { id: "ctf", label: "Capture the Flag" },
];

function map(name, gametypes) {
  return { name, title: null, gametypes, source: "game", levelshot: null };
}

test("groups every map by its first advertised mode and keeps all labels", () => {
  const maps = [
    map("mp/ctf1", ["ctf"]),
    map("mp/duel10", ["duel"]),
    map("mp/ffa10", ["ffa", "ctf"]),
    map("mp/ffa2", ["ffa"]),
  ];

  const grouped = groupHostMaps(maps, modes);

  assert.deepEqual(grouped.map((entry) => [entry.map.name, entry.group]), [
    ["mp/ffa2", "Free for all"],
    ["mp/ffa10", "Free for all"],
    ["mp/duel10", "Duel"],
    ["mp/ctf1", "Capture the Flag"],
  ]);
  assert.deepEqual(grouped.find((entry) => entry.map.name === "mp/ffa10")?.modeLabels, [
    "Free for all",
    "Capture the Flag",
  ]);
});

test("unknown and missing arena metadata stay visible after known groups", () => {
  const maps = [
    map("mp/no-metadata", []),
    map("mp/custom", ["custom", "ffa"]),
    map("mp/alpha", ["alpha"]),
    map("mp/known", ["duel"]),
  ];

  const grouped = groupHostMaps(maps, modes);

  assert.deepEqual(grouped.map((entry) => [entry.map.name, entry.group, entry.modeLabels]), [
    ["mp/known", "Duel", ["Duel"]],
    ["mp/alpha", "ALPHA", ["ALPHA"]],
    ["mp/custom", "CUSTOM", ["CUSTOM", "Free for all"]],
    ["mp/no-metadata", null, []],
  ]);
});

test("deduplicates mode tokens and leaves the input intact while retaining every map", () => {
  const maps = [
    map("mp/z10", ["FFA", "ffa", "duel"]),
    map("mp/z2", ["ffa"]),
    map("mp/unknown", ["modemode"]),
  ];
  const before = JSON.stringify(maps);

  const grouped = groupHostMaps(maps, modes);

  assert.equal(JSON.stringify(maps), before);
  assert.equal(grouped.length, maps.length);
  assert.deepEqual(new Set(grouped.map((entry) => entry.map.name)), new Set(maps.map((entry) => entry.name)));
  assert.deepEqual(grouped.find((entry) => entry.map.name === "mp/z10")?.modeLabels, ["Free for all", "Duel"]);
  assert.deepEqual(grouped.map((entry) => entry.map.name), ["mp/z2", "mp/z10", "mp/unknown"]);
});

/**
 * Tests for the management screen of a community: the form model
 * (`model.ts`), the checks it makes before a request (`validate.ts`) and the
 * upload of a picture from a file input (`upload.ts`).
 *
 * Node strips the TypeScript types itself, so the modules run without a
 * build step and without a test framework.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import {
  changed,
  draftOf,
  formOf,
  formReducer,
  imagesPatch,
  isDirty,
  labelChanges,
  normalizeInvite,
  pagePatch,
  rebase,
} from "./model.ts";
import { IMAGE_MAX_BYTES, prepareImage, sha256Hex, sniffImage, uploadImageFile } from "./upload.ts";
import { accountIdOf, addressProblem, bundleIdOf, hasProblems, inviteCode, linkProblem, problemsOf } from "./validate.ts";

const ID = `01K6SWJKA${"0".repeat(17)}`;
const SERVER_A = `01K6SRVFFA${"0".repeat(16)}`;
const SERVER_B = `01K6SRVDUEL${"0".repeat(15)}`;
const BUNDLE = `01K6BUNDLE${"0".repeat(16)}`;

function community(patch = {}) {
  return {
    id: ID,
    name: "SWJKA | Russian Public",
    tagline: "FFA and duels",
    description: "We duel.",
    rules: "Bow first.",
    website: "https://swjka.example.org",
    discord: "https://discord.gg/swjka",
    links: [{ kind: "youtube", url: "https://www.youtube.com/@swjka" }],
    tags: ["ffa", "duel"],
    languages: ["ru"],
    region: "cis",
    recommendations: [{ jkhubId: 1422, title: "Expedition" }],
    bundle: null,
    logo: null,
    banner: null,
    ownerId: null,
    owner: null,
    editors: [],
    featured: false,
    listed: false,
    verified: false,
    games: ["ja"],
    servers: [
      { id: SERVER_A, game: "ja", address: "1.1.1.1:29070", label: "FFA", position: 0, verified: true, verifiedAt: null },
      { id: SERVER_B, game: "ja", address: "1.1.1.1:29071", label: "Duel", position: 1, verified: false, verifiedAt: null },
    ],
    counts: { followers: 0, regulars: 0, upcomingEvents: 0 },
    viewer: { role: "owner", isAdmin: false, following: false, notify: false },
    revision: 7,
    createdAt: "2026-09-30T20:18:21Z",
    updatedAt: "2026-09-30T20:18:21Z",
    ...patch,
  };
}

describe("the form of a page", () => {
  test("reads every field of the page", () => {
    const draft = draftOf(community({ bundle: { id: BUNDLE, name: "RUJKA Edition" }, logo: "a".repeat(64) }));
    assert.equal(draft.name, "SWJKA | Russian Public");
    assert.deepEqual(draft.links.map(({ kind, url }) => [kind, url]), [["youtube", "https://www.youtube.com/@swjka"]]);
    assert.deepEqual(draft.files.map(({ title, link }) => [title, link]), [["Expedition", "https://jkhub.org/files/file/1422/"]]);
    assert.equal(draft.bundleId, BUNDLE);
    assert.equal(draft.bundleName, "RUJKA Edition");
    assert.equal(draft.logo, "a".repeat(64));
    assert.deepEqual(draft.labels, { [SERVER_A]: "FFA", [SERVER_B]: "Duel" });
    assert.notEqual(draft.links[0].key, draft.files[0].key, "every row has a key of its own");
  });

  test("a field changes by what the service would store, not by spaces around it", () => {
    const base = draftOf(community());
    assert.equal(changed(base, { ...base, name: " SWJKA | Russian Public " }, "name"), false);
    assert.equal(changed(base, { ...base, name: "SWJKA" }, "name"), true);
    assert.equal(changed(base, { ...base, discord: "discord.gg/swjka/" }, "discord"), false, "the same invite typed short");
    // A recommendation typed as a bare id is the same file.
    assert.equal(changed(base, { ...base, files: [{ key: 99, title: "Expedition", link: "1422" }] }, "files"), false);
    assert.equal(changed(base, { ...base, tags: ["duel", "ffa"] }, "tags"), true, "the order is what the page shows");
    assert.equal(isDirty(base, base), false);
    assert.equal(isDirty(base, { ...base, labels: { ...base.labels, [SERVER_B]: "Duel " } }), false);
    assert.equal(isDirty(base, { ...base, labels: { ...base.labels, [SERVER_B]: "1v1" } }), true);
  });

  test("the patch carries the changed fields only, on the revision of the edits", () => {
    const base = draftOf(community());
    assert.equal(pagePatch(base, base, 7), null);
    const draft = {
      ...base,
      tagline: " Sabers at dawn ",
      region: null,
      discord: "discord.gg/new-invite",
      files: [...base.files, { key: 100, title: " Atlantica ", link: "https://jkhub.org/files/file/1561-atlantica/" }],
      bundleId: BUNDLE,
    };
    assert.deepEqual(pagePatch(base, draft, 7), {
      revision: 7,
      tagline: "Sabers at dawn",
      discord: "https://discord.gg/new-invite",
      region: null,
      recommendations: [
        { jkhubId: 1422, title: "Expedition" },
        { jkhubId: 1561, title: "Atlantica" },
      ],
      bundleId: BUNDLE,
    });
    assert.equal(imagesPatch(base, draft), null);
    assert.deepEqual(imagesPatch(base, { ...base, logo: "b".repeat(64), banner: null }), { logo: "b".repeat(64) });
    assert.deepEqual(imagesPatch({ ...base, banner: "c".repeat(64) }, base), { banner: null });
    assert.deepEqual(labelChanges(base, { ...base, labels: { [SERVER_A]: " Arena ", [SERVER_B]: "Duel" } }), [
      { serverId: SERVER_A, label: "Arena" },
    ]);
  });

  test("an invite typed without its scheme or with a slash after it is the invite", () => {
    assert.equal(normalizeInvite(" discord.gg/abc "), "https://discord.gg/abc");
    assert.equal(normalizeInvite("www.discord.com/invite/abc/"), "https://www.discord.com/invite/abc");
    assert.equal(normalizeInvite("https://discord.gg/abc/"), "https://discord.gg/abc");
    assert.equal(normalizeInvite("https://example.org/"), "https://example.org/");
  });

  test("a page that moved under the edits keeps what the organizer changed", () => {
    const previous = draftOf(community());
    const draft = { ...previous, tagline: "Mine", labels: { ...previous.labels, [SERVER_A]: "Arena" } };
    const next = draftOf(community({ name: "Renamed", tagline: "Theirs", logo: "d".repeat(64), revision: 8 }));
    const result = rebase(previous, draft, next);
    assert.equal(result.tagline, "Mine", "the edit stays");
    assert.equal(result.name, "Renamed", "an untouched field follows the page");
    assert.equal(result.logo, "d".repeat(64));
    assert.equal(result.labels[SERVER_A], "Arena");
    assert.equal(result.links, draft.links, "a field that did not move keeps its rows");
  });

  test("a write of the screen moves the revision of the edits, a write of somebody else does not", () => {
    let state = formOf(community());
    state = formReducer(state, { type: "edit", patch: { tagline: "Mine" } });
    // The screen moved a server: one write, one revision.
    state = formReducer(state, { type: "applied", community: community({ revision: 8 }) });
    assert.equal(state.revision, 8);
    assert.equal(state.draft.tagline, "Mine");
    assert.equal(isDirty(state.base, state.draft), true);
    // Somebody else saved in between: the edits stay on 8, and the save meets a conflict.
    state = formReducer(state, { type: "applied", community: community({ revision: 10, name: "Theirs" }) });
    assert.equal(state.revision, 8);
    assert.equal(state.draft.name, "Theirs");
    assert.equal(state.draft.tagline, "Mine");
    // The save of the tagline answered: nothing is left to save.
    state = formReducer(state, { type: "applied", community: community({ revision: 9, tagline: "Mine" }) });
    assert.equal(state.revision, 9);
    assert.equal(isDirty(state.base, state.draft), false);
    // Without edits, the form simply follows the page.
    state = formReducer(state, { type: "applied", community: community({ revision: 15, rules: "New rules" }) });
    assert.equal(state.revision, 15);
    assert.equal(state.draft.rules, "New rules");
    // A logo saved after somebody else's write leaves nothing to save: the form is the page, on its revision.
    state = formReducer(state, { type: "edit", patch: { logo: "e".repeat(64) } });
    state = formReducer(state, { type: "applied", community: community({ revision: 18, rules: "New rules", logo: "e".repeat(64) }) });
    assert.equal(isDirty(state.base, state.draft), false);
    assert.equal(state.revision, 18);
    state = formReducer(formReducer(state, { type: "edit", patch: { name: "x" } }), { type: "discard" });
    assert.equal(state.draft, state.base);
  });
});

describe("the checks before a save", () => {
  const base = draftOf(community({ discord: "https://example.org/old-discord" }));

  test("only a changed field is checked, so a stored value passes as it is", () => {
    const problems = problemsOf(base, base);
    assert.equal(hasProblems(problems), false, "the stored Discord link is not an invite, and that is fine");
    assert.equal(problemsOf(base, { ...base, discord: "https://example.org/other" }).discord, "invite");
  });

  test("texts keep to their lengths and lines", () => {
    assert.equal(problemsOf(base, { ...base, name: "  " }).name, "required");
    assert.equal(problemsOf(base, { ...base, name: "x".repeat(101) }).name, "tooLong");
    assert.equal(problemsOf(base, { ...base, name: "Ж".repeat(100) }).name, undefined, "letters, not bytes");
    assert.equal(problemsOf(base, { ...base, tagline: "one\ttwo" }).tagline, "oneLine");
    assert.equal(problemsOf(base, { ...base, description: "a\n\nb\tc" }).description, undefined);
    assert.equal(problemsOf(base, { ...base, description: "x".repeat(6001) }).description, "tooLong");
    assert.equal(problemsOf(base, { ...base, rules: "bell\u0007" }).rules, "control");
    assert.equal(problemsOf(base, { ...base, website: "http://swjka.example.org" }).website, "https");
    assert.equal(problemsOf(base, { ...base, website: "https://user:pass@example.org" }).website, "https");
    assert.equal(problemsOf(base, { ...base, website: "" }).website, undefined, "empty clears it");
    assert.equal(problemsOf(base, { ...base, labels: { ...base.labels, [SERVER_A]: "x".repeat(41) } }).labels[SERVER_A], "tooLong");
  });

  test("a link keeps to the hosts of its kind", () => {
    assert.equal(linkProblem("youtube", "https://youtu.be/abc"), undefined);
    assert.equal(linkProblem("youtube", "https://youtube.com.evil.org/x"), "linkHost");
    assert.equal(linkProblem("twitch", "https://youtube.com/x"), "linkHost");
    assert.equal(linkProblem("github", "http://github.com/jknet"), "https");
    assert.equal(linkProblem("vk", "https://vk.ru/jknet"), undefined);
    assert.equal(linkProblem("other", "https://anything.example.net/page"), undefined);
    assert.equal(linkProblem("other", " "), "linkEmpty");
    assert.equal(linkProblem("myspace", "https://myspace.com/x"), "linkHost");
  });

  test("an invite is read as the service reads it", () => {
    assert.equal(inviteCode("https://discord.gg/swjka"), "swjka");
    assert.equal(inviteCode("https://discord.com/invite/Xq7-PpLm2"), "Xq7-PpLm2");
    assert.equal(inviteCode("https://www.discord.com/invite/abc"), "abc");
    for (const bad of ["http://discord.gg/abc", "https://discord.gg/a", "https://discord.gg/abc?x=1", "https://discord.com/abc", "https://discord.gg/abc/", "https://discord.gg:8443/abc", "https://evil.org/abc"]) {
      assert.equal(inviteCode(bad), null, bad);
    }
  });

  test("recommended files need a title and a distinct JKHub file", () => {
    const files = [
      { key: 1, title: "Expedition", link: "1422" },
      { key: 2, title: "", link: "1561" },
      { key: 3, title: "Atlantica", link: "https://example.org/1561" },
      { key: 4, title: "Again", link: "https://jkhub.org/files/file/1422-expedition/" },
    ];
    const problems = problemsOf(base, { ...base, files });
    assert.deepEqual(problems.files, { 2: "fileTitle", 3: "fileLink", 4: "fileDuplicate" });
  });

  test("a bundle is named by its id", () => {
    assert.equal(problemsOf(base, { ...base, bundleId: "nope" }).bundle, "bundle");
    assert.equal(problemsOf(base, { ...base, bundleId: BUNDLE }).bundle, undefined);
    assert.equal(bundleIdOf(BUNDLE), BUNDLE);
    assert.equal(bundleIdOf(`https://web.example.com/bundles/${BUNDLE}`), BUNDLE);
    assert.equal(bundleIdOf("https://web.example.com/bundles/rujka"), null);
    assert.equal(accountIdOf(` ${BUNDLE} `), BUNDLE);
    assert.equal(accountIdOf("Kyle"), null);
  });

  test("the address of a new server is a public IPv4 and a port from 1024", () => {
    assert.equal(addressProblem("1.1.1.1:29070"), null);
    assert.equal(addressProblem(" 46.224.207.86:29070 "), null);
    assert.equal(addressProblem("1.1.1.1"), "shape");
    assert.equal(addressProblem("server.example.com:29070"), "shape");
    assert.equal(addressProblem("256.1.1.1:29070"), "shape");
    assert.equal(addressProblem("1.1.1.1:70000"), "shape");
    assert.equal(addressProblem("1.1.1.1:80"), "port");
    for (const local of ["127.0.0.1:29070", "192.168.1.5:29070", "10.0.0.2:29070", "172.20.0.1:29070", "100.64.1.1:29070", "203.0.113.20:29070", "0.1.2.3:29070", "239.1.1.1:29070"]) {
      assert.equal(addressProblem(local), "private", local);
    }
  });
});

describe("a picture from a file input", () => {
  const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const file = (bytes, name) => Object.assign(new Blob([bytes]), { name });

  test("the three types the service takes are told by their first bytes", () => {
    assert.equal(sniffImage(png()), "image/png");
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImage(new TextEncoder().encode("RIFF\x24\x00\x00\x00WEBPVP8 ")), "image/webp");
    assert.equal(sniffImage(new TextEncoder().encode("RIFF\x24\x00\x00\x00WAVEfmt ")), null);
    assert.equal(sniffImage(new TextEncoder().encode("GIF89a")), null, "the service refuses a GIF");
    assert.equal(sniffImage(new Uint8Array([])), null);
  });

  test("the hash is the SHA-256 of the bytes in lowercase hex", async () => {
    const bytes = new TextEncoder().encode("JKNet");
    assert.equal(await sha256Hex(bytes.buffer), createHash("sha256").update(bytes).digest("hex"));
  });

  test("a file over its limit or not a picture is refused before it is read", async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES.logo + 1);
    big.set(png());
    assert.deepEqual(await prepareImage(file(big, "big.png"), "logo"), {
      refused: { reason: "tooBig", fileName: "big.png", maxBytes: IMAGE_MAX_BYTES.logo },
    });
    const prepared = await prepareImage(file(big, "big.png"), "banner");
    assert.equal("image" in prepared && prepared.image.type, "image/png", "a cover may be three times as big");
    assert.deepEqual(await prepareImage(file(new TextEncoder().encode("hello"), "notes.png"), "logo"), {
      refused: { reason: "notPicture", fileName: "notes.png" },
    });
  });

  test("a picture goes to the store under its hash", async () => {
    const sent = [];
    const result = await uploadImageFile(file(png(), "logo.png"), "logo", async (sha256, blob) => {
      sent.push([sha256, blob.size, blob.type]);
    });
    const sha256 = createHash("sha256").update(png()).digest("hex");
    assert.deepEqual(sent, [[sha256, png().length, "image/png"]]);
    assert.equal("uploaded" in result && result.uploaded.sha256, sha256);
    assert.equal("uploaded" in result && result.uploaded.fileName, "logo.png");
    // A refusal sends nothing.
    await uploadImageFile(file(new TextEncoder().encode("hello"), "x.txt"), "logo", async () => {
      throw new Error("must not upload");
    });
  });
});

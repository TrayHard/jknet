/**
 * Tests for scripts/release-manifest.mjs.
 *
 * Most tests build a release folder of their own: a fresh Ed25519 key in the
 * minisign format the Tauri CLI writes, a few hundred bytes that stand in for
 * the installer and are signed with that key, the `.sig`, latest.json,
 * SHA256SUMS and a tauri.conf.json holding the key. One test uses a signature
 * the Tauri CLI made itself, so the format the other tests write cannot drift
 * away from the real one unnoticed.
 *
 * The script runs as a child process, the way the release workflow runs it,
 * so the tests see its exit code and its JSON report. Nothing goes to the
 * network.
 *
 * Usage: node --test scripts/release-manifest.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "release-manifest.mjs");

const VERSION = "1.2.3";
const INSTALLER = `JKNet_${VERSION}_x64-setup.exe`;
const REPO = "example-org/example-launcher";
const TAG = `v${VERSION}`;
const PUBLIC_PREFIX = `https://github.com/${REPO}/releases/download/${TAG}`;
const PUBLIC_URL = `${PUBLIC_PREFIX}/${INSTALLER}`;
/** The kind of address tauri-action writes: the API address of the asset. */
const ASSET_URL = `https://api.github.com/repos/${REPO}/releases/assets/123456789`;
const TRUSTED_COMMENT = `timestamp:1700000000\tfile:${INSTALLER}`;

/**
 * A file signed by `tauri signer sign` with a throwaway key from
 * `tauri signer generate`, whose private half is not in the repository and
 * signs nothing else. `pubkey` is the `.key.pub` of that key, which is the
 * form `plugins.updater.pubkey` takes, and `sig` is the `.sig` exactly as the
 * CLI wrote it.
 */
const TAURI_SIGNED = {
  version: "9.8.7",
  installer: "Known-answer stand-in for a JKNet installer.\n",
  keyId: "D3FB6591A1610149",
  trustedComment: "timestamp:1790278579\tfile:JKNet_9.8.7_x64-setup.exe",
  pubkey: [
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQzRkI2NTkxQTE2MTAx",
    "NDkKUldSSkFXR2hrV1g3MDl6WWpzeUduQ2RKdTcveGFvdFF3bjdKZlBvZmg5M09WV0JtcjVM",
    "WHEzYmgK",
  ].join(""),
  sig: [
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVS",
    "SkFXR2hrV1g3MDl6NktWTG0wNWR0VU1ncVVFYTlrREdIaXZFenpzSkQ2QjVvYkpMSG0yUStG",
    "MUdJNER1cVppc0gyMG1vaHFkRzVKSlI4Z1NqQWI5cC95SkIyLzRlWVFJPQp0cnVzdGVkIGNv",
    "bW1lbnQ6IHRpbWVzdGFtcDoxNzkwMjc4NTc5CWZpbGU6SktOZXRfOS44LjdfeDY0LXNldHVw",
    "LmV4ZQpabHlscDlFQlhWZ2s2TXluQ2l3R2MraCs5bEdOYWQwSjBxQ1c1VlVVcG5qSzB3b2hX",
    "RmZMeXVjQlJURDVoWElyTjNpRWVwTm1hbWxjK2NCZW9FM09Bdz09Cg==",
  ].join(""),
};

const folders = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const base64 = (text) => Buffer.from(text).toString("base64");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const installerFor = (version) => `JKNet_${version}_x64-setup.exe`;

/**
 * An Ed25519 key pair under a minisign key id, with the `pubkey` string a
 * tauri.conf.json holds for it: base64 of the minisign public key file.
 */
function makeKey(keyId = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // The raw key is the last 32 bytes of the SubjectPublicKeyInfo.
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const id = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
  const file =
    `untrusted comment: minisign public key: ${id}\n` +
    `${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  return { keyId, privateKey, pubkey: base64(file) };
}

/**
 * The text of a minisign signature file for `data`, laid out as the Tauri CLI
 * writes it. `prehashed` picks `ED`, a signature of the BLAKE2b-512 hash, over
 * `Ed`, a signature of the file itself.
 */
function minisignSignature(key, data, { prehashed = true, trustedComment = TRUSTED_COMMENT } = {}) {
  const message = prehashed ? createHash("blake2b512").update(data).digest() : data;
  const signature = sign(null, message, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key.privateKey);
  return [
    "untrusted comment: signature from tauri secret key",
    Buffer.concat([Buffer.from(prehashed ? "ED" : "Ed"), key.keyId, signature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

/**
 * Writes a release folder, and a tauri.conf.json next to it, the way the
 * release workflow downloads them. Every part can be swapped for the broken
 * variant a test needs; `sums: null` leaves SHA256SUMS out.
 */
function makeRelease({
  version = VERSION,
  key = makeKey(),
  configKey = key,
  pubkey = configKey.pubkey,
  installer = Buffer.from("MZ stand-in for the JKNet installer\n".repeat(16)),
  prehashed = true,
  signatureText = minisignSignature(key, installer, { prehashed }),
  sig = base64(signatureText),
  manifestVersion = version,
  url = `https://github.com/${REPO}/releases/download/v${version}/${installerFor(version)}`,
  sums = `${sha256(installer)}  ${installerFor(version)}\n`,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-manifest-"));
  folders.push(root);
  const dir = join(root, "assets");
  mkdirSync(dir);

  const name = installerFor(version);
  writeFileSync(join(dir, name), installer);
  writeFileSync(join(dir, `${name}.sig`), sig);
  const manifest = {
    version: manifestVersion,
    notes: "See the assets below to download and install JKNet.",
    pub_date: "2026-01-02T03:04:05.678Z",
    platforms: {
      "windows-x86_64": { signature: sig, url },
      "windows-x86_64-nsis": { signature: sig, url },
    },
  };
  // tauri-action writes the manifest without a final newline.
  writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2));
  if (sums !== null) writeFileSync(join(dir, "SHA256SUMS"), sums);

  const config = join(root, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ version, plugins: { updater: { pubkey } } }, null, 2));
  return { root, dir, config, name, key, installer, sig, manifest };
}

/** Flips one bit of the installer in the folder, after it was signed. */
function tamper(release) {
  const bytes = Buffer.from(release.installer);
  bytes[bytes.length >> 1] ^= 0x01;
  writeFileSync(join(release.dir, release.name), bytes);
}

/** Runs the script and parses the JSON report it prints on stdout. */
function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // A malformed command line prints usage instead of a report.
  }
  return { status: result.status, stderr: result.stderr, report };
}

const verify = (release, ...args) => run("verify", "--dir", release.dir, "--config", release.config, ...args);

const finalize = (release, ...args) =>
  run("finalize", "--dir", release.dir, "--config", release.config, "--repo", REPO, ...args);

test("verify accepts an installer signed by the updater key", () => {
  const release = makeRelease();
  const { status, stderr, report } = verify(release, "--version", VERSION, "--url-prefix", PUBLIC_PREFIX);
  assert.equal(status, 0, stderr);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks, {
    keyId: "ok",
    installerSignature: "ok",
    globalSignature: "ok",
    manifestVersion: "ok",
    platformSignatures: "ok",
    platformUrls: "ok",
    sha256sums: "ok",
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.signature.algorithm, "ED");
  assert.equal(report.signature.trustedComment, TRUSTED_COMMENT);
  assert.equal(report.signature.keyId, report.publicKey.keyId);
  assert.equal(report.installer.sha256, sha256(release.installer));
});

test("verify accepts a signature the Tauri CLI made", () => {
  const release = makeRelease({
    version: TAURI_SIGNED.version,
    installer: Buffer.from(TAURI_SIGNED.installer),
    sig: TAURI_SIGNED.sig,
    pubkey: TAURI_SIGNED.pubkey,
  });
  const { status, stderr, report } = verify(release);
  assert.equal(status, 0, stderr);
  assert.equal(report.publicKey.keyId, TAURI_SIGNED.keyId);
  assert.equal(report.signature.algorithm, "ED");
  assert.equal(report.signature.trustedComment, TAURI_SIGNED.trustedComment);

  tamper(release);
  const changed = verify(release);
  assert.equal(changed.status, 1);
  assert.equal(changed.report.checks.installerSignature, "failed");
});

test("verify accepts a legacy signature of the whole file", () => {
  const { status, stderr, report } = verify(makeRelease({ prehashed: false }));
  assert.equal(status, 0, stderr);
  assert.equal(report.signature.algorithm, "Ed");
  assert.equal(report.signature.prehashed, false);
});

test("verify takes the version from latest.json when --version is absent", () => {
  const { status, stderr, report } = verify(makeRelease());
  assert.equal(status, 0, stderr);
  assert.equal(report.version, VERSION);
  assert.equal(report.checks.platformUrls, "skipped");
});

test("verify rejects an installer changed after signing", () => {
  const release = makeRelease({ sums: null });
  tamper(release);
  const { status, stderr, report } = verify(release);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.checks.installerSignature, "failed");
  // The trusted comment is still the one that was signed.
  assert.equal(report.checks.globalSignature, "ok");
  assert.equal(report.checks.sha256sums, "absent");
  assert.match(stderr, /the signature in JKNet_1\.2\.3_x64-setup\.exe\.sig does not verify/);
});

test("verify rejects a signature made with another key", () => {
  // Another key id: the updater gives up before it looks at the signature.
  const stranger = verify(makeRelease({ configKey: makeKey() }));
  assert.equal(stranger.status, 1);
  assert.equal(stranger.report.checks.keyId, "failed");
  assert.equal(stranger.report.checks.installerSignature, "skipped");
  assert.equal(stranger.report.checks.globalSignature, "skipped");
  assert.match(stranger.stderr, /was made with key [0-9A-F]{16}, but the updater key is [0-9A-F]{16}/);

  // The same key id on another key: only the signatures give it away.
  const key = makeKey();
  const impostor = verify(makeRelease({ key, configKey: makeKey(key.keyId) }));
  assert.equal(impostor.status, 1);
  assert.equal(impostor.report.checks.keyId, "ok");
  assert.equal(impostor.report.checks.installerSignature, "failed");
  assert.equal(impostor.report.checks.globalSignature, "failed");
});

test("verify rejects a trusted comment changed after signing", () => {
  const key = makeKey();
  const installer = Buffer.from("MZ stand-in for the JKNet installer\n");
  const genuine = minisignSignature(key, installer);
  const altered = genuine.replace("timestamp:1700000000", "timestamp:1900000000");
  assert.notEqual(altered, genuine);

  const { status, stderr, report } = verify(makeRelease({ key, installer, signatureText: altered }));
  assert.equal(status, 1);
  assert.equal(report.checks.installerSignature, "ok");
  assert.equal(report.checks.globalSignature, "failed");
  assert.equal(report.signature.trustedComment, `timestamp:1900000000\tfile:${INSTALLER}`);
  assert.match(stderr, /the global signature in JKNet_1\.2\.3_x64-setup\.exe\.sig does not verify/);
});

test("verify rejects latest.json of another version", () => {
  const release = makeRelease({ manifestVersion: "1.2.4" });
  const asked = verify(release, "--version", VERSION);
  assert.equal(asked.status, 1);
  assert.equal(asked.report.checks.manifestVersion, "failed");
  assert.match(asked.stderr, /latest\.json has version 1\.2\.4, expected 1\.2\.3/);

  // Without --version, latest.json names an installer the folder does not have.
  const implied = verify(release);
  assert.equal(implied.status, 1);
  assert.match(implied.stderr, /installer not found: .*JKNet_1\.2\.4_x64-setup\.exe/);
});

test("verify rejects a url other than the public download address", () => {
  const release = makeRelease({ url: ASSET_URL });
  const checked = verify(release, "--url-prefix", PUBLIC_PREFIX);
  assert.equal(checked.status, 1);
  assert.equal(checked.report.checks.platformUrls, "failed");
  assert.match(checked.stderr, /platform windows-x86_64: the url is https:\/\/api\.github\.com\//);
  assert.match(checked.stderr, /platform windows-x86_64-nsis: the url is https:\/\/api\.github\.com\//);

  // Without --url-prefix the address is not checked.
  const unchecked = verify(release);
  assert.equal(unchecked.status, 0, unchecked.stderr);
  assert.equal(unchecked.report.checks.platformUrls, "skipped");
});

test("verify rejects a SHA256SUMS that does not match the installer", () => {
  const wrong = verify(makeRelease({ sums: `${"0".repeat(64)}  ${INSTALLER}\n` }));
  assert.equal(wrong.status, 1);
  assert.equal(wrong.report.checks.sha256sums, "failed");
  assert.match(wrong.stderr, /SHA256SUMS gives JKNet_1\.2\.3_x64-setup\.exe the sha256 0{64}, but the file has/);

  const elsewhere = verify(makeRelease({ sums: `${sha256(Buffer.from("x"))}  notes.txt\n` }));
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stderr, /SHA256SUMS lists notes\.txt, which is not in the folder/);
  assert.match(elsewhere.stderr, /SHA256SUMS has no line for JKNet_1\.2\.3_x64-setup\.exe/);
});

test("verify rejects latest.json whose signature is not the .sig", () => {
  const release = makeRelease();
  const manifest = structuredClone(release.manifest);
  manifest.platforms["windows-x86_64-nsis"].signature = base64(
    minisignSignature(release.key, Buffer.from("another file")),
  );
  writeFileSync(join(release.dir, "latest.json"), JSON.stringify(manifest, null, 2));

  const { status, stderr, report } = verify(release);
  assert.equal(status, 1);
  assert.equal(report.checks.platformSignatures, "failed");
  assert.match(stderr, /platform windows-x86_64-nsis: the signature differs from/);
  assert.doesNotMatch(stderr, /platform windows-x86_64:/);
});

test("verify names a missing file instead of failing on it", () => {
  const release = makeRelease();
  rmSync(join(release.dir, `${INSTALLER}.sig`));
  const unsigned = verify(release);
  assert.equal(unsigned.status, 1);
  assert.equal(unsigned.report.ok, false);
  assert.match(unsigned.stderr, /signature file not found: .*JKNet_1\.2\.3_x64-setup\.exe\.sig/);

  // A file where the folder should be.
  const misplaced = run("verify", "--dir", join(release.dir, INSTALLER), "--config", release.config);
  assert.equal(misplaced.status, 1);
  assert.match(misplaced.stderr, /latest\.json not found/);
});

test("finalize points every platform at the public address and writes SHA256SUMS", () => {
  const release = makeRelease({ url: ASSET_URL, sums: null });
  const notes = join(release.root, "notes.md");
  writeFileSync(notes, "\uFEFFFaster server list.\r\nFixed the friends panel.  \r\n\r\n");

  const { status, stderr, report } = finalize(release, "--tag", TAG, "--notes-file", notes);
  assert.equal(status, 0, stderr);
  assert.equal(report.ok, true);
  assert.equal(report.checks.platformUrls, "ok");
  assert.equal(report.finalized.url, PUBLIC_URL);
  assert.equal(report.finalized.notes, "replaced");

  // Only the addresses and the notes change: signatures, version and date stay.
  assert.deepEqual(JSON.parse(readFileSync(join(release.dir, "latest.json"), "utf8")), {
    ...release.manifest,
    notes: "Faster server list.\nFixed the friends panel.",
    platforms: {
      "windows-x86_64": { signature: release.sig, url: PUBLIC_URL },
      "windows-x86_64-nsis": { signature: release.sig, url: PUBLIC_URL },
    },
  });
  assert.equal(
    readFileSync(join(release.dir, "SHA256SUMS"), "utf8"),
    `${sha256(release.installer)}  ${INSTALLER}\n`,
  );

  // What finalize leaves behind passes verify on its own.
  const again = verify(release, "--version", VERSION, "--url-prefix", PUBLIC_PREFIX);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.report.checks.sha256sums, "ok");
});

test("finalize keeps the notes without --notes-file and changes nothing on a second run", () => {
  const release = makeRelease({ url: ASSET_URL, sums: null });
  const first = finalize(release, "--tag", TAG);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.report.finalized.notes, "kept");
  const manifest = readFileSync(join(release.dir, "latest.json"), "utf8");
  const sums = readFileSync(join(release.dir, "SHA256SUMS"), "utf8");
  assert.equal(JSON.parse(manifest).notes, release.manifest.notes);

  const second = finalize(release, "--tag", TAG);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(release.dir, "latest.json"), "utf8"), manifest);
  assert.equal(readFileSync(join(release.dir, "SHA256SUMS"), "utf8"), sums);
});

test("finalize fails when the installer signature does not verify", () => {
  const release = makeRelease({ url: ASSET_URL, sums: null });
  tamper(release);
  const { status, report } = finalize(release, "--tag", TAG);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.checks.installerSignature, "failed");
});

test("finalize refuses a tag of another version and leaves the folder alone", () => {
  const release = makeRelease({ url: ASSET_URL, sums: null });
  const before = readFileSync(join(release.dir, "latest.json"), "utf8");
  const { status, stderr } = finalize(release, "--tag", "v1.2.4");
  assert.equal(status, 1);
  assert.match(stderr, /--tag v1\.2\.4 does not match version 1\.2\.3 in latest\.json/);
  assert.equal(readFileSync(join(release.dir, "latest.json"), "utf8"), before);
  assert.equal(existsSync(join(release.dir, "SHA256SUMS")), false);
});

test("a malformed command line exits 2", () => {
  const release = makeRelease();
  const cases = [
    [],
    ["publish", "--dir", release.dir],
    ["verify"],
    ["verify", "--dir", release.dir, "--tag", TAG],
    ["verify", "--dir", release.dir, "--version", "1.2"],
    ["verify", "--dir", release.dir, "stray"],
    ["verify", "--dir", release.dir, "--url-prefix="],
    ["finalize", "--dir", release.dir, "--repo", REPO],
    ["finalize", "--dir", release.dir, "--repo", "example-launcher", "--tag", TAG],
    ["finalize", "--dir", release.dir, "--repo", REPO, "--tag", VERSION],
  ];
  for (const args of cases) {
    const { status, report } = run(...args);
    assert.equal(status, 2, `release-manifest ${args.join(" ")}`);
    assert.equal(report, null);
  }
});

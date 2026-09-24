#!/usr/bin/env node
/**
 * Checks and completes the update files of a JKNet release.
 *
 * The release workflow builds the installer with tauri-action, which attaches
 * three files to a draft release: `JKNet_<version>_x64-setup.exe`, its `.sig`
 * and `latest.json`, the manifest the updater of an installed launcher reads.
 * tauri-action points every `url` in that manifest at the API address of the
 * asset, `https://api.github.com/repos/OWNER/REPO/releases/assets/<id>`. The
 * updater gets the installer there only because it sends
 * `Accept: application/octet-stream`; a browser gets a JSON description of the
 * asset instead. Earlier releases carried the public download address, and
 * `finalize` puts it back.
 *
 * Commands:
 *
 *   verify    Checks a folder that holds the installer, its `.sig` and
 *             latest.json. The installer has to carry a valid minisign
 *             signature by the updater key in tauri.conf.json. latest.json
 *             has to name the version, repeat the `.sig` in every platform
 *             and, with --url-prefix, send every platform to
 *             PREFIX/<installer>. A SHA256SUMS in the folder has to match the
 *             files it lists.
 *   finalize  Points the `url` of every platform at
 *             https://github.com/OWNER/REPO/releases/download/TAG/<installer>,
 *             replaces `notes` with the text of --notes-file when one is
 *             given, writes SHA256SUMS and then runs `verify` on the result.
 *             The signatures and every other field stay as they were.
 *
 * Usage:
 *   node scripts/release-manifest.mjs verify --dir DIR [--version X.Y.Z]
 *       [--url-prefix PREFIX] [--config FILE]
 *   node scripts/release-manifest.mjs finalize --dir DIR --repo OWNER/REPO
 *       --tag vX.Y.Z [--notes-file FILE] [--config FILE]
 *
 * --config defaults to src-tauri/tauri.conf.json of this repository. Both
 * commands print a JSON report on stdout. A mismatch exits 1 and names every
 * problem on stderr; a malformed command line exits 2.
 *
 * Node 20 or later, no dependencies: node:crypto has Ed25519 and BLAKE2b-512,
 * which is all a minisign signature needs.
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = join(ROOT, "src-tauri", "tauri.conf.json");

const MANIFEST = "latest.json";
const CHECKSUMS = "SHA256SUMS";

/**
 * A release version: three numbers and an optional pre-release part. Build
 * metadata is refused: GitHub turns the `+` of an asset name into `.`, and the
 * installer would no longer be where the manifest says it is.
 */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** OWNER/REPO, in the characters GitHub allows, none of which a URL escapes. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A line of `sha256sum` output: the hash, a space, ` ` or `*`, the name. */
const CHECKSUM_LINE = /^([0-9A-Fa-f]{64}) [ *](.+)$/;

/** The DER header that makes a raw Ed25519 key a SubjectPublicKeyInfo. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

const UNTRUSTED_COMMENT = "untrusted comment:";
const TRUSTED_COMMENT = "trusted comment: ";

/** A problem with the release files: exit code 1. */
class ReleaseError extends Error {}

/** A problem with the command line: exit code 2. */
class UsageError extends Error {}

/** The name Tauri gives the NSIS installer of a version. */
function installerName(version) {
  return `JKNet_${version}_x64-setup.exe`;
}

/** The error codes of a path that leads nowhere: no file, or a file in place of a folder. */
function isMissing(error) {
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/**
 * Reads a file the check cannot go without. A missing file is a problem of the
 * release and gets a readable message; any other failure propagates.
 */
function readRequired(path, what) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isMissing(error)) throw new ReleaseError(`${what} not found: ${path}`);
    throw error;
  }
}

/** Reads a file that may be absent: null when it is. */
function readOptional(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Decodes base64 as strictly as the updater does: standard alphabet, padding,
 * no whitespace. `Buffer.from` silently skips what it does not understand, so
 * the bytes are encoded again and have to give back the input.
 */
function decodeBase64(text, what) {
  if (text === "") throw new ReleaseError(`${what} is empty`);
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) throw new ReleaseError(`${what} is not canonical base64`);
  return bytes;
}

/** Decodes UTF-8 and, like the updater, refuses bytes that are not UTF-8. */
function decodeUtf8(bytes, what) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ReleaseError(`${what} is not UTF-8 text`);
  }
}

/** Splits at `\n` or `\r\n`, as `str::lines` does in the updater's minisign-verify. */
function splitLines(text) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** minisign prints a key id as a little-endian 64-bit number in hex. */
function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/**
 * Parses a minisign public key file: an untrusted comment line, then base64 of
 * the algorithm `Ed`, the 8-byte key id and the 32-byte Ed25519 key.
 */
function parsePublicKey(text, source) {
  const [comment, line] = splitLines(text);
  if (!comment?.startsWith(UNTRUSTED_COMMENT) || line === undefined) {
    throw new ReleaseError(`${source} is not a minisign public key: expected a comment line and a key line`);
  }
  const raw = decodeBase64(line, `the key line of ${source}`);
  if (raw.length !== 42) {
    throw new ReleaseError(`the key line of ${source} holds ${raw.length} bytes, expected 42`);
  }
  if (raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new ReleaseError(`${source} is not an Ed25519 key: its algorithm is 0x${raw.subarray(0, 2).toString("hex")}`);
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

/**
 * Parses a minisign signature file:
 *
 *   untrusted comment: <anything>
 *   base64 of the algorithm (2 bytes), the key id (8) and the signature (64)
 *   trusted comment: <text>
 *   base64 of the global signature (64 bytes)
 *
 * The algorithm `ED` signs the BLAKE2b-512 hash of the file and `Ed` the file
 * itself. The global signature covers the signature bytes followed by the
 * trusted comment, so the comment cannot change without breaking it.
 */
function parseSignature(text, source) {
  const [comment, line, trusted, globalLine] = splitLines(text);
  if (!comment?.startsWith(UNTRUSTED_COMMENT)) {
    throw new ReleaseError(`${source} is not a minisign signature: the first line is not an untrusted comment`);
  }
  if (line === undefined) throw new ReleaseError(`${source} has no signature line`);
  const raw = decodeBase64(line, `the signature line of ${source}`);
  if (raw.length !== 74) {
    throw new ReleaseError(`the signature line of ${source} holds ${raw.length} bytes, expected 74`);
  }
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") {
    throw new ReleaseError(`${source} uses an unknown algorithm 0x${raw.subarray(0, 2).toString("hex")}`);
  }
  if (!trusted?.startsWith(TRUSTED_COMMENT)) throw new ReleaseError(`${source} has no trusted comment line`);
  if (globalLine === undefined) throw new ReleaseError(`${source} has no global signature line`);
  const globalSignature = decodeBase64(globalLine, `the global signature line of ${source}`);
  if (globalSignature.length !== 64) {
    throw new ReleaseError(
      `the global signature line of ${source} holds ${globalSignature.length} bytes, expected 64`,
    );
  }
  return {
    algorithm,
    prehashed: algorithm === "ED",
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trusted.slice(TRUSTED_COMMENT.length),
    globalSignature,
  };
}

function ed25519PublicKey(raw, source) {
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
  } catch (error) {
    throw new ReleaseError(`${source} is not a usable Ed25519 key: ${error.message}`);
  }
}

/**
 * Reads latest.json and checks the shape the updater relies on: a version
 * string and at least one platform with a `signature` and a `url`.
 */
function readManifest(path) {
  const bytes = readRequired(path, MANIFEST);
  // The updater parses with serde_json, which stops at a byte order mark.
  // JSON.parse stops there too, but with a message that does not say why.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new ReleaseError(`${path} starts with a byte order mark, which the updater cannot parse`);
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ReleaseError(`${path} is not valid JSON: ${error.message}`);
  }
  if (!isObject(manifest) || typeof manifest.version !== "string") {
    throw new ReleaseError(`${path} has no version string`);
  }
  if (!isObject(manifest.platforms) || Object.keys(manifest.platforms).length === 0) {
    throw new ReleaseError(`${path} lists no platforms`);
  }
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!isObject(entry) || typeof entry.signature !== "string" || typeof entry.url !== "string") {
      throw new ReleaseError(`${path}: platform ${platform} needs a signature string and a url string`);
    }
  }
  return manifest;
}

/** The `plugins.updater.pubkey` string of a Tauri configuration file. */
function readUpdaterKey(path) {
  const bytes = readRequired(path, "Tauri configuration");
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ReleaseError(`${path} is not valid JSON: ${error.message}`);
  }
  const pubkey = config?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || pubkey === "") {
    throw new ReleaseError(`${path} has no plugins.updater.pubkey`);
  }
  return pubkey;
}

/**
 * Checks SHA256SUMS the way `sha256sum --check` does, and in addition that it
 * lists the installer exactly once. A name with a path in it is refused: the
 * file describes its neighbours and nothing else.
 */
function checksumProblems(text, dir, installer, installerSha256) {
  const problems = [];
  let installerLines = 0;
  for (const [index, line] of splitLines(text).entries()) {
    if (line === "") continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match === null) {
      problems.push(`${CHECKSUMS} line ${index + 1} is not "<sha256>  <file name>": ${JSON.stringify(line)}`);
      continue;
    }
    const listed = match[1].toLowerCase();
    const name = match[2];
    if (/[\\/]/.test(name) || name === "." || name === "..") {
      problems.push(`${CHECKSUMS} line ${index + 1} names a path instead of a file in the folder: ${name}`);
      continue;
    }
    let actual;
    if (name === installer) {
      installerLines += 1;
      actual = installerSha256;
    } else {
      let bytes;
      try {
        bytes = readOptional(join(dir, name));
      } catch (error) {
        problems.push(`${CHECKSUMS} lists ${name}, which cannot be read: ${error.message}`);
        continue;
      }
      if (bytes === null) {
        problems.push(`${CHECKSUMS} lists ${name}, which is not in the folder`);
        continue;
      }
      actual = sha256(bytes);
    }
    if (listed !== actual) {
      problems.push(`${CHECKSUMS} gives ${name} the sha256 ${listed}, but the file has ${actual}`);
    }
  }
  if (installerLines === 0) problems.push(`${CHECKSUMS} has no line for ${installer}`);
  if (installerLines > 1) problems.push(`${CHECKSUMS} lists ${installer} ${installerLines} times`);
  return problems;
}

/**
 * Checks the release in `dir` and returns the report. A missing or unreadable
 * input ends the checks at once; past that point every check runs, so a single
 * report names every mismatch.
 */
function verifyRelease({ dir, version: requestedVersion, urlPrefix, config }) {
  const report = {
    command: "verify",
    ok: false,
    dir,
    config,
    version: null,
    installer: null,
    signature: null,
    publicKey: null,
    platforms: null,
    checks: {},
    errors: [],
  };
  const record = (check, problems) => {
    report.checks[check] = problems.length === 0 ? "ok" : "failed";
    report.errors.push(...problems);
  };

  try {
    const manifest = readManifest(join(dir, MANIFEST));
    const version = requestedVersion ?? manifest.version;
    if (!VERSION.test(version)) {
      throw new ReleaseError(`${MANIFEST} has version ${JSON.stringify(version)}, which is not X.Y.Z or X.Y.Z-pre`);
    }
    report.version = version;
    report.platforms = Object.fromEntries(
      Object.entries(manifest.platforms).map(([platform, entry]) => [platform, entry.url]),
    );

    const name = installerName(version);
    const installer = readRequired(join(dir, name), "installer");
    const installerSha256 = sha256(installer);
    report.installer = { name, bytes: installer.length, sha256: installerSha256 };

    // The `.sig` Tauri writes is base64 of the minisign signature file, and
    // latest.json carries that base64 as it is.
    const sigName = `${name}.sig`;
    const sig = readRequired(join(dir, sigName), "signature file").toString("utf8").trim();
    const signature = parseSignature(decodeUtf8(decodeBase64(sig, sigName), sigName), sigName);
    report.signature = {
      algorithm: signature.algorithm,
      prehashed: signature.prehashed,
      keyId: keyIdHex(signature.keyId),
      trustedComment: signature.trustedComment,
    };

    // tauri.conf.json holds base64 of the minisign public key file.
    const keySource = `plugins.updater.pubkey of ${config}`;
    const publicKey = parsePublicKey(
      decodeUtf8(decodeBase64(readUpdaterKey(config), keySource), keySource),
      keySource,
    );
    report.publicKey = { keyId: keyIdHex(publicKey.keyId) };

    // The steps of minisign and of the updater, in their order: the key id
    // picks the key, the signature covers the file, and the global signature
    // covers the signature and the trusted comment.
    if (!signature.keyId.equals(publicKey.keyId)) {
      record("keyId", [
        `${sigName} was made with key ${report.signature.keyId}, but the updater key is ${report.publicKey.keyId}`,
      ]);
      report.checks.installerSignature = "skipped";
      report.checks.globalSignature = "skipped";
    } else {
      record("keyId", []);
      const key = ed25519PublicKey(publicKey.key, keySource);
      const signed = signature.prehashed ? createHash("blake2b512").update(installer).digest() : installer;
      record(
        "installerSignature",
        verify(null, signed, key, signature.signature)
          ? []
          : [`the signature in ${sigName} does not verify: ${name} is not the file key ${report.publicKey.keyId} signed`],
      );
      const covered = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")]);
      record(
        "globalSignature",
        verify(null, covered, key, signature.globalSignature)
          ? []
          : [
              `the global signature in ${sigName} does not verify: its trusted comment is not the one key ${report.publicKey.keyId} signed`,
            ],
      );
    }

    record(
      "manifestVersion",
      manifest.version === version ? [] : [`${MANIFEST} has version ${manifest.version}, expected ${version}`],
    );

    const signatureProblems = [];
    for (const [platform, entry] of Object.entries(manifest.platforms)) {
      if (entry.signature === sig) continue;
      signatureProblems.push(
        entry.signature.trim() === sig
          ? `${MANIFEST} platform ${platform}: the signature has whitespace around it, which the updater's base64 decoder refuses`
          : `${MANIFEST} platform ${platform}: the signature differs from ${sigName}`,
      );
    }
    record("platformSignatures", signatureProblems);

    if (urlPrefix === undefined) {
      report.checks.platformUrls = "skipped";
    } else {
      const expected = `${urlPrefix.replace(/\/+$/, "")}/${name}`;
      record(
        "platformUrls",
        Object.entries(manifest.platforms)
          .filter(([, entry]) => entry.url !== expected)
          .map(([platform, entry]) => `${MANIFEST} platform ${platform}: the url is ${entry.url}, expected ${expected}`),
      );
    }

    const sums = readOptional(join(dir, CHECKSUMS));
    if (sums === null) {
      report.checks.sha256sums = "absent";
    } else {
      record("sha256sums", checksumProblems(sums.toString("utf8"), dir, name, installerSha256));
    }
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    report.errors.push(error.message);
  }

  report.ok = report.errors.length === 0;
  return report;
}

/**
 * The text of a notes file as `notes` takes it: no byte order mark, `\n` line
 * ends, nothing blank at the end.
 */
function readNotes(path) {
  const text = readRequired(path, "notes file").toString("utf8");
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Rewrites latest.json in `dir` for publication, writes SHA256SUMS and returns
 * the report of `verify` on the result together with what changed.
 */
function finalizeRelease({ dir, repo, tag, notesFile, config }) {
  const manifestPath = join(dir, MANIFEST);
  const manifest = readManifest(manifestPath);
  // The download address is built from the tag and the installer name from
  // the version, so the two have to describe the same release.
  if (tag !== `v${manifest.version}`) {
    throw new ReleaseError(
      `--tag ${tag} does not match version ${manifest.version} in ${MANIFEST}: expected v${manifest.version}`,
    );
  }
  const version = manifest.version;
  const name = installerName(version);
  const installer = readRequired(join(dir, name), "installer");

  // The address previous releases carried. It opens in a browser as well, and
  // the updater follows its redirect to the file storage.
  const urlPrefix = `https://github.com/${repo}/releases/download/${tag}`;
  const url = `${urlPrefix}/${name}`;
  const platforms = {};
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    platforms[platform] = { from: entry.url, to: url };
    entry.url = url;
  }
  if (notesFile !== undefined) manifest.notes = readNotes(notesFile);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const sums = `${sha256(installer)}  ${name}\n`;
  writeFileSync(join(dir, CHECKSUMS), sums);

  return {
    ...verifyRelease({ dir, version, urlPrefix, config }),
    command: "finalize",
    finalized: {
      repo,
      tag,
      url,
      platforms,
      notes: notesFile === undefined ? "kept" : "replaced",
      sha256sums: sums.trimEnd(),
    },
  };
}

const USAGE = `Usage:
  node scripts/release-manifest.mjs verify --dir DIR [--version X.Y.Z]
      [--url-prefix PREFIX] [--config FILE]
  node scripts/release-manifest.mjs finalize --dir DIR --repo OWNER/REPO
      --tag vX.Y.Z [--notes-file FILE] [--config FILE]

--config defaults to src-tauri/tauri.conf.json of this repository.
`;

const COMMANDS = {
  verify: {
    options: ["dir", "version", "url-prefix", "config"],
    required: ["dir"],
    run: (values) =>
      verifyRelease({
        dir: resolve(values.dir),
        version: values.version,
        urlPrefix: values["url-prefix"],
        config: resolve(values.config ?? DEFAULT_CONFIG),
      }),
  },
  finalize: {
    options: ["dir", "repo", "tag", "notes-file", "config"],
    required: ["dir", "repo", "tag"],
    run: (values) =>
      finalizeRelease({
        dir: resolve(values.dir),
        repo: values.repo,
        tag: values.tag,
        notesFile: values["notes-file"] === undefined ? undefined : resolve(values["notes-file"]),
        config: resolve(values.config ?? DEFAULT_CONFIG),
      }),
  },
};

function parseCommandLine(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("no command given");
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  const spec = COMMANDS[command];
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: Object.fromEntries(spec.options.map((option) => [option, { type: "string" }])),
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  for (const [option, value] of Object.entries(values)) {
    if (value === "") throw new UsageError(`--${option} needs a value`);
  }
  for (const option of spec.required) {
    if (values[option] === undefined) throw new UsageError(`${command} needs --${option}`);
  }
  if (values.version !== undefined && !VERSION.test(values.version)) {
    throw new UsageError(`--version ${values.version} is not X.Y.Z or X.Y.Z-pre`);
  }
  if (values.tag !== undefined && !(values.tag.startsWith("v") && VERSION.test(values.tag.slice(1)))) {
    throw new UsageError(`--tag ${values.tag} is not vX.Y.Z or vX.Y.Z-pre`);
  }
  if (values.repo !== undefined && !REPOSITORY.test(values.repo)) {
    throw new UsageError(`--repo ${values.repo} is not OWNER/REPO`);
  }
  return { command, spec, values };
}

/** One line for the log of a run that passed. */
function summary(report) {
  const platforms = Object.keys(report.platforms).length;
  const urls = report.checks.platformUrls === "ok" ? ` at ${Object.values(report.platforms)[0]}` : "";
  const sums = report.checks.sha256sums === "ok" ? "SHA256SUMS matches" : "no SHA256SUMS";
  return (
    `${report.command} passed: ${report.installer.name} is signed by updater key ${report.publicKey.keyId}, ` +
    `latest.json ${report.version} lists ${platforms} platform(s)${urls}, ${sums}`
  );
}

function main(argv) {
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  let parsed;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`release-manifest: ${error.message}\n\n${USAGE}`);
    return 2;
  }

  let report;
  try {
    report = parsed.spec.run(parsed.values);
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    report = { command: parsed.command, ok: false, errors: [error.message] };
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    for (const message of report.errors) process.stderr.write(`release-manifest: ${message}\n`);
    return 1;
  }
  process.stderr.write(`release-manifest: ${summary(report)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

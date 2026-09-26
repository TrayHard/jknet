/**
 * Tests for src/lib/chatLive.ts: how the end of a download is kept, so an
 * answer of the core that was asked for before the end cannot replace it.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { chatLive } from "./chatLive.ts";

describe("download ends", () => {
  beforeEach(() => chatLive.reset());

  test("progress is kept until the last event, which records how it ended", () => {
    chatLive.setDownload({ fileId: "f1", received: 10, total: 100, path: null, status: "downloading" });
    assert.equal(chatLive.download("f1")?.received, 10);
    assert.equal(chatLive.downloadEnd("f1"), undefined);

    chatLive.setDownload({ fileId: "f1", received: 100, total: 100, path: "C:/cache/f1", status: "cached" });
    assert.equal(chatLive.download("f1"), undefined);
    assert.deepEqual(
      { status: chatLive.downloadEnd("f1")?.status, path: chatLive.downloadEnd("f1")?.path },
      { status: "cached", path: "C:/cache/f1" },
    );
  });

  test("an end after the mark wins over the answer; one before it does not", () => {
    chatLive.setDownload({ fileId: "f1", received: 0, total: 100, path: null, status: "remote" });
    const mark = chatLive.downloadMark();
    assert.equal(chatLive.downloadEndedSince("f1", mark), null);

    chatLive.setDownload({ fileId: "f1", received: 0, total: 100, path: null, status: "remote" });
    assert.equal(chatLive.downloadEndedSince("f1", mark)?.status, "remote");
    assert.equal(chatLive.downloadEndedSince("f2", mark), null);
  });

  test("a gone file keeps no path, and sign-out forgets every end", () => {
    chatLive.setDownload({ fileId: "f3", received: 0, total: 0, path: null, status: "gone" });
    assert.equal(chatLive.downloadEnd("f3")?.path, null);
    chatLive.reset();
    assert.equal(chatLive.downloadEnd("f3"), undefined);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { serverInstanceConnectTarget } from "./serverInstanceConnect.ts";

describe("server instance connection target", () => {
  test("keeps the game and joins the instance port through loopback", () => {
    assert.deepEqual(
      serverInstanceConnectTarget({ game: "ja", name: "JA+ with friends", port: 29072 }),
      {
        game: "ja",
        address: "127.0.0.1:29072",
        hostnameClean: "JA+ with friends",
      },
    );
  });
});

/**
 * Tests for src/components/community/catalogVisibility.ts: whether the
 * catalogue lists a community, read off its card as the service's
 * `IN_CATALOG` reads its rows, the rules a community misses, and what a row
 * of My communities offers its reader.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { catalogRemedy, catalogVisibility, inCatalog, isPublicServer } from "./catalogVisibility.ts";

const COMMUNITY = "01K6SWJKA00000000000000000";
const OTHER_SERVER = "01K6SRVDUEL000000000000000";
const OWNER = "01K6OWNER00000000000000000";

/** A server of the community; `id` is the community's for the founding server. */
function server(id, verified) {
  return {
    id,
    game: "ja",
    address: "203.0.113.15:29070",
    label: "",
    position: 0,
    verified,
    verifiedAt: verified ? "2026-09-20T12:00:00Z" : null,
  };
}

function card(patch = {}) {
  return { id: COMMUNITY, ownerId: OWNER, listed: false, servers: [server(COMMUNITY, true)], ...patch };
}

describe("in the catalogue", () => {
  test("an owner and a verified server", () => {
    assert.deepEqual(catalogVisibility(card()), { inCatalog: true, gaps: [], publishable: false });
  });

  test("an owner and a verified server that is not the founding one", () => {
    assert.equal(inCatalog(card({ servers: [server(OTHER_SERVER, true)] })), true);
  });

  test("listed without an owner: the founding server shows before it is verified", () => {
    assert.deepEqual(catalogVisibility(card({ ownerId: null, listed: true, servers: [server(COMMUNITY, false)] })), {
      inCatalog: true,
      gaps: [],
      publishable: false,
    });
  });

  test("listed without an owner, with a verified server added later", () => {
    assert.equal(inCatalog(card({ ownerId: null, listed: true, servers: [server(OTHER_SERVER, true)] })), true);
  });

  test("a listing of an owned community changes nothing", () => {
    assert.equal(inCatalog(card({ listed: true })), true);
  });
});

describe("out of the catalogue", () => {
  test("a page an administrator created: verified server, no owner, not listed", () => {
    // The page of the question of 2026-10-01: in My communities, not in the catalogue.
    assert.deepEqual(catalogVisibility(card({ ownerId: null, listed: false, servers: [server(COMMUNITY, true)] })), {
      inCatalog: false,
      gaps: ["unlisted"],
      publishable: true,
    });
  });

  test("a page a player created and has not confirmed", () => {
    assert.deepEqual(catalogVisibility(card({ ownerId: null, servers: [server(COMMUNITY, false)] })).gaps, ["unlisted"]);
  });

  test("an owner whose servers all wait for their proof", () => {
    const visibility = catalogVisibility(card({ servers: [server(OTHER_SERVER, false), server(COMMUNITY, false)] }));
    // The founding server counts only while nobody owns the community.
    assert.deepEqual(visibility, { inCatalog: false, gaps: ["noPublicServer"], publishable: false });
  });

  test("an owner without servers, listed or not", () => {
    assert.deepEqual(catalogVisibility(card({ servers: [] })).gaps, ["noPublicServer"]);
    assert.deepEqual(catalogVisibility(card({ servers: [], listed: true })).gaps, ["noPublicServer"]);
  });

  test("listed without an owner, the founding server gone and the rest not verified", () => {
    assert.deepEqual(catalogVisibility(card({ ownerId: null, listed: true, servers: [server(OTHER_SERVER, false)] })), {
      inCatalog: false,
      gaps: ["noPublicServer"],
      publishable: false,
    });
  });

  test("no owner, not listed and no server everyone sees: both gaps, in the order of the rule", () => {
    assert.deepEqual(catalogVisibility(card({ ownerId: null, servers: [server(OTHER_SERVER, false)] })), {
      inCatalog: false,
      gaps: ["unlisted", "noPublicServer"],
      publishable: true,
    });
  });

  test("a card of a service from before the listing reads as not listed", () => {
    const { listed: _listed, ...older } = card({ ownerId: null });
    assert.deepEqual(catalogVisibility(older).gaps, ["unlisted"]);
  });

  test("an empty owner id is no owner", () => {
    assert.deepEqual(catalogVisibility(card({ ownerId: "" })).gaps, ["unlisted"]);
  });
});

describe("servers everyone sees", () => {
  test("a verified server, owned or not", () => {
    assert.equal(isPublicServer(card(), server(OTHER_SERVER, true)), true);
    assert.equal(isPublicServer(card({ ownerId: null }), server(OTHER_SERVER, true)), true);
  });

  test("the founding server only while nobody owns the community", () => {
    assert.equal(isPublicServer(card({ ownerId: null }), server(COMMUNITY, false)), true);
    assert.equal(isPublicServer(card(), server(COMMUNITY, false)), false);
  });

  test("another server not verified, never", () => {
    assert.equal(isPublicServer(card({ ownerId: null }), server(OTHER_SERVER, false)), false);
    assert.equal(isPublicServer(card(), server(OTHER_SERVER, false)), false);
  });
});

describe("the rule of the service, every case", () => {
  // `IN_CATALOG` of community/store.rs, word for word:
  // (owner_id IS NOT NULL OR listed = 1) AND EXISTS (SELECT 1 FROM community_servers s
  //   WHERE s.community_id = communities.id
  //   AND (s.verified_at IS NOT NULL OR (owner_id IS NULL AND s.id = communities.id)))
  function service(row) {
    return (
      (row.ownerId !== null || row.listed) &&
      row.servers.some((s) => s.verified || (row.ownerId === null && s.id === row.id))
    );
  }

  const kinds = [server(COMMUNITY, true), server(COMMUNITY, false), server(OTHER_SERVER, true), server(OTHER_SERVER, false)];
  const sets = [];
  for (let mask = 0; mask < 1 << kinds.length; mask += 1) {
    // One founding server at most: the two founding kinds are one server, verified or not.
    if ((mask & 0b11) === 0b11) continue;
    sets.push(kinds.filter((_, index) => mask & (1 << index)));
  }

  for (const ownerId of [OWNER, null]) {
    for (const listed of [false, true]) {
      test(`owner ${ownerId ? "set" : "none"}, listed ${listed}`, () => {
        for (const servers of sets) {
          const row = { id: COMMUNITY, ownerId, listed, servers };
          const visibility = catalogVisibility(row);
          const label = JSON.stringify(servers.map((s) => [s.id === COMMUNITY ? "founding" : "other", s.verified]));
          assert.equal(visibility.inCatalog, service(row), label);
          assert.equal(visibility.inCatalog, visibility.gaps.length === 0, label);
          assert.equal(visibility.publishable, ownerId === null && !listed, label);
        }
      });
    }
  }
});

describe("what a row offers", () => {
  const admin = { admin: true, canManage: true };
  const player = { admin: false, canManage: true };

  test("nothing while the community is in", () => {
    assert.equal(catalogRemedy(catalogVisibility(card()), admin), null);
    assert.equal(catalogRemedy(catalogVisibility(card()), player), null);
  });

  test("an administrator publishes a page without an owner", () => {
    assert.equal(catalogRemedy(catalogVisibility(card({ ownerId: null })), admin), "publish");
    assert.equal(
      catalogRemedy(catalogVisibility(card({ ownerId: null, servers: [] })), admin),
      "publish",
      "the listing comes first when a server is missing too",
    );
  });

  test("not on a host that only reads: the web app shows the reason alone", () => {
    assert.equal(catalogRemedy(catalogVisibility(card({ ownerId: null })), { admin: true, canManage: false }), null);
  });

  test("a player confirms the server and becomes the owner", () => {
    assert.equal(catalogRemedy(catalogVisibility(card({ ownerId: null, servers: [server(COMMUNITY, false)] })), player), "claim");
    assert.equal(catalogRemedy(catalogVisibility(card({ ownerId: null, servers: [] })), player), "claim");
    assert.equal(catalogRemedy(catalogVisibility(card({ ownerId: null })), { admin: false, canManage: false }), "claim");
  });

  test("an owner, an editor or an administrator confirms a server", () => {
    const hidden = catalogVisibility(card({ servers: [server(OTHER_SERVER, false)] }));
    assert.equal(catalogRemedy(hidden, player), "verify");
    assert.equal(catalogRemedy(hidden, admin), "verify");
    assert.equal(catalogRemedy(catalogVisibility(card({ ownerId: null, listed: true, servers: [] })), admin), "verify");
  });
});

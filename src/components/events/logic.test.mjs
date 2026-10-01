/**
 * Tests for src/components/events/logic.ts and api.ts: the month grid, time
 * zones, the window of **Join**, the countdown, the calendar file, the
 * checks of the editor, the lists of Home and the sidebar, and the paths and
 * refusals of the events client.
 *
 * Node strips the TypeScript types itself, so the modules run as they are.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { eventFailureKind, eventsApi } from "./api.ts";
import {
  addMonths,
  answersOpen,
  byStart,
  canGo,
  checkDraft,
  clockOf,
  countdown,
  DAY,
  dayKey,
  draftBody,
  draftOf,
  draftPatch,
  eventDays,
  eventPhase,
  eventsByDay,
  formatOffset,
  goingSoon,
  gridRange,
  homeEvents,
  HOUR,
  icsDate,
  icsEscape,
  icsFileName,
  icsFold,
  icsText,
  isFull,
  isPublicAddress,
  isTimeZone,
  joinOpensAt,
  joinState,
  MINUTE,
  monthGrid,
  monthOf,
  nextDay,
  offsetMinutes,
  parseClock,
  parseDay,
  splitByTime,
  timeZoneNames,
  wallClock,
  withAnswer,
  zonedToInstant,
  zoneOr,
} from "./logic.ts";

const ID = `01J${"E".repeat(23)}`;
const COMMUNITY = `01J${"C".repeat(23)}`;
const SERVER = `01J${"S".repeat(23)}`;

/** A card of the calendar, the fields of a test on top. */
function card(fields = {}) {
  return {
    id: ID,
    communityId: COMMUNITY,
    community: { id: COMMUNITY, name: "Duel Masters", logo: null },
    title: "Duel Cup",
    kind: "tournament",
    startsAt: "2026-10-03T16:00:00Z",
    endsAt: "2026-10-03T19:00:00Z",
    timezone: "Europe/Moscow",
    game: "ja",
    server: { id: SERVER, label: "Duel", game: "ja", address: "1.1.1.1:29070" },
    address: "1.1.1.1:29070",
    status: "scheduled",
    capacity: null,
    counts: { going: 0, maybe: 0 },
    viewer: null,
    cover: null,
    revision: 1,
    ...fields,
  };
}

/** The page of an event. */
function details(fields = {}) {
  return {
    ...card(),
    description: "Bring a saber.",
    instructions: "Install the map pack.",
    requirements: { files: [{ jkhubId: 42, title: "Arena" }], bundle: { id: SERVER, name: "Duel Pack" } },
    createdBy: null,
    createdAt: "2026-09-30T10:00:00Z",
    updatedAt: "2026-09-30T10:00:00Z",
    ...fields,
  };
}

describe("time zones", () => {
  test("the wall clock of a moment follows the zone, Monday first", () => {
    const at = Date.parse("2026-10-03T16:00:00Z");
    assert.deepEqual(wallClock(at, "Europe/Moscow"), { year: 2026, month: 10, day: 3, hour: 19, minute: 0, second: 0, weekday: 5 });
    assert.deepEqual(wallClock(at, "America/New_York"), { year: 2026, month: 10, day: 3, hour: 12, minute: 0, second: 0, weekday: 5 });
    // Midnight is hour 0, never 24.
    assert.equal(wallClock(Date.parse("2026-10-04T21:00:00Z"), "Europe/Moscow").hour, 0);
    assert.equal(dayKey(Date.parse("2026-10-03T22:30:00Z"), "Europe/Moscow"), "2026-10-04");
    assert.equal(clockOf(Date.parse("2026-10-03T16:05:00Z"), "Europe/Berlin"), "18:05");
  });

  test("offsets are read at the moment and written as people write them", () => {
    assert.equal(offsetMinutes(Date.parse("2026-10-03T16:00:00Z"), "Europe/Moscow"), 180);
    assert.equal(offsetMinutes(Date.parse("2026-10-03T16:00:00Z"), "Europe/Berlin"), 120);
    // Berlin leaves summer time on 25 October 2026.
    assert.equal(offsetMinutes(Date.parse("2026-10-26T12:00:00Z"), "Europe/Berlin"), 60);
    assert.equal(offsetMinutes(Date.parse("2026-10-03T16:00:00Z"), "Asia/Kolkata"), 330);
    assert.equal(offsetMinutes(Date.parse("2026-10-03T16:00:00Z"), "UTC"), 0);
    assert.equal(formatOffset(180), "UTC+3");
    assert.equal(formatOffset(330), "UTC+5:30");
    assert.equal(formatOffset(-240), "UTC−4");
    assert.equal(formatOffset(0), "UTC");
  });

  test("a wall clock in a zone becomes the moment it names, across a change of the clocks", () => {
    assert.equal(new Date(zonedToInstant("2026-10-03", "19:00", "Europe/Moscow")).toISOString(), "2026-10-03T16:00:00.000Z");
    assert.equal(new Date(zonedToInstant("2026-10-03", "19:00", "America/New_York")).toISOString(), "2026-10-03T23:00:00.000Z");
    assert.equal(new Date(zonedToInstant("2026-12-03", "19:00", "America/New_York")).toISOString(), "2026-12-04T00:00:00.000Z");
    // 02:30 does not exist in Berlin on 29 March 2026: it reads as 03:30 summer time.
    assert.equal(new Date(zonedToInstant("2026-03-29", "02:30", "Europe/Berlin")).toISOString(), "2026-03-29T01:30:00.000Z");
    // 02:30 happens twice on 25 October 2026: one of the two, an hour apart.
    const twice = zonedToInstant("2026-10-25", "02:30", "Europe/Berlin");
    assert.ok(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"].includes(new Date(twice).toISOString()));
    assert.equal(zonedToInstant("2026-02-30", "19:00", "UTC"), null);
    assert.equal(zonedToInstant("2026-10-03", "24:00", "UTC"), null);
    assert.equal(zonedToInstant("3 October", "19:00", "UTC"), null);
  });

  test("names, days and clocks parse strictly", () => {
    assert.ok(isTimeZone("Europe/Moscow"));
    assert.ok(!isTimeZone("Mars/Olympus"));
    assert.ok(!isTimeZone(""));
    assert.equal(zoneOr("Mars/Olympus", "UTC"), "UTC");
    assert.equal(zoneOr("Asia/Tokyo", "UTC"), "Asia/Tokyo");
    assert.deepEqual(parseDay("2026-10-03"), { year: 2026, month: 10, day: 3 });
    assert.equal(parseDay("2026-13-01"), null);
    assert.equal(parseClock("9:05"), 545);
    assert.equal(parseClock("19:60"), null);
    assert.equal(parseClock("1900"), null);
    const names = timeZoneNames(["Europe/Moscow"]);
    assert.ok(names.includes("UTC"));
    assert.ok(names.includes("Europe/Moscow"));
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("the month grid", () => {
  test("six weeks from the Monday of the first week", () => {
    const grid = monthGrid({ year: 2026, month: 10 });
    assert.equal(grid.length, 42);
    // 1 October 2026 is a Thursday.
    assert.equal(grid[0].key, "2026-09-28");
    assert.equal(grid[0].inMonth, false);
    assert.equal(grid[3].key, "2026-10-01");
    assert.equal(grid[3].inMonth, true);
    assert.equal(grid[3].weekday, 3);
    assert.equal(grid[33].key, "2026-10-31");
    assert.equal(grid[41].key, "2026-11-08");
    assert.equal(grid.filter((day) => day.inMonth).length, 31);
    assert.ok(grid.every((day, at) => day.weekday === at % 7));
  });

  test("a month that starts on a Monday starts the grid", () => {
    const grid = monthGrid({ year: 2026, month: 6 });
    assert.equal(grid[0].key, "2026-06-01");
    assert.equal(monthGrid({ year: 2027, month: 2 })[0].key, "2027-02-01");
  });

  test("months move across years", () => {
    assert.deepEqual(addMonths({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
    assert.deepEqual(addMonths({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
    assert.deepEqual(addMonths({ year: 2026, month: 10 }, -14), { year: 2025, month: 8 });
    assert.deepEqual(monthOf("2026-10-03"), { year: 2026, month: 10 });
    assert.equal(nextDay("2026-12-31"), "2027-01-01");
  });

  test("the range of a grid is its midnights in the zone, 42 days", () => {
    const range = gridRange({ year: 2026, month: 10 }, "Europe/Moscow");
    assert.deepEqual(range, { from: "2026-09-27T21:00:00.000Z", to: "2026-11-08T21:00:00.000Z" });
    assert.equal((Date.parse(range.to) - Date.parse(range.from)) / DAY, 42);
  });

  test("an event lies on each day it touches, and midnight ends a day", () => {
    assert.deepEqual(eventDays("2026-10-03T16:00:00Z", "2026-10-03T19:00:00Z", "Europe/Moscow"), ["2026-10-03"]);
    // 23:00–02:00 Moscow crosses midnight.
    assert.deepEqual(eventDays("2026-10-03T20:00:00Z", "2026-10-03T23:00:00Z", "Europe/Moscow"), ["2026-10-03", "2026-10-04"]);
    // Ends at 00:00 sharp: the day after is not touched.
    assert.deepEqual(eventDays("2026-10-03T19:00:00Z", "2026-10-03T21:00:00Z", "Europe/Moscow"), ["2026-10-03"]);
    // A week-long event is on eight days at most.
    assert.equal(eventDays("2026-10-01T20:00:00Z", "2026-10-08T20:00:00Z", "UTC").length, 8);
    assert.deepEqual(eventDays("nonsense", "2026-10-03T19:00:00Z", "UTC"), []);
  });

  test("the events of each day keep the order of the start", () => {
    const late = card({ id: `01J${"L".repeat(23)}`, startsAt: "2026-10-03T18:00:00Z", endsAt: "2026-10-03T19:00:00Z" });
    const early = card({ id: `01J${"A".repeat(23)}`, startsAt: "2026-10-03T08:00:00Z", endsAt: "2026-10-04T09:00:00Z" });
    const days = eventsByDay([late, early], "UTC");
    assert.deepEqual(days.get("2026-10-03").map((event) => event.id), [early.id, late.id]);
    assert.deepEqual(days.get("2026-10-04").map((event) => event.id), [early.id]);
    assert.equal(byStart(early, late) < 0, true);
    // Equal starts fall back to the id, as the service sorts.
    assert.equal(byStart(card({ id: "B" }), card({ id: "A" })) > 0, true);
  });
});

describe("the state of an event", () => {
  const event = card();
  const start = Date.parse(event.startsAt);
  const end = Date.parse(event.endsAt);

  test("Join opens 30 minutes before the start and closes at the end", () => {
    assert.equal(joinState(event, start - 31 * MINUTE), "early");
    assert.equal(joinState(event, start - 30 * MINUTE), "open");
    assert.equal(joinState(event, start + HOUR), "open");
    assert.equal(joinState(event, end - 1), "open");
    assert.equal(joinState(event, end), "ended");
    assert.equal(joinState({ ...event, status: "cancelled" }, start), "cancelled");
    assert.equal(joinOpensAt(event), start - 30 * MINUTE);
  });

  test("the phase says before, during, after and off", () => {
    assert.equal(eventPhase(event, start - 1), "upcoming");
    assert.equal(eventPhase(event, start), "live");
    assert.equal(eventPhase(event, end), "ended");
    assert.equal(eventPhase({ ...event, status: "cancelled" }, start - DAY), "cancelled");
    assert.ok(answersOpen(event, start));
    assert.ok(!answersOpen(event, end));
  });

  test("the countdown is whole days, hours and minutes, never negative", () => {
    const now = start - (3 * DAY + 3 * HOUR + 59 * 1000);
    assert.deepEqual(countdown(start, now), { days: 3, hours: 3, minutes: 0 });
    assert.deepEqual(countdown(start, start - 90 * MINUTE), { days: 0, hours: 1, minutes: 30 });
    assert.deepEqual(countdown(start, start + 5), { days: 0, hours: 0, minutes: 0 });
  });

  test("a full event takes «maybe» but keeps the place of who holds one", () => {
    const full = card({ capacity: 3, counts: { going: 3, maybe: 1 }, viewer: { rsvp: null, friendsGoing: [] } });
    assert.ok(isFull(full));
    assert.ok(!canGo(full));
    assert.ok(canGo({ ...full, viewer: { rsvp: "going", friendsGoing: [] } }));
    assert.ok(!isFull(card({ capacity: null, counts: { going: 900, maybe: 0 } })));
  });

  test("an answer moves the counts at once, and the same answer changes nothing", () => {
    const before = card({ counts: { going: 2, maybe: 1 }, viewer: { rsvp: "maybe", friendsGoing: [] } });
    const going = withAnswer(before, "going");
    assert.deepEqual(going.counts, { going: 3, maybe: 0 });
    assert.equal(going.viewer.rsvp, "going");
    assert.deepEqual(withAnswer(going, null).counts, { going: 2, maybe: 0 });
    assert.equal(withAnswer(going, "going"), going);
    assert.deepEqual(withAnswer(card(), "maybe").viewer, { rsvp: "maybe", friendsGoing: [] });
  });
});

describe("lists", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const going = (id, startsAt, extra = {}) =>
    card({ id, startsAt, endsAt: new Date(Date.parse(startsAt) + 2 * HOUR).toISOString(), viewer: { rsvp: "going", friendsGoing: [] }, ...extra });

  test("the sidebar counts the reader's «going» events of the next seven days", () => {
    const events = [
      going("a", "2026-10-02T18:00:00Z"),
      going("b", "2026-10-08T11:00:00Z"),
      going("c", "2026-10-08T13:00:00Z"),
      going("d", "2026-10-01T11:00:00Z"),
      going("e", "2026-10-03T18:00:00Z", { status: "cancelled" }),
      card({ id: "f", startsAt: "2026-10-02T18:00:00Z", endsAt: "2026-10-02T19:00:00Z", viewer: { rsvp: "maybe", friendsGoing: [] } }),
      going("g", "2026-09-30T18:00:00Z"),
    ];
    // `d` is live now, `c` starts past the seventh day, `g` is over.
    assert.deepEqual(goingSoon(events, now).map((event) => event.id), ["a", "b", "d"]);
  });

  test("Home takes answers and subscriptions, the soonest three, answers over subscriptions", () => {
    const answered = [
      going("b", "2026-10-03T16:00:00Z"),
      card({ id: "m", startsAt: "2026-10-05T16:00:00Z", endsAt: "2026-10-05T18:00:00Z", viewer: { rsvp: "maybe", friendsGoing: [] } }),
      card({ id: "x", startsAt: "2026-10-02T16:00:00Z", endsAt: "2026-10-02T18:00:00Z", viewer: { rsvp: null, friendsGoing: [] } }),
    ];
    const followed = [
      going("b", "2026-10-03T16:00:00Z"),
      card({ id: "f", startsAt: "2026-10-02T10:00:00Z", endsAt: "2026-10-02T12:00:00Z", viewer: { rsvp: null, friendsGoing: [] } }),
      card({ id: "z", startsAt: "2026-10-09T10:00:00Z", endsAt: "2026-10-09T12:00:00Z", viewer: { rsvp: null, friendsGoing: [] } }),
      card({ id: "old", startsAt: "2026-09-29T10:00:00Z", endsAt: "2026-09-29T12:00:00Z", viewer: { rsvp: null, friendsGoing: [] } }),
      card({ id: "off", startsAt: "2026-10-02T09:00:00Z", endsAt: "2026-10-02T10:00:00Z", status: "cancelled", viewer: null }),
    ];
    assert.deepEqual(
      homeEvents(answered, followed, now).map(({ event, reason }) => `${event.id}:${reason}`),
      ["f:following", "b:going", "m:maybe"],
    );
    assert.equal(homeEvents([], [], now).length, 0);
  });

  test("a community's events split into upcoming, soonest first, and past, latest first", () => {
    const events = [
      card({ id: "p1", startsAt: "2026-09-20T10:00:00Z", endsAt: "2026-09-20T12:00:00Z" }),
      card({ id: "u2", startsAt: "2026-10-09T10:00:00Z", endsAt: "2026-10-09T12:00:00Z" }),
      card({ id: "p2", startsAt: "2026-09-27T10:00:00Z", endsAt: "2026-09-27T12:00:00Z" }),
      card({ id: "u1", startsAt: "2026-10-01T11:00:00Z", endsAt: "2026-10-01T13:00:00Z" }),
    ];
    const { upcoming, past } = splitByTime(events, now);
    assert.deepEqual(upcoming.map((event) => event.id), ["u1", "u2"]);
    assert.deepEqual(past.map((event) => event.id), ["p2", "p1"]);
  });
});

describe("the calendar file", () => {
  test("times are UTC to the second", () => {
    assert.equal(icsDate(Date.parse("2026-10-03T16:00:00.789Z")), "20261003T160000Z");
  });

  test("text values escape what RFC 5545 asks for", () => {
    assert.equal(icsEscape("Duel; best of 3, finals\\semis\nRound 2\r\nEnd"), "Duel\\; best of 3\\, finals\\\\semis\\nRound 2\\nEnd");
    assert.equal(icsEscape("bell\u0007"), "bell");
  });

  test("long lines fold at 75 octets without splitting a letter", () => {
    const line = `SUMMARY:${"Турнир дуэлей ".repeat(10)}`;
    const folded = icsFold(line);
    const encoder = new TextEncoder();
    const pieces = folded.split("\r\n");
    assert.ok(pieces.length > 1);
    pieces.forEach((piece, at) => {
      assert.ok(encoder.encode(piece).length <= 75, `line ${at} is ${encoder.encode(piece).length} octets`);
      if (at > 0) assert.equal(piece[0], " ");
    });
    assert.equal(pieces.map((piece, at) => (at === 0 ? piece : piece.slice(1))).join(""), line);
    assert.equal(icsFold("SHORT:1"), "SHORT:1");
  });

  test("one event with a stable UID, CRLF lines and its status", () => {
    const text = icsText(card({ title: "Duel Cup: autumn, finals", revision: 3 }), {
      now: Date.parse("2026-10-01T09:30:00Z"),
      url: `https://jknet.app/servers/?event=${ID}`,
      location: "Duel · 1.1.1.1:29070",
      description: "Duel Masters\nhttps://jknet.app",
    });
    assert.ok(text.endsWith("\r\n"));
    assert.ok(!/[^\r]\n/.test(text), "every line ends with CRLF");
    const lines = text.split("\r\n");
    assert.equal(lines[0], "BEGIN:VCALENDAR");
    assert.ok(lines.includes("VERSION:2.0"));
    assert.ok(lines.includes(`UID:${ID}@events.jknet.app`));
    assert.ok(lines.includes("DTSTAMP:20261001T093000Z"));
    assert.ok(lines.includes("DTSTART:20261003T160000Z"));
    assert.ok(lines.includes("DTEND:20261003T190000Z"));
    assert.ok(lines.includes("SUMMARY:Duel Cup: autumn\\, finals"));
    assert.ok(lines.includes("LOCATION:Duel · 1.1.1.1:29070"));
    assert.ok(lines.includes("DESCRIPTION:Duel Masters\\nhttps://jknet.app"));
    assert.ok(lines.includes(`URL:https://jknet.app/servers/?event=${ID}`));
    assert.ok(lines.includes("STATUS:CONFIRMED"));
    assert.ok(lines.includes("SEQUENCE:3"));
    assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1);
    assert.equal(lines[lines.length - 2], "END:VCALENDAR");
  });

  test("a cancelled event says so, and a link that is not HTTPS is left out", () => {
    const text = icsText(card({ status: "cancelled" }), { now: 0, url: "javascript:alert(1)" });
    assert.ok(text.includes("STATUS:CANCELLED\r\n"));
    assert.ok(!text.includes("URL:"));
    assert.ok(!text.includes("LOCATION:"));
  });

  test("the file name is the Latin letters of the title, or the day", () => {
    assert.equal(icsFileName(card({ title: "Holocron Weekly Duels!" })), "holocron-weekly-duels.ics");
    assert.equal(icsFileName(card({ title: "Café Duels" })), "cafe-duels.ics");
    assert.equal(icsFileName(card({ title: "Турнир дуэлей" })), "jknet-event-2026-10-03.ics");
  });
});

describe("the editor", () => {
  const now = Date.parse("2026-10-01T09:00:00Z");
  const draft = (fields = {}) => ({
    title: "Duel Cup",
    kind: "tournament",
    day: "2026-10-03",
    time: "19:00",
    duration: 180,
    endDay: "2026-10-03",
    endTime: "22:00",
    timezone: "Europe/Moscow",
    place: "server",
    serverId: SERVER,
    address: "",
    game: "ja",
    description: "",
    instructions: "",
    files: [],
    bundleId: null,
    capacity: "",
    cover: null,
    notify: true,
    ...fields,
  });

  test("addresses follow the service's rule of a public IPv4 and a port from 1024", () => {
    for (const ok of ["1.1.1.1:29070", "46.224.207.86:29070", " 8.8.8.8:1024 "]) assert.ok(isPublicAddress(ok), ok);
    for (const bad of [
      "192.168.1.5:29070",
      "10.0.0.1:29070",
      "127.0.0.1:29070",
      "172.16.0.1:29070",
      "100.64.0.1:29070",
      "203.0.113.10:29070",
      "198.51.100.7:29070",
      "192.0.2.1:29070",
      "224.0.0.1:29070",
      "0.1.2.3:29070",
      "1.1.1.1:80",
      "1.1.1.1:70000",
      "1.1.1.01:29070",
      "1.1.1.256:29070",
      "example.com:29070",
      "1.1.1.1",
    ]) {
      assert.ok(!isPublicAddress(bad), bad);
    }
  });

  test("a good draft has no errors and names its times in UTC", () => {
    const checked = checkDraft(draft(), now);
    assert.deepEqual(checked.errors, {});
    assert.equal(new Date(checked.startsAt).toISOString(), "2026-10-03T16:00:00.000Z");
    assert.equal(checked.endsAt - checked.startsAt, 3 * HOUR);
  });

  test("each field is checked the way the service checks it", () => {
    assert.equal(checkDraft(draft({ title: "  " }), now).errors.title, "required");
    assert.equal(checkDraft(draft({ title: "x".repeat(101) }), now).errors.title, "tooLong");
    assert.equal(checkDraft(draft({ time: "7pm" }), now).errors.start, "format");
    assert.equal(checkDraft(draft({ day: "2026-09-30" }), now).errors.start, "past");
    assert.equal(checkDraft(draft({ day: "2026-09-30" }), now, false).errors.start, undefined);
    assert.equal(checkDraft(draft({ day: "2027-12-01" }), now).errors.start, "tooFar");
    assert.equal(checkDraft(draft({ duration: null, endDay: "2026-10-03", endTime: "18:00" }), now).errors.length, "beforeStart");
    assert.equal(checkDraft(draft({ duration: null, endDay: "2026-10-03", endTime: "19:10" }), now).errors.length, "tooShort");
    assert.equal(checkDraft(draft({ duration: null, endDay: "2026-10-11", endTime: "19:00" }), now).errors.length, "tooLong");
    assert.equal(checkDraft(draft({ duration: null, endDay: "2026-10-10", endTime: "19:00" }), now).errors.length, undefined);
    assert.equal(checkDraft(draft({ timezone: "Mars/Olympus" }), now).errors.timezone, "unknown");
    assert.equal(checkDraft(draft({ serverId: "" }), now).errors.server, "required");
    assert.equal(checkDraft(draft({ place: "address", address: "" }), now).errors.address, "required");
    assert.equal(checkDraft(draft({ place: "address", address: "192.168.0.2:29070" }), now).errors.address, "format");
    assert.equal(checkDraft(draft({ capacity: "0" }), now).errors.capacity, "range");
    assert.equal(checkDraft(draft({ capacity: "1001" }), now).errors.capacity, "range");
    assert.equal(checkDraft(draft({ capacity: "-3" }), now).errors.capacity, "range");
    assert.equal(checkDraft(draft({ capacity: "32" }), now).errors.capacity, undefined);
    assert.equal(checkDraft(draft({ description: "a".repeat(6001) }), now).errors.description, "tooLong");
  });

  test("the body names one place: a server, an address with its game, or the game alone", () => {
    const checked = checkDraft(draft(), now);
    const onServer = draftBody(draft({ capacity: "16", files: [{ jkhubId: 42, title: "Arena" }] }), checked.startsAt, checked.endsAt);
    assert.equal(onServer.serverId, SERVER);
    assert.equal(onServer.address, undefined);
    assert.equal(onServer.game, undefined);
    assert.equal(onServer.startsAt, "2026-10-03T16:00:00Z");
    assert.equal(onServer.capacity, 16);
    assert.deepEqual(onServer.requirements, { files: [{ jkhubId: 42, title: "Arena" }], bundleId: null });
    assert.equal(onServer.notifyFollowers, true);
    const own = draftBody(draft({ place: "address", address: " 1.1.1.9:29070 ", game: "jo" }), checked.startsAt, checked.endsAt);
    assert.equal(own.address, "1.1.1.9:29070");
    assert.equal(own.game, "jo");
    assert.equal(own.serverId, undefined);
    const offline = draftBody(draft({ place: "offline", notify: false }), checked.startsAt, checked.endsAt);
    assert.equal(offline.game, "ja");
    assert.equal(offline.serverId, undefined);
    assert.equal(offline.address, undefined);
    assert.equal(offline.notifyFollowers, false);
    assert.equal(offline.capacity, null);
  });

  test("a draft of an event keeps its fields, and «a week later» moves its times by seven days", () => {
    const event = details({ capacity: 32, cover: "a".repeat(64) });
    const same = draftOf(event, 0, "UTC");
    assert.equal(same.day, "2026-10-03");
    assert.equal(same.time, "19:00");
    assert.equal(same.duration, 180);
    assert.equal(same.timezone, "Europe/Moscow");
    assert.equal(same.place, "server");
    assert.equal(same.serverId, SERVER);
    assert.equal(same.capacity, "32");
    assert.equal(same.bundleId, SERVER);
    assert.deepEqual(same.files, [{ jkhubId: 42, title: "Arena" }]);
    const later = draftOf(event, 7, "UTC");
    assert.equal(later.day, "2026-10-10");
    assert.equal(later.time, "19:00");
    const odd = draftOf(details({ endsAt: "2026-10-03T16:50:00Z", timezone: "" }), 0, "UTC");
    assert.equal(odd.duration, null);
    assert.equal(odd.timezone, "UTC");
    assert.equal(odd.endTime, "16:50");
    assert.equal(draftOf(details({ server: null, address: "1.1.1.9:29070" })).place, "address");
    assert.equal(draftOf(details({ server: null, address: null })).place, "offline");
  });

  test("a change sends only what differs from the event", () => {
    const event = details();
    const checked = checkDraft(draftOf(event, 0, "UTC"), Date.parse("2026-10-01T00:00:00Z"));
    assert.deepEqual(checked.errors, {});
    const unchanged = draftBody(draftOf(event, 0, "UTC"), checked.startsAt, checked.endsAt);
    assert.deepEqual(draftPatch(event, unchanged), {});
    const moved = draftBody(draftOf(event, 7, "UTC"), checked.startsAt + 7 * DAY, checked.endsAt + 7 * DAY);
    assert.deepEqual(draftPatch(event, moved), { startsAt: "2026-10-10T16:00:00Z", endsAt: "2026-10-10T19:00:00Z" });
    const elsewhere = draftBody(draftOf(event, 0, "UTC"), checked.startsAt, checked.endsAt);
    delete elsewhere.serverId;
    elsewhere.address = "1.1.1.9:29070";
    elsewhere.game = "ja";
    elsewhere.capacity = 8;
    elsewhere.requirements = { files: [], bundleId: null };
    assert.deepEqual(draftPatch(event, elsewhere), { address: "1.1.1.9:29070", requirements: { files: [], bundleId: null }, capacity: 8 });
    const offline = { ...unchanged, serverId: undefined, game: "ja" };
    delete offline.serverId;
    assert.deepEqual(draftPatch(event, offline), { serverId: null });
  });
});

describe("the events client", () => {
  test("every route has its path and its method", async () => {
    const calls = [];
    const api = eventsApi(async (method, path, body) => {
      calls.push([method, path, body]);
      return null;
    });
    await api.calendar({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", scope: "going", game: "ja" });
    await api.get(ID);
    await api.create(COMMUNITY, { title: "Duel Cup", kind: "fun", startsAt: "a", endsAt: "b" });
    await api.update(ID, { title: "New", revision: 2 });
    await api.remove(ID);
    await api.rsvp(ID, "maybe");
    await api.unrsvp(ID);
    await api.attendees(ID);
    assert.deepEqual(calls, [
      ["GET", "events?from=2026-10-01T00%3A00%3A00Z&to=2026-11-01T00%3A00%3A00Z&scope=going&game=ja", undefined],
      ["GET", `events/${ID}`, undefined],
      ["POST", `communities/${COMMUNITY}/events`, { title: "Duel Cup", kind: "fun", startsAt: "a", endsAt: "b" }],
      ["PUT", `events/${ID}`, { title: "New", revision: 2 }],
      ["DELETE", `events/${ID}`, undefined],
      ["PUT", `events/${ID}/rsvp`, { status: "maybe" }],
      ["DELETE", `events/${ID}/rsvp`, undefined],
      ["GET", `events/${ID}/attendees`, undefined],
    ]);
  });

  test("an id of the wrong shape never leaves the screen", () => {
    const api = eventsApi(async () => null);
    assert.throws(() => api.get("../me"), (error) => error.code === "notFound");
    assert.throws(() => api.create("short", { title: "x", kind: "fun", startsAt: "a", endsAt: "b" }));
  });

  test("refusals of the service map to what the screens say", () => {
    const refusal = (code, message) => ({ code: "online", message, details: { code, message } });
    assert.equal(eventFailureKind(refusal("full", "Every place of the event is taken")), "full");
    assert.equal(eventFailureKind(refusal("conflict", "The event is cancelled")), "cancelled");
    assert.equal(eventFailureKind(refusal("conflict", "The event is over")), "over");
    assert.equal(eventFailureKind(refusal("conflict", "The event changed; reload it before saving")), "changed");
    assert.equal(eventFailureKind(refusal("limit", "A community can have up to 50 upcoming events")), "limit");
    assert.equal(eventFailureKind(refusal("invalid", "An event starts in the future")), "startsInPast");
    assert.equal(eventFailureKind(refusal("invalid", "Plan an event at most a year ahead")), "tooFar");
    assert.equal(eventFailureKind(refusal("invalid", "An event lasts from 15 minutes to 7 days")), "length");
    assert.equal(eventFailureKind(refusal("invalid", "Choose a server of this community that everyone sees")), "server");
    assert.equal(eventFailureKind(refusal("invalid", "A public game-server IPv4 address with a port from 1024 is required")), "address");
    assert.equal(
      eventFailureKind(refusal("invalid", "This address belongs to the JKNet relay, which carries private servers; use the address of the game server")),
      "relay",
    );
    assert.equal(eventFailureKind(refusal("invalid", "capacity is from 1 to 1000, or null for no limit")), "capacity");
    assert.equal(eventFailureKind(refusal("invalid", "The cover may take at most 3 MiB")), "cover");
    assert.equal(eventFailureKind(refusal("invalid", "Text must fit on one line of at most 100 characters")), "text");
    assert.equal(eventFailureKind(refusal("not_found", "Event not found")), "other");
    assert.equal(eventFailureKind("online full: Every place of the event is taken"), "full");
  });
});

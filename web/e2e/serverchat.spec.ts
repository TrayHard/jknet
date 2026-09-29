/**
 * The chat of a friend's private server from the web app (spec 1.11,
 * 3.15): Kyle hosts with JKNet on a PC — a token of client `launcher` that
 * sends the heartbeats, opens the server's chat and writes in it — and Tray,
 * his friend, is in the web app in the project's layout.
 *
 * Tray sees "Kyle hosts a server" at the top of the chats and joins its
 * chat with **Join chat**, without playing. When Kyle switches **Chat from
 * the web app** off, the row goes, and a join from a list older than the
 * switch is refused with the host's reason. A server closed to friends
 * opens to Tray by an invite: on Kyle's page, on the requests screen, and
 * on the `hostInvite` card in their chat. Nothing on the way joins the
 * game: the guard fails the test on any command left to the launcher.
 */

import type { Page } from "@playwright/test";

import { chatText, makeFriends, messageRow, send } from "./chat-fixtures.ts";
import {
  expect,
  launcherSignIn,
  SERVICE,
  sharedCatalog,
  signIn,
  test,
  uniqueName,
  userIdOf,
  visit,
  type LauncherClient,
} from "./fixtures.ts";
import { webText } from "./push-fixtures.ts";

const JOIN_CHAT = chatText("cards.joinChat");
const WEB_JOIN_OFF = (sharedCatalog("en", "errors").online as Record<string, string>).webJoinOff;
/** An address in the host's own network: an invite to a private server points there or at the relay. */
const LAN = "192.168.1.20:29070";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A client id as a launcher makes one: a ULID. */
function ulid(): string {
  let time = Date.now();
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = "";
  for (let index = 0; index < 16; index += 1) tail += CROCKFORD[Math.floor(Math.random() * 32)];
  return head + tail;
}

/** A `jknet_session` of a private server: 16 hex characters. */
function sessionId(): string {
  let id = "";
  for (let index = 0; index < 16; index += 1) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

interface Hosting {
  sessionId: string;
  game: "ja" | "jo";
  map: string;
  gametype: number;
  players: number;
  maxPlayers: number;
  joinPolicy: "friends" | "selected" | "invite";
  lanAddresses?: string[];
  chatFromWeb?: boolean;
}

async function call(launcher: LauncherClient, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${SERVICE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${launcher.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Kyle's launcher while it hosts: a heartbeat on every change of the
 * server, and one every 20 s in between, so the hosting never runs out.
 */
class Host {
  hosting: Hosting;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly launcher: LauncherClient, hosting: Hosting) {
    this.hosting = hosting;
  }

  async beat(change: Partial<Hosting> = {}): Promise<void> {
    this.hosting = { ...this.hosting, ...change };
    const response = await call(this.launcher, "PUT", "/v1/presence", { status: "online", hosting: this.hosting });
    expect(response.ok, `a hosting heartbeat (${response.status})`).toBe(true);
    if (this.timer === undefined) this.timer = setInterval(() => void call(this.launcher, "PUT", "/v1/presence", { status: "online", hosting: this.hosting }), 20_000);
  }

  /** Opens the chat of the server hosted now; answers its conversation id. */
  async openChat(): Promise<string> {
    const response = await call(this.launcher, "PUT", `/v1/chat/servers/${this.hosting.sessionId}`);
    expect(response.status, "the server's chat opens").toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async closeChat(): Promise<void> {
    const response = await call(this.launcher, "DELETE", `/v1/chat/servers/${this.hosting.sessionId}`);
    expect(response.status).toBe(204);
  }

  async send(conversationId: string, body: string, cards: unknown[] = []): Promise<void> {
    const response = await call(this.launcher, "POST", `/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
      clientId: ulid(),
      body,
      cards,
    });
    expect(response.status, await response.text()).toBeLessThan(300);
  }

  async bodies(conversationId: string): Promise<string[]> {
    const response = await call(this.launcher, "GET", `/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`);
    const page = (await response.json()) as { messages?: Array<{ body?: string }> };
    return (page.messages ?? []).map((message) => message.body ?? "");
  }

  async invite(toUserId: string): Promise<void> {
    const response = await call(this.launcher, "POST", "/v1/invites", {
      toUserId,
      serverAddress: LAN,
      serverName: "Duel night",
      hosting: this.hosting,
    });
    expect(response.status, await response.text()).toBe(201);
  }

  async direct(userId: string): Promise<string> {
    const response = await call(this.launcher, "PUT", `/v1/chat/direct/${encodeURIComponent(userId)}`);
    expect(response.ok, `the direct chat (${response.status})`).toBe(true);
    return ((await response.json()) as { id: string }).id;
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Whether a frame of the service tells of this host's hosting: its presence, or its server's chat. */
function isAbout(message: string, hostId: string): boolean {
  try {
    const frame = JSON.parse(message) as { type?: string; payload?: { userId?: string; hostUserId?: string } };
    if (frame.type === "presence.updated") return frame.payload?.userId === hostId;
    if (frame.type === "chat.serverJoinable") return frame.payload?.hostUserId === hostId;
    return false;
  } catch {
    return false;
  }
}

/** The row of Kyle's server at the top of the chats. */
function joinableRow(page: Page, host: string) {
  return page.getByTestId("joinable-row").filter({ hasText: webText("serverChats.hosts").replace("{{name}}", host) });
}

test("a friend's server chat from the web: joined, closed to the web, and opened by an invite", async ({ page, players }) => {
  const kyle = uniqueName("Kyle");
  const tray = uniqueName("Tray");
  // What Tray's socket brings about the host goes through here: while
  // `hushed` names the host, she hears nothing of their hosting.
  let hushed: string | null = null;
  await page.routeWebSocket(/\/v1\/ws\?/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (hushed !== null && typeof message === "string" && isAbout(message, hushed)) return;
      ws.send(message);
    });
  });
  await signIn(page, tray);
  const kylesBrowser = await players.open();
  await signIn(kylesBrowser, kyle);
  await makeFriends(page, tray, kylesBrowser, kyle);
  const trayId = await userIdOf(page);
  const launcher = await launcherSignIn(kyle);

  const first = sessionId();
  const host = new Host(launcher, { sessionId: first, game: "ja", map: "mp/ffa3", gametype: 0, players: 1, maxPlayers: 8, joinPolicy: "friends" });
  try {
    await host.beat();
    const firstChat = await host.openChat();

    // -- Kyle hosts a server: the row at the top of Tray's chats ------------
    await visit(page, "/chats");
    const row = joinableRow(page, kyle);
    await expect(row).toBeVisible();
    await expect(row).toContainText("mp/ffa3");
    await expect(row.getByRole("button", { name: JOIN_CHAT })).toBeVisible();

    // -- Kyle keeps the chat to players in the game --------------------------
    // The heartbeat with the switch off takes the row away, and the next one
    // with it on brings it back.
    await host.beat({ chatFromWeb: false });
    await expect(row).toHaveCount(0);
    await host.beat({ chatFromWeb: undefined });
    await expect(row).toBeVisible();

    // Tray's list is older than the switch — she did not hear it — and the
    // service still refuses, and says why; the list is read again.
    hushed = launcher.userId;
    await host.beat({ chatFromWeb: false });
    await row.getByRole("button", { name: JOIN_CHAT }).click();
    const refusal = page.getByTestId("joinable-servers").getByTestId("join-refusal");
    await expect(refusal).toHaveText(WEB_JOIN_OFF);
    await expect(row).toHaveCount(0);
    hushed = null;

    // -- The chat opens to the web again: Tray joins, reads and writes ------
    // Kyle switches it on and changes the map; Tray hears both.
    await host.beat({ chatFromWeb: undefined, map: "mp/ffa2" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("mp/ffa2");
    await row.getByRole("button", { name: JOIN_CHAT }).click();
    await page.waitForURL((url) => url.pathname === `/c/${firstChat}`);
    await expect(page.getByTestId("guest-note")).toHaveText(webText("serverChats.guestNote"));
    await host.send(firstChat, "Welcome to the server");
    await expect(messageRow(page, "Welcome to the server")).toBeVisible({ timeout: 20_000 });
    await send(page, "Hello from the web");
    await expect.poll(() => host.bodies(firstChat), { timeout: 20_000 }).toContain("Hello from the web");

    // -- A server closed to friends opens by an invite -----------------------
    await host.closeChat();
    const second = sessionId();
    await host.beat({ sessionId: second, map: "mp/duel1", gametype: 3, joinPolicy: "invite", lanAddresses: [LAN] });
    const secondChat = await host.openChat();

    await visit(page, `/friends/${encodeURIComponent(launcher.userId)}`);
    const hosted = page.getByTestId("hosted-server");
    await expect(hosted).toContainText("mp/duel1");
    await expect(hosted.getByRole("button", { name: JOIN_CHAT })).toHaveCount(0);

    await host.invite(trayId);
    await expect(hosted.getByRole("button", { name: JOIN_CHAT })).toBeVisible();
    await expect(hosted).toContainText(webText("serverChats.invited"));

    // The invite on the requests screen has **Join chat** next to **Dismiss**.
    await visit(page, "/friends/requests");
    const invite = page.getByTestId("server-invite").filter({ hasText: kyle });
    await expect(invite.getByRole("button", { name: JOIN_CHAT })).toBeVisible();

    // Kyle's `hostInvite` card in their direct chat: **Join chat** opens the server's chat.
    const direct = await host.direct(trayId);
    await host.send(direct, "Duel night is on", [
      { type: "hostInvite", v: 1, fallbackText: "Join my server: Duel night", sessionId: second, name: "Duel night" },
    ]);
    await visit(page, `/c/${encodeURIComponent(direct)}`);
    const card = page
      .getByRole("log")
      .getByRole("group", { name: chatText("cards.label", { kind: chatText("cards.kinds.hostInvite"), title: "Duel night" }) });
    await card.getByRole("button", { name: JOIN_CHAT }).click();
    await page.waitForURL((url) => url.pathname === `/c/${secondChat}`);
    await expect(page.getByTestId("guest-note")).toBeVisible();
  } finally {
    host.stop();
  }
});

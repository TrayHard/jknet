import { Check, Copy, Server, Share2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useShareDialog } from "../../../../src/components/chat/ShareToChatDialog.tsx";
import { ServerName } from "../../../../src/components/servers/ServerName.tsx";
import { Avatar, Button, EmptyState } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useFormat } from "../../../../src/i18n/useFormat.ts";
import { useGametypeLabels } from "../../../../src/i18n/useGameLabels.ts";
import { serverCard } from "../../../../src/lib/chat/cardDrafts.ts";
import { useGameNames } from "../../../../src/lib/game.ts";
import type { Friend, Game, ServerInfo } from "../../../../src/lib/ipc.ts";
import { PlatformNote } from "../catalog/PlatformNote.tsx";
import { catalogUnavailable, friendsOn, useFriendsOnServers, useServerList } from "../catalog/serverList.ts";

/** How long **Copy address** says it copied. */
const COPIED_MS = 2000;

/**
 * **Copy address**, which says **Copied** for two seconds once the
 * clipboard took it. A clipboard that refuses leaves the button as it was.
 */
function CopyAddress({ address }: { address: string }) {
  const { t } = useTranslation("servers");
  const { t: tWeb } = useTranslation("web");
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Button
      icon={copied ? <Check size={16} className="text-fg-success" /> : <Copy size={16} />}
      aria-label={t("details.copyAddress")}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(address)
          .then(() => {
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? <span className="text-fg-success">{tWeb("serverList.copied")}</span> : t("details.copyAddress")}
    </Button>
  );
}

/** One fact of the server: a label over its value. */
function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-line-subtle bg-input px-12 py-10">
      <dt className="text-body-sm text-fg-secondary">{label}</dt>
      <dd className={mono ? "truncate text-mono-sm text-fg" : "truncate text-body-md-medium text-fg"}>{children}</dd>
    </div>
  );
}

/** The friends playing on the server, each a link to the friend's page. */
function FriendsHere({ friends }: { friends: Friend[] }) {
  const { t } = useTranslation("web");
  if (friends.length === 0) return null;
  return (
    <section className="flex flex-col gap-8" aria-label={t("serverList.friendsHere")} data-testid="server-friends-here">
      <h2 className="text-label-xs text-fg-muted">{t("serverList.friendsHere")}</h2>
      <ul className="flex flex-col gap-4">
        {friends.map((friend) => (
          <li key={friend.user.id}>
            <Link
              to={`/friends/${encodeURIComponent(friend.user.id)}`}
              className="flex min-w-0 items-center gap-10 rounded-md bg-input px-12 py-8 text-body-md-medium text-fg hover:bg-surface-hover"
            >
              <Avatar name={friend.user.displayName} src={friend.user.avatarUrl} size="md" status="online" />
              <span className="min-w-0 truncate [unicode-bidi:isolate]">{friend.user.displayName}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Seconds since an RFC 3339 moment, or `null` for something that is not one. */
function secondsSince(value: string): number | null {
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(Math.round((Date.now() - at) / 1000), 0);
}

/** What the page shows of one server of the list. */
function ServerFacts({ server, friends }: { server: ServerInfo; friends: Friend[] }) {
  const { t } = useTranslation("servers");
  const { t: tWeb } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const format = useFormat();
  const labels = useGametypeLabels();
  const gameNames = useGameNames();
  const share = useShareDialog();
  const age = secondsSince(server.lastSeen);
  const players =
    server.humans === null
      ? `${server.clients} · ${t("details.botsUnknown")}`
      : server.bots !== null && server.bots > 0
        ? `${server.humans} ${t("details.bots", { count: server.bots })}`
        : String(server.humans);
  const mod = server.modName === "" || server.modName.toLowerCase() === "base" ? tWeb("serverList.baseGame") : server.modName;

  return (
    <>
      <div className="flex flex-col gap-4">
        <h1 className="flex min-w-0 items-center gap-8 text-display-md text-fg">
          <ServerName raw={server.hostnameRaw} clean={server.hostnameClean} className="min-w-0" />
        </h1>
        <p className="text-mono-sm text-fg-secondary [overflow-wrap:anywhere]" data-testid="server-address">
          {server.address}
        </p>
        <p className="text-body-sm text-fg-muted">
          {gameNames.label(server.game)}
          {age !== null ? ` · ${tWeb("serverList.lastSeen", { age: format.age(age) })}` : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-8">
        <CopyAddress address={server.address} />
        {share.available ? (
          <Button icon={<Share2 size={16} />} onClick={() => share.open({ kind: "card", card: serverCard(server) })}>
            {tChat("share.action")}
          </Button>
        ) : null}
      </div>
      <PlatformNote text={tWeb("catalog.playNote")} />
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(min(160px,100%),1fr))] gap-8" data-testid="server-facts">
        <Fact label={tWeb("serverList.fields.map")} mono>
          {server.map || "—"}
        </Fact>
        <Fact label={tWeb("serverList.fields.mode")}>{labels.label(server.game, server.gametype, server.gametypeLabel)}</Fact>
        <Fact label={tWeb("serverList.fields.players")}>{players}</Fact>
        <Fact label={tWeb("serverList.fields.slots")}>{server.maxClients > 0 ? server.maxClients : "—"}</Fact>
        <Fact label={tWeb("serverList.fields.mod")} mono>
          {mod}
        </Fact>
        <Fact label={tWeb("serverList.fields.password")}>
          {server.needpass ? tWeb("serverList.passwordYes") : tWeb("serverList.passwordNo")}
        </Fact>
      </dl>
      <FriendsHere friends={friends} />
      {share.dialog}
    </>
  );
}

/**
 * One server of the list: its name in the game's colours, the address with
 * **Copy address**, the map, the mode, the people and the bots on it, the
 * mod, whether it asks for a password, when it last answered, the friends
 * playing there, and **Share to chat**, which sends it as a card with its
 * map, mode and mod. Joining is JKNet's on the PC, and the page says so.
 *
 * The page reads the same list as the screen beside it, so it opens from a
 * link as well: a server the list does not name (any more) says so and
 * keeps the address to copy.
 */
export function ServerDetailsScreen({ game, address }: { game: Game; address: string }) {
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const list = useServerList(game);
  const friendsByServer = useFriendsOnServers();
  const server = list.data?.servers.find((row) => row.address === address) ?? null;

  return (
    <div className="flex flex-col gap-16 px-16 py-20 sm:px-32 sm:py-24" data-testid="server-details">
      {server !== null ? (
        <ServerFacts server={server} friends={friendsOn(friendsByServer, server.address)} />
      ) : list.isLoading ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {tWeb("serverList.loading")}
        </p>
      ) : list.error !== null && catalogUnavailable(list.error) ? (
        <EmptyState icon={<Server size={24} />} title={tWeb("serverList.unavailable")} text={tWeb("serverList.unavailableText")} />
      ) : list.error !== null && list.data === undefined ? (
        <EmptyState
          icon={<Server size={24} />}
          title={tWeb("serverList.errorTitle")}
          text={errorText(list.error)}
          action={
            <Button disabled={list.isFetching} onClick={() => void list.refetch()}>
              {tCommon("actions.tryAgain")}
            </Button>
          }
        />
      ) : (
        <>
          <div role="alert" className="flex flex-col gap-4">
            <h1 className="text-heading-md text-fg">{tWeb("serverList.notListedTitle")}</h1>
            <p className="text-body-sm text-fg-secondary">
              {list.data?.stale ? tWeb("serverList.updating") : tWeb("serverList.notListedText")}
            </p>
          </div>
          <p className="text-mono-sm text-fg [overflow-wrap:anywhere]" data-testid="server-address">
            {address}
          </p>
          <div>
            <CopyAddress address={address} />
          </div>
          <PlatformNote text={tWeb("catalog.playNote")} />
        </>
      )}
    </div>
  );
}

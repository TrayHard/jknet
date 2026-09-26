import { Box, Clapperboard, FileCode, Film, Image as ImageIcon, Package, Server, Star, UserRound } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import {
  bindCard,
  bundleCard,
  configCard,
  fitsConfigCard,
  jkhubModCard,
  mapCard,
  serverCard,
  type BindEntry,
} from "../../../lib/chat/cardDrafts";
import { clientsOfGame, useActiveGame, useDefaultClient } from "../../../lib/game";
import type { ChatCard, ChatStagedFile, MediaItem } from "../../../lib/ipc";
import { configBinds } from "../../../lib/quakeConfig";
import {
  useBundles,
  useCachedServers,
  useChatCardFromProfile,
  useClients,
  useConfigs,
  useHostMaps,
  useJkhubSearch,
  useMedia,
  useProfiles,
  useStageChatFiles,
} from "../../../lib/queries";
import { ColoredNickname } from "../../client/ColoredNickname";
import { MapThumb } from "../../host/MapOption";
import { Button, Dialog, Select } from "../../ui";
import type { AttachKind } from "../AttachMenu";
import { PickerDialog, type PickerItem } from "./PickerDialog";

/** What a picker hands back to the composer: a card to send, or a staged file. */
export type Picked = { card: ChatCard } | { file: ChatStagedFile };

interface PickerProps {
  onPick: (picked: Picked) => void;
  onClose: () => void;
}

/**
 * --- slice: chat cards ---
 *
 * The picker of one kind of the attach menu: a Media item, a server, a map,
 * a player profile, key binds, a config, a bundle or a JKHub mod. Each lists
 * what the launcher already has — the lists of the screens it comes from —
 * and hands the composer a card draft, or a file the core has staged.
 */
export function AttachPicker({ kind, onPick, onClose }: PickerProps & { kind: AttachKind }) {
  switch (kind) {
    case "media":
      return <MediaPicker onPick={onPick} onClose={onClose} />;
    case "server":
      return <ServerPicker onPick={onPick} onClose={onClose} />;
    case "map":
      return <MapPicker onPick={onPick} onClose={onClose} />;
    case "profile":
      return <ProfilePicker onPick={onPick} onClose={onClose} />;
    case "bind":
      return <BindPicker onPick={onPick} onClose={onClose} />;
    case "config":
      return <ConfigPicker onPick={onPick} onClose={onClose} />;
    case "bundle":
      return <BundlePicker onPick={onPick} onClose={onClose} />;
    case "jkhubMod":
      return <JkhubPicker onPick={onPick} onClose={onClose} />;
    default:
      return null;
  }
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex size-32 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-fg-accent">
      {children}
    </span>
  );
}

/** A Media item: the core stages the file with its metadata stripped. */
function MediaPicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const format = useFormat();
  const game = useActiveGame();
  const media = useMedia();
  const stage = useStageChatFiles().media;
  const items = useMemo<PickerItem[]>(
    () =>
      (media.data ?? [])
        .filter((item: MediaItem) => item.game === game)
        .map((item: MediaItem) => ({
          id: item.id,
          title: item.name,
          detail: `${t(`pickers.media.kinds.${item.kind}`)} · ${format.bytes(item.size)}`,
          keywords: item.tags.join(" "),
          lead:
            item.preview !== null ? (
              <img src={item.preview} alt="" className="h-36 w-64 shrink-0 rounded-xs object-cover" />
            ) : (
              <Mark>{item.kind === "demos" ? <Film size={16} /> : item.kind === "videos" ? <Clapperboard size={16} /> : <ImageIcon size={16} />}</Mark>
            ),
        })),
    [media.data, game, t, format],
  );
  return (
    <PickerDialog
      title={t("pickers.media.title")}
      body={t("attach.limits")}
      items={items}
      loading={media.isPending}
      busy={stage.isPending}
      error={media.error ? errorText(media.error) : stage.error ? errorText(stage.error) : null}
      emptyText={t("pickers.media.empty")}
      onClose={onClose}
      onPick={(id) => stage.mutate(id, { onSuccess: (file) => onPick({ file }) })}
    />
  );
}

/** A server of the browser, the favourites first. */
function ServerPicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const servers = useCachedServers();
  const items = useMemo<PickerItem[]>(
    () =>
      [...(servers.data ?? [])]
        .filter((server) => !server.hidden)
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.humans ?? 0) - (a.humans ?? 0))
        .map((server) => ({
          id: server.address,
          title: server.hostnameClean || server.address,
          titleNode: <ColoredNickname raw={server.hostnameRaw} placeholder={server.address} />,
          detail: `${server.address} · ${server.map}`,
          lead: <Mark>{server.favorite ? <Star size={16} /> : <Server size={16} />}</Mark>,
        })),
    [servers.data],
  );
  return (
    <PickerDialog
      title={t("pickers.server.title")}
      items={items}
      loading={servers.isPending}
      error={servers.error ? errorText(servers.error) : null}
      emptyText={t("pickers.server.empty")}
      onClose={onClose}
      onPick={(address) => {
        const server = servers.data?.find((row) => row.address === address);
        if (server) onPick({ card: serverCard(server) });
      }}
    />
  );
}

/** A map of the default client of the active game. */
function MapPicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const game = useActiveGame();
  const client = useDefaultClient();
  const maps = useHostMaps(client?.id ?? null);
  const items = useMemo<PickerItem[]>(
    () =>
      (maps.data ?? []).map((map) => ({
        id: map.name,
        title: map.title ?? map.name,
        detail: map.title ? map.name : null,
        lead: <MapThumb map={map} />,
      })),
    [maps.data],
  );
  return (
    <PickerDialog
      title={t("pickers.map.title")}
      body={client ? t("pickers.map.body", { client: client.name }) : undefined}
      items={items}
      loading={client !== undefined && maps.isPending}
      error={maps.error ? errorText(maps.error) : null}
      emptyText={client ? t("pickers.map.empty") : t("pickers.noClient")}
      onClose={onClose}
      onPick={(name) => {
        const map = maps.data?.find((entry) => entry.name === name);
        if (map) onPick({ card: mapCard(map, game) });
      }}
    />
  );
}

/** A player profile of a client of the active game. */
function ProfilePicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const game = useActiveGame();
  const clients = useClients();
  const fallback = useDefaultClient();
  const own = clientsOfGame(clients.data, game);
  const [clientId, setClientId] = useState<string | null>(null);
  const client = own.find((entry) => entry.id === (clientId ?? fallback?.id)) ?? own[0];
  const book = useProfiles(client?.id ?? "", client !== undefined);
  const fromProfile = useChatCardFromProfile();
  const items = useMemo<PickerItem[]>(
    () =>
      (book.data?.profiles ?? []).map((profile) => ({
        id: profile.id,
        title: profile.name,
        detail: profile.model,
        titleNode: (
          <span className="flex min-w-0 items-baseline gap-8">
            <span className="truncate">{profile.name}</span>
            <ColoredNickname raw={profile.nickname ?? ""} placeholder="" className="truncate text-body-sm text-fg-secondary" />
          </span>
        ),
        keywords: profile.nickname ?? "",
        lead: (
          <Mark>
            <UserRound size={16} />
          </Mark>
        ),
      })),
    [book.data],
  );
  return (
    <PickerDialog
      title={t("pickers.profile.title")}
      header={
        own.length > 1 && client !== undefined ? (
          <Select
            label={t("pickers.profile.client")}
            ariaLabel={t("pickers.profile.client")}
            value={client.id}
            options={own.map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={setClientId}
          />
        ) : null
      }
      items={items}
      loading={client !== undefined && book.isPending}
      busy={fromProfile.isPending}
      error={book.error ? errorText(book.error) : fromProfile.error ? errorText(fromProfile.error) : null}
      emptyText={client ? t("pickers.profile.empty") : t("pickers.noClient")}
      onClose={onClose}
      onPick={(id) => {
        const profile = book.data?.profiles.find((entry) => entry.id === id);
        if (profile) fromProfile.mutate(profile, { onSuccess: (card) => onPick({ card }) });
      }}
    />
  );
}

/** A config document of the active game, 32 KiB at most. */
function ConfigPicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const format = useFormat();
  const game = useActiveGame();
  const book = useConfigs();
  const documents = (book.data?.documents ?? []).filter((document) => document.game === game);
  const items: PickerItem[] = documents.map((document) => ({
    id: document.id,
    title: document.name,
    detail: format.bytes(new TextEncoder().encode(document.text).length),
    lead: (
      <Mark>
        <FileCode size={16} />
      </Mark>
    ),
    disabledReason: fitsConfigCard(document.text) ? null : t("pickers.config.tooLarge"),
  }));
  return (
    <PickerDialog
      title={t("pickers.config.title")}
      items={items}
      loading={book.isPending}
      error={book.error ? errorText(book.error) : null}
      emptyText={t("pickers.config.empty")}
      onClose={onClose}
      onPick={(id) => {
        const document = documents.find((entry) => entry.id === id);
        if (document) onPick({ card: configCard(document) });
      }}
    />
  );
}

/** A bundle of the catalogue of the active game. */
function BundlePicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const game = useActiveGame();
  const [query, setQuery] = useState("");
  const bundles = useBundles({ game, sort: "popular", q: query.trim() || undefined, limit: 60 });
  const items: PickerItem[] = (bundles.data?.items ?? []).map((bundle) => ({
    id: bundle.id,
    title: bundle.name,
    detail: bundle.owner ? t("cards.bundle.by", { author: bundle.owner.displayName }) : null,
    lead: (
      <Mark>
        <Package size={16} />
      </Mark>
    ),
  }));
  return (
    <PickerDialog
      title={t("pickers.bundle.title")}
      items={items}
      loading={bundles.isPending}
      error={bundles.error ? errorText(bundles.error) : null}
      emptyText={t("pickers.bundle.empty")}
      onQuery={setQuery}
      onClose={onClose}
      onPick={(id) => {
        const bundle = bundles.data?.items.find((entry) => entry.id === id);
        if (bundle) onPick({ card: bundleCard(bundle) });
      }}
    />
  );
}

/** A file of JKHub, found in the local index of the catalogue. */
function JkhubPicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const game = useActiveGame();
  const [query, setQuery] = useState("");
  const search = useJkhubSearch(game, query.trim(), null, "mostDownloaded", 60, "desc");
  const items: PickerItem[] = (search.data?.cards ?? []).map((file) => ({
    id: String(file.id),
    title: file.title,
    detail: file.author ? t("cards.jkhubMod.by", { author: file.author.name }) : null,
    lead:
      file.thumbnailUrl !== null ? (
        <img src={file.thumbnailUrl} alt="" referrerPolicy="no-referrer" className="h-36 w-64 shrink-0 rounded-xs object-cover" />
      ) : (
        <Mark>
          <Box size={16} />
        </Mark>
      ),
  }));
  return (
    <PickerDialog
      title={t("pickers.jkhubMod.title")}
      searchLabel={t("pickers.jkhubMod.search")}
      items={items}
      loading={search.isPending}
      error={search.error ? errorText(search.error) : null}
      emptyText={t("pickers.jkhubMod.empty")}
      onQuery={setQuery}
      onClose={onClose}
      onPick={(id) => {
        const file = search.data?.cards.find((entry) => String(entry.id) === id);
        if (file) onPick({ card: jkhubModCard({ ...file, game }, game) });
      }}
    />
  );
}

/**
 * Key binds out of the saved configs of the active game: the player ticks
 * the ones to send, up to 50, and they go as one card.
 */
function BindPicker({ onPick, onClose }: PickerProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const game = useActiveGame();
  const book = useConfigs();
  const [picked, setPicked] = useState<string[]>([]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<BindEntry & { id: string; source: string }> = [];
    for (const document of book.data?.documents ?? []) {
      if (document.game !== game) continue;
      for (const bind of configBinds(document.text)) {
        const id = `${bind.key}\u0000${bind.command}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...bind, id, source: document.name });
      }
    }
    return out;
  }, [book.data, game]);

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((one) => one !== id) : current.length >= 50 ? current : [...current, id],
    );

  return (
    <Dialog
      wide
      title={t("pickers.bind.title")}
      body={t("pickers.bind.body")}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={picked.length === 0}
            onClick={() => onPick({ card: bindCard(rows.filter((row) => picked.includes(row.id))) })}
          >
            {t("pickers.bind.add", { count: picked.length })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-8 pt-12">
        {book.error ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {errorText(book.error)}
          </p>
        ) : null}
        <ul className="flex max-h-[46vh] min-h-120 flex-col gap-2 overflow-y-auto">
          {book.isPending ? (
            <li className="px-8 py-12 text-body-sm text-fg-muted">{t("pickers.loading")}</li>
          ) : rows.length === 0 ? (
            <li className="px-8 py-12 text-body-sm text-fg-muted">{t("pickers.bind.empty")}</li>
          ) : (
            rows.map((row) => (
              <li key={row.id}>
                <label className="flex min-w-0 cursor-pointer items-center gap-10 rounded-md px-8 py-6 hover:bg-hover-overlay">
                  <input type="checkbox" checked={picked.includes(row.id)} onChange={() => toggle(row.id)} />
                  <kbd className="shrink-0 rounded-xs border border-line-strong bg-elevated px-6 text-mono-xs text-fg">{row.key}</kbd>
                  <code className="min-w-0 flex-1 truncate text-mono-xs text-fg-secondary" title={row.command}>
                    {row.command}
                  </code>
                  <span className="shrink-0 truncate text-body-sm text-fg-muted" title={row.source}>
                    {row.source}
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>
      </div>
    </Dialog>
  );
}

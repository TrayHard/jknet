import type { ComponentType } from "react";

import type { CardType } from "../../../lib/chat/cardDrafts";
import type { ChatCard, ChatFileClass, ChatFileRef, ChatMessage } from "../../../lib/ipc";
import { BindCardView } from "./BindCard";
import { BundleCardView } from "./BundleCard";
import { ConfigCardView } from "./ConfigCard";
import { DemoAttachment } from "./DemoAttachment";
import { FileCard } from "./FileCard";
import { HostInviteCardView } from "./HostInviteCard";
import { ImageAttachment } from "./ImageAttachment";
import { JkhubModCardView } from "./JkhubModCard";
import { MapCardView } from "./MapCard";
import { ProfileCardView } from "./ProfileCard";
import { ServerCardView } from "./ServerCard";
import { VideoAttachment } from "./VideoAttachment";
import { withFields } from "./withFields";

/**
 * --- slice: chat ---
 *
 * The card kinds the thread knows how to draw, by the `type` of the card.
 *
 * --- slice: chat cards ---
 * Every kind of this release is registered: `server`, `hostInvite`,
 * `bundle`, `jkhubMod`, `map`, `profile`, `bind`, `config`. Each is read by
 * `readCard` first; a card that lacks a field its view needs draws its
 * `fallbackText` in `CardFallback`, and a kind this launcher does not know at
 * all draws `UnknownCard`, which is also what an older launcher shows for a
 * kind added after it.
 */
export interface CardProps {
  card: ChatCard;
  message: ChatMessage;
}

export const CARD_KINDS: Record<CardType, ComponentType<CardProps>> = {
  server: withFields("server", ServerCardView),
  hostInvite: withFields("hostInvite", HostInviteCardView),
  bundle: withFields("bundle", BundleCardView),
  jkhubMod: withFields("jkhubMod", JkhubModCardView),
  map: withFields("map", MapCardView),
  profile: withFields("profile", ProfileCardView),
  bind: withFields("bind", BindCardView),
  config: withFields("config", ConfigCardView),
};

/** The component of a card kind, or `undefined` for one this launcher does not draw. */
export function cardComponent(type: string): ComponentType<CardProps> | undefined {
  return Object.prototype.hasOwnProperty.call(CARD_KINDS, type) ? CARD_KINDS[type as CardType] : undefined;
}

/** What a file of a message is drawn with. */
export interface AttachmentProps {
  file: ChatFileRef;
  message: ChatMessage;
}

/**
 * The files of a message by their class: a picture, a video and a demo have
 * their own view; everything else — an archive, a program, a config, a file
 * of no known kind — is a `FileCard`.
 */
export const FILE_KINDS: Record<ChatFileClass, ComponentType<AttachmentProps>> = {
  image: ImageAttachment,
  video: VideoAttachment,
  demo: DemoAttachment,
  config: FileCard,
  archive: FileCard,
  executable: FileCard,
  other: FileCard,
};

/** The component of a file, `FileCard` for a class a newer service added. */
export function fileComponent(fileClass: string): ComponentType<AttachmentProps> {
  return Object.prototype.hasOwnProperty.call(FILE_KINDS, fileClass)
    ? FILE_KINDS[fileClass as ChatFileClass]
    : FileCard;
}

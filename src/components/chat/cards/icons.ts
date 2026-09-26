import {
  Box,
  FileCode,
  Keyboard,
  LogIn,
  Map as MapIcon,
  Package,
  Server,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import type { CardType } from "../../../lib/chat/cardDrafts";

/**
 * --- slice: chat cards ---
 *
 * The mark of each card kind: the same one in the attach menu, the tray of
 * the composer, the preview of **Share to chat** and the card itself.
 */
export const CARD_ICONS: Record<CardType, LucideIcon> = {
  server: Server,
  hostInvite: LogIn,
  bundle: Package,
  jkhubMod: Box,
  map: MapIcon,
  profile: UserRound,
  bind: Keyboard,
  config: FileCode,
};

/**
 * The eight sections, in the order the phone's menu and the wide rail show
 * them, with their group, icon and root path.
 *
 * The icons are the launcher sidebar's where the launcher has the section:
 * `Server` for the server list, `Globe` for community servers, `Library` for
 * JKHub, `Users` for friends.
 */

import {
  CalendarDays,
  Globe,
  Library,
  MessageCircle,
  Package,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { Section } from "./routeTable.ts";
import { SECTION_ROOTS, SECTIONS } from "./routeTable.ts";

export type NavGroup = "chat" | "browse" | "app";

export interface NavSection {
  section: Section;
  group: NavGroup;
  icon: LucideIcon;
  path: string;
}

const GROUPS: Record<Section, NavGroup> = {
  chats: "chat",
  friends: "chat",
  community: "browse",
  events: "browse",
  servers: "browse",
  bundles: "browse",
  jkhub: "browse",
  settings: "app",
};

const ICONS: Record<Section, LucideIcon> = {
  chats: MessageCircle,
  friends: Users,
  community: Globe,
  events: CalendarDays,
  servers: Server,
  bundles: Package,
  jkhub: Library,
  settings: Settings,
};

export const NAV_SECTIONS: readonly NavSection[] = SECTIONS.map((section) => ({
  section,
  group: GROUPS[section],
  icon: ICONS[section],
  path: SECTION_ROOTS[section],
}));

export const NAV_GROUPS: readonly NavGroup[] = ["chat", "browse", "app"];

/** What a layout draws for one section. */
export interface NavItem extends NavSection {
  /** The long name: the phone's menu and top bar. */
  label: string;
  /** The short name under the rail's icon. */
  railLabel: string;
  /** Asks for attention: unread chats (`@` with a mention), requests and invites. */
  badge?: number | "@";
  /** Only informs: friends online, servers in the list. */
  count?: number;
  active: boolean;
}

import type { ReactNode } from "react";

import type { NavItem } from "../nav.ts";
import type { Section } from "../routeTable.ts";

/**
 * What a route puts on screen, independent of the layout that shows it.
 *
 * The phone shows one pane at a time: `aside` if the route has one, else
 * `detail`, else `list`. The wide layout shows `list` and `detail` side by
 * side and `aside` as a fourth column or a sheet. A screen never knows which.
 */
export interface RouteView {
  section: Section;
  /** The top-bar title of a detail route; the section's name on a root. */
  title: string;
  list: ReactNode;
  detail?: ReactNode;
  aside?: ReactNode;
  /** The header of the details column. */
  asideTitle?: string;
  /** The "up" target of the phone's back button. */
  parent?: string;
  /** The wide layout replaces a root without a detail with this path. */
  defaultDetail?: string;
  /** Actions of a root: the phone's top bar, the wide list's header. */
  headerActions?: ReactNode;
  /** A richer title of the detail — avatar, name, status — in place of `title`. */
  detailHeader?: ReactNode;
  /** Tools of the detail's header. */
  detailActions?: ReactNode;
}

export interface LayoutMe {
  name: string;
  avatarUrl?: string | null;
  /** What friends read about this browser: "Online from phone" or "Online in browser". */
  statusLabel: string;
  device: "phone" | "desktop";
}

export interface LayoutProps {
  view: RouteView;
  nav: NavItem[];
  me: LayoutMe;
  /** Whether chats or friends ask for attention: the dot on the menu button. */
  attention: boolean;
  navigate(path: string, options?: { replace?: boolean }): void;
  /** The phone's back button: see `history.ts`. */
  up(): void;
  /** The offline bar, the update bar, the install prompt. */
  banners: ReactNode;
}

export type LayoutComponent = (props: LayoutProps) => ReactNode;

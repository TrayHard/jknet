/**
 * The two layouts of the web app. `LayoutHost` picks one by the window's
 * size and hands it the route's panes; screens never know which one shows
 * them.
 */

import { PhoneDrawerLayout } from "./PhoneDrawerLayout.tsx";
import type { LayoutComponent } from "./types.ts";
import { WideThreePaneLayout } from "./WideThreePaneLayout.tsx";

export const layouts: { phone: LayoutComponent; wide: LayoutComponent } = {
  phone: PhoneDrawerLayout,
  wide: WideThreePaneLayout,
};

export type { LayoutComponent, LayoutMe, LayoutProps, RouteView } from "./types.ts";

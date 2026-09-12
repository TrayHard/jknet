import { EyeOff, Eye, Plug, Star, StarOff } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ServerInfo } from "../../lib/ipc";
import { useSetServerFavorite, useSetServerHidden } from "../../lib/queries";
import { Menu, useContextMenu, type MenuItem, type MenuSize } from "../ui";
import { ConnectDialog } from "./ConnectDialog";

/**
 * The actions of one server: the three lines, the commands behind them and the
 * dialog the first one opens.
 *
 * Two screens show them and both show the same three, so they live here rather
 * than in either screen: the Servers details panel puts them behind the dots
 * beside **Connect**, the rows of Home behind the dots at their right end, and
 * every row of both screens behind a right click.
 *
 * The dialog lives here too, and not on the two screens, for the same reason
 * the items do: it is a modal over the whole window, so where it hangs in the
 * tree decides nothing, while two copies of the state that opens it would be
 * two chances for the screens to disagree about what **Connect…** does.
 *
 * --- slice: selection context menu ---
 * `items` and `onSelect` take the server rather than closing over one, because
 * a right click names its row at the moment it happens: one set of handlers
 * serves a table of two hundred.
 */
export function useServerMenu(): {
  /** Accessible name of the list, wherever it is opened from. */
  ariaLabel: string;
  items: (server: ServerInfo) => MenuItem[];
  onSelect: (id: string, server: ServerInfo) => void;
  /** The **Connect…** dialog while it is open. Render it. */
  dialog: ReactNode;
} {
  const { t } = useTranslation("servers");
  const setFavorite = useSetServerFavorite();
  const setHidden = useSetServerHidden();
  /** The server the dialog is about, or `null` while it is closed. */
  const [dialog, setDialog] = useState<ServerInfo | null>(null);

  const items = (server: ServerInfo): MenuItem[] => [
    // --- slice: connect dialog ---
    // First, because it is the action the menu is opened for: the quick
    // Connect beside it answers «which client, as whom» on its own, and this
    // is where a player says otherwise.
    { id: "connect", label: t("menu.connect"), icon: <Plug size={14} /> },
    server.favorite
      ? {
          id: "unfavorite",
          label: t("row.removeFavorite"),
          icon: <StarOff size={14} />,
        }
      : {
          id: "favorite",
          label: t("row.addFavorite"),
          icon: <Star size={14} />,
        },
    server.hidden
      ? { id: "unhide", label: t("menu.unhide"), icon: <Eye size={14} /> }
      : {
          id: "hide",
          label: t("menu.hide"),
          icon: <EyeOff size={14} />,
          // Taking a server off every list is the one action here that removes
          // something, so it is the one drawn as such.
          danger: true,
        },
  ];

  const onSelect = (id: string, server: ServerInfo) => {
    if (id === "connect") {
      setDialog(server);
      return;
    }
    if (id === "favorite" || id === "unfavorite") {
      setFavorite.mutate({
        address: server.address,
        favorite: id === "favorite",
      });
      return;
    }
    setHidden.mutate({ address: server.address, hidden: id === "hide" });
  };

  return {
    ariaLabel: t("menu.actions"),
    items,
    onSelect,
    dialog:
      dialog === null ? null : (
        <ConnectDialog server={dialog} onClose={() => setDialog(null)} />
      ),
  };
}

/** The three-dot menu of one server. */
export function ServerMenu({
  server,
  size = "md",
}: {
  server: ServerInfo;
  size?: MenuSize;
}) {
  const menu = useServerMenu();

  return (
    <>
      <Menu
        ariaLabel={menu.ariaLabel}
        size={size}
        items={menu.items(server)}
        onSelect={(id) => menu.onSelect(id, server)}
      />
      {menu.dialog}
    </>
  );
}

// --- slice: selection context menu ---
/**
 * The same three actions, on a right click anywhere in a server row.
 *
 * One instance serves a whole list: the screen hands `open` the row the press
 * landed on and renders `menu` once. The press changes no selection — a player
 * asking what they can do with a row has not said they want to look at it.
 */
export function useServerContextMenu(): {
  /** Give it to `onContextMenu` of the row. */
  open: (event: ReactMouseEvent, server: ServerInfo) => void;
  menu: ReactNode;
} {
  const menu = useServerMenu();
  const context = useContextMenu<ServerInfo>({
    ariaLabel: menu.ariaLabel,
    items: menu.items,
    onSelect: menu.onSelect,
  });

  return {
    open: context.open,
    menu: (
      <>
        {context.menu}
        {menu.dialog}
      </>
    ),
  };
}

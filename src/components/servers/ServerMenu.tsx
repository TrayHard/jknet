import { EyeOff, Eye, Star, StarOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ServerInfo } from "../../lib/ipc";
import { useSetServerFavorite, useSetServerHidden } from "../../lib/queries";
import { Menu, type MenuItem, type MenuSize } from "../ui";

/**
 * The three-dot menu of one selected server.
 *
 * Two screens show it and both show the same two actions, so the items and the
 * two commands behind them live here rather than in either screen: the Servers
 * details panel puts it beside **Connect**, and a selected row of Home puts it
 * at the right end of the row.
 *
 * Only the selected server has one. A dots button on every row would be eight
 * more press targets down a list whose job is reading, and the two actions
 * behind it are ones a player takes after looking at a server, not while
 * scanning past it.
 *
 * **Connect…** of the design is not here yet: the dialog it opens is a slice of
 * its own, and a menu item that opens nothing is worse than an item that is not
 * there.
 */
export function ServerMenu({
  server,
  size = "md",
}: {
  server: ServerInfo;
  size?: MenuSize;
}) {
  const { t } = useTranslation("servers");
  const setFavorite = useSetServerFavorite();
  const setHidden = useSetServerHidden();

  const items: MenuItem[] = [
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

  return (
    <Menu
      ariaLabel={t("menu.actions")}
      size={size}
      items={items}
      onSelect={(id) => {
        if (id === "favorite" || id === "unfavorite") {
          setFavorite.mutate({
            address: server.address,
            favorite: id === "favorite",
          });
          return;
        }
        setHidden.mutate({ address: server.address, hidden: id === "hide" });
      }}
    />
  );
}

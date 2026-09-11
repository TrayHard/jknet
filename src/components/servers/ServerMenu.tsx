import { EyeOff, Eye, Plug, Star, StarOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ServerInfo } from "../../lib/ipc";
import { useSetServerFavorite, useSetServerHidden } from "../../lib/queries";
import { Menu, type MenuItem, type MenuSize } from "../ui";
import { ConnectDialog } from "./ConnectDialog";

/**
 * The three-dot menu of one server.
 *
 * Two screens show it and both show the same three actions, so the items, the
 * two commands behind them and the dialog the first one opens live here rather
 * than in either screen: the Servers details panel puts it beside **Connect**,
 * and the rows of Home put it at their right end.
 *
 * The dialog lives here too, and not on the two screens, for the same reason
 * the items do: it is a modal over the whole window, so where it hangs in the
 * tree decides nothing, while two copies of the state that opens it would be
 * two chances for the screens to disagree about what **Connect…** does.
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
  const [dialog, setDialog] = useState(false);

  const items: MenuItem[] = [
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

  return (
    <>
      <Menu
        ariaLabel={t("menu.actions")}
        size={size}
        items={items}
        onSelect={(id) => {
          if (id === "connect") {
            setDialog(true);
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
        }}
      />
      {dialog ? (
        <ConnectDialog server={server} onClose={() => setDialog(false)} />
      ) : null}
    </>
  );
}

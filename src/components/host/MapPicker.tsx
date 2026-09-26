import { Share2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { mapCard } from "../../lib/chat/cardDrafts";
import type { Game, HostMap } from "../../lib/ipc";
import { useHostMaps } from "../../lib/queries";
import { useShareDialog } from "../chat/ShareToChatDialog";
import { Button, Combobox, type ComboboxOption } from "../ui";
import { pickMap } from "./hostModel";
import { MapOption } from "./MapOption";

interface MapPickerProps {
  clientId: string | null;
  gametype: number;
  value: string;
  onChange: (map: string) => void;
  /** The map to fall back to when the chosen one leaves the list: the default of the game. */
  preferred: string | null;
  disabled?: boolean;
  className?: string;
  // --- slice: chat cards ---
  /**
   * The game of the maps, to offer **Share to chat** of the chosen one beside
   * the field. Left out, the field stands alone, as in the Change map dialog.
   */
  shareGame?: Game;
}

/**
 * The **Map** field: a Combobox of the maps of one client that offer one game
 * type, each drawn as the MapOption of the design.
 *
 * The list follows the client and the game type, so a choice can drop out of
 * it; the field then moves to the default map of the game, or to the first
 * map left, rather than send a map the server cannot load in that mode.
 */
export function MapPicker({
  clientId,
  gametype,
  value,
  onChange,
  preferred,
  disabled = false,
  className,
  shareGame,
}: MapPickerProps) {
  const { t } = useTranslation("host");
  const { t: tChat } = useTranslation("chat");
  const share = useShareDialog();
  const maps = useHostMaps(clientId, gametype);
  const list = useMemo<HostMap[]>(() => maps.data ?? [], [maps.data]);

  // A list that no longer holds the choice moves it. Only once the list is in:
  // a list still being read is not an empty one.
  useEffect(() => {
    if (!maps.isSuccess) return;
    const next = pickMap(
      list.map((map) => map.name),
      value,
      preferred,
    );
    if (next !== value) onChange(next);
  }, [maps.isSuccess, list, value, preferred, onChange]);

  const byName = useMemo(() => new Map(list.map((map) => [map.name, map])), [list]);
  const options = useMemo<ComboboxOption[]>(
    () =>
      list.map((map) => ({
        value: map.name,
        label: map.name,
        hint: map.title ?? undefined,
      })),
    [list],
  );

  const placeholder = maps.isLoading
    ? t("setup.map.loading")
    : maps.isSuccess && list.length === 0
      ? t("setup.map.none")
      : undefined;

  const field = (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={t("setup.map.label")}
      searchLabel={t("setup.map.search")}
      emptyText={t("setup.map.noMatch")}
      placeholder={placeholder}
      disabled={disabled}
      className={shareGame === undefined ? className : "min-w-0 flex-1"}
      renderOption={(option, place) => {
        const map = byName.get(option.value);
        if (map === undefined) return option.label;
        return <MapOption map={map} selected={place === "list" && option.value === value} />;
      }}
    />
  );

  // --- slice: chat cards --- the chosen map, as a map card.
  const chosen = byName.get(value);
  if (shareGame === undefined || !share.available) return field;
  return (
    <div className={`flex items-center gap-8 ${className ?? ""}`}>
      {field}
      <Button
        variant="ghost"
        icon={<Share2 size={16} />}
        disabled={chosen === undefined}
        title={tChat("share.action")}
        aria-label={tChat("share.actionNamed", { name: value })}
        onClick={() => {
          if (chosen !== undefined) share.open({ kind: "card", card: mapCard(chosen, shareGame) });
        }}
        className="shrink-0 px-8"
      />
      {share.dialog}
    </div>
  );
}

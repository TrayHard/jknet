import { Share2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useGametypeLabels } from "../../i18n/useGameLabels";
import { mapCard } from "../../lib/chat/cardDrafts";
import type { Game, HostGametypeOption, HostMap } from "../../lib/ipc";
import { useHostMaps } from "../../lib/queries";
import { useShareDialog } from "../chat/ShareToChatDialog";
import { Button, Combobox, type ComboboxOption } from "../ui";
import { pickMap } from "./hostModel";
import { MapOption } from "./MapOption";
import { groupHostMaps } from "./mapGroups";

interface MapPickerProps {
  game: Game;
  gametypes: HostGametypeOption[];
  clientId: string | null;
  value: string;
  onChange: (map: string) => void;
  /** The map to fall back to when the chosen one leaves the list: the default of the game. */
  preferred: string | null;
  disabled?: boolean;
  className?: string;
  /** Keep an authored map visible until the player explicitly replaces it. */
  preserveSelection?: boolean;
  // --- slice: chat cards ---
  /**
   * Offer **Share to chat** of the chosen map beside the field. Left out, the
   * field stands alone, as in the Change map dialog.
   */
  share?: boolean;
}

/**
 * The **Map** field lists every discovered map of the selected client.
 *
 * Only changing the client's installed maps can remove a choice. Changing
 * the game type must never filter the list or replace the player's map.
 */
export function MapPicker({
  game,
  gametypes,
  clientId,
  value,
  onChange,
  preferred,
  disabled = false,
  className,
  preserveSelection = false,
  share: shareable = false,
}: MapPickerProps) {
  const { t } = useTranslation("host");
  const { t: tChat } = useTranslation("chat");
  const share = useShareDialog();
  const { label: modeLabel } = useGametypeLabels();
  const maps = useHostMaps(clientId);
  const list = useMemo<HostMap[]>(() => maps.data ?? [], [maps.data]);

  // A list that no longer holds the choice moves it. Only once the list is in:
  // a list still being read is not an empty one.
  useEffect(() => {
    if (!maps.isSuccess || preserveSelection) return;
    const next = pickMap(
      list.map((map) => map.name),
      value,
      preferred,
    );
    if (next !== value) onChange(next);
  }, [maps.isSuccess, list, value, preferred, onChange, preserveSelection]);

  const byName = useMemo(() => new Map(list.map((map) => [map.name, map])), [list]);
  const grouped = useMemo(() => groupHostMaps(list, gametypes.map((mode) => ({
    id: mode.id,
    label: modeLabel(game, mode.index, mode.label),
  }))), [list, gametypes, game, modeLabel]);
  const modesByName = useMemo(() => new Map(grouped.map((entry) => [entry.map.name, entry.modeLabels])), [grouped]);
  const options = useMemo<ComboboxOption[]>(
    () =>
      [...(preserveSelection && value && !list.some((map) => map.name === value)
        ? [{ value, label: value, hint: t("setup.config.mapNotListed"), group: t("setup.map.unspecifiedMode") }] : []), ...grouped.map(({ map, group, modeLabels }) => ({
        value: map.name,
        label: map.name,
        hint: [map.title, ...map.gametypes, ...modeLabels].filter(Boolean).join(" "),
        group: group ?? t("setup.map.unspecifiedMode"),
      }))],
    [list, grouped, preserveSelection, value, t],
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
      listMinWidth={420}
      disabled={disabled}
      className={shareable ? "min-w-0 flex-1" : className}
      renderOption={(option, place) => {
        const map = byName.get(option.value);
        if (map === undefined) return option.label;
        return <MapOption
          map={map}
          selected={place === "list" && option.value === value}
          modeLabels={place === "list" ? modesByName.get(map.name) : undefined}
          showSource={place === "list"}
        />;
      }}
    />
  );

  // --- slice: chat cards --- the chosen map, as a map card.
  const chosen = byName.get(value);
  if (!shareable || !share.available) return field;
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
          if (chosen !== undefined) share.open({ kind: "card", card: mapCard(chosen, game) });
        }}
        className="shrink-0 px-8"
      />
      {share.dialog}
    </div>
  );
}

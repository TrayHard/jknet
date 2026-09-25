import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { HostMap } from "../../lib/ipc";
import { useHostMaps } from "../../lib/queries";
import { Combobox, type ComboboxOption } from "../ui";
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
}: MapPickerProps) {
  const { t } = useTranslation("host");
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

  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={t("setup.map.label")}
      searchLabel={t("setup.map.search")}
      emptyText={t("setup.map.noMatch")}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      renderOption={(option, place) => {
        const map = byName.get(option.value);
        if (map === undefined) return option.label;
        return <MapOption map={map} selected={place === "list" && option.value === value} />;
      }}
    />
  );
}

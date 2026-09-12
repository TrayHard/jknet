import { Blocks, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import {
  assembledSkinValue,
  parseAssembledSkin,
  skinIconUrl,
  type AssembledSkin,
  type ModelPart,
  type PlayerModel,
} from "../../lib/ipc";
import { usePlayerModels } from "../../lib/queries";
import { Input } from "../ui";

// --- slice: connect dialog ---
/**
 * How much room the grid takes.
 *
 * `md` is the profile form of the client window, which owns its page. `sm` is
 * the **Connect…** dialog, where the grid is one field of a modal that also
 * has to hold a nickname, two hilts, an argument field and a command line — so
 * the tiles shrink rather than the dialog growing past the window.
 */
export type SkinPickerSize = "sm" | "md";

/** What each size measures, in the pixel scale of the design tokens. */
const SIZES: Record<SkinPickerSize, { icon: string; column: string; list: string }> = {
  sm: { icon: "size-44", column: "52px", list: "max-h-160" },
  md: { icon: "size-64", column: "72px", list: "max-h-232" },
};

/**
 * The grid of skins a profile may pick from.
 *
 * Icons and not a dropdown, because that is what the game's own menu does and
 * because `kyle/red` says nothing about what it looks like. There is no 3D
 * preview and there cannot be one: `.glm` is Raven's Ghoul2 and the only code
 * that draws it is the engine's own renderer. The 128×128 icon inside the pk3
 * is what exists, so it is what this shows.
 *
 * A skin whose icon could not be read — a TGA the decoder refuses, a picture
 * past the size limit — keeps its place as a text tile rather than vanishing:
 * the value is still one the cvar takes.
 *
 * --- slice: assembled skins ---
 * Six of the models are not picked whole but built out of a head, a torso and
 * a pair of legs. They stand in the same grid, marked **Assembled**, and
 * picking one opens three rows of parts under it. The value is assembled on
 * every click, so the token preview and the profile always hold a whole
 * `<model>/<head>|<torso>|<legs>` and never a half-made one.
 */
export function SkinPicker({
  clientId,
  value,
  onChange,
  size = "md",
  tintBelow = false,
}: {
  clientId: string;
  /** The `model` of the profile, or `null` when it sets none. */
  value: string | null;
  onChange: (value: string | null) => void;
  size?: SkinPickerSize;
  /**
   * Whether the form around this picker carries the **Character tint**
   * sliders. The parts of an assembled jedi say nothing about its colour —
   * the game sets it from `char_color_*` — and the panel says so where the
   * player can act on it. The **Connect…** dialog manages no tint, so it
   * leaves this off rather than pointing at a control that is not there.
   */
  tintBelow?: boolean;
}) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const [query, setQuery] = useState("");
  const models = usePlayerModels(clientId, true);
  const metrics = SIZES[size];

  const found = useMemo(() => {
    const words = query.trim().toLowerCase();
    if (words === "") return models.data ?? [];
    return (models.data ?? []).filter(
      (model) =>
        model.model.includes(words) ||
        model.variant.includes(words) ||
        model.value.includes(words),
    );
  }, [models.data, query]);

  // The assembled model the value names, if it names one the client still
  // carries. A profile written when a mod was installed keeps its value after
  // the mod is gone; then there is no panel to open and the grid shows no tile
  // selected, which is what a skin the client cannot load should look like.
  const building = useMemo(() => {
    const picked = parseAssembledSkin(value);
    if (picked === null) return null;
    for (const model of models.data ?? []) {
      if (model.parts !== null && model.model === picked.model) {
        return { model: model.model, parts: model.parts, picked };
      }
    }
    return null;
  }, [models.data, value]);

  if (models.error) {
    return (
      <p role="alert" className="text-body-sm text-fg-danger break-words">
        {errorText(models.error)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <Input
        type="search"
        icon={<Search size={14} />}
        value={query}
        className={size === "sm" ? "h-28" : undefined}
        placeholder={t("clientWindow.profiles.form.skinSearch")}
        aria-label={t("clientWindow.profiles.form.skinSearch")}
        onChange={(event) => setQuery(event.target.value)}
      />

      {models.isLoading ? (
        <p className="flex items-center gap-8 text-body-sm text-fg-muted">
          <Loader2 size={14} className="text-fg-accent animate-spin shrink-0" />
          {t("clientWindow.profiles.form.skinLoading")}
        </p>
      ) : (models.data ?? []).length === 0 ? (
        <p className="text-body-sm text-fg-muted">
          {t("clientWindow.profiles.form.skinEmpty")}
        </p>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label={t("clientWindow.profiles.form.skin")}
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${metrics.column}, 1fr))`,
            }}
            className={cn(
              "grid gap-8 overflow-y-auto p-8",
              metrics.list,
              "rounded-md border border-line bg-input",
            )}
          >
            <Tile
              selected={value === null}
              caption={t("clientWindow.profiles.form.skinNone")}
              icon={metrics.icon}
              onSelect={() => onChange(null)}
            />
            {found.map((model) => (
              <SkinTile
                key={model.parts === null ? model.value : `${model.model}/|`}
                model={model}
                // An assembled model is one tile however its parts are set,
                // so it answers for every value that names it.
                selected={
                  model.parts === null
                    ? model.value === value
                    : building?.model === model.model
                }
                picked={
                  building?.model === model.model ? building.picked : null
                }
                icon={metrics.icon}
                onSelect={() => {
                  // Clicking the tile of the model already being assembled
                  // keeps the parts the player chose. `model.value` carries
                  // the first part of each row, and a second click that threw
                  // a choice away would be a trap.
                  if (building?.model === model.model) return;
                  onChange(model.value);
                }}
              />
            ))}
          </div>
          {found.length === 0 ? (
            <p className="text-body-sm text-fg-muted">
              {t("clientWindow.profiles.form.skinNoMatch", { query: query.trim() })}
            </p>
          ) : null}
          {building === null ? null : (
            <PartsPanel
              parts={building.parts}
              picked={building.picked}
              icon={metrics.icon}
              tintBelow={tintBelow}
              onChange={(next) => onChange(assembledSkinValue(next))}
            />
          )}
        </>
      )}
    </div>
  );
}

// --- slice: assembled skins ---

/** The three rows, in the order the engine reads the value back. */
const ROWS = [
  {
    key: "heads",
    label: "clientWindow.profiles.form.skinPartHead",
    field: "head",
  },
  {
    key: "torsos",
    label: "clientWindow.profiles.form.skinPartTorso",
    field: "torso",
  },
  {
    key: "legs",
    label: "clientWindow.profiles.form.skinPartLegs",
    field: "legs",
  },
] as const;

/**
 * The head, the torso and the legs of the assembled model that is selected.
 *
 * One row of icons each, the current part lit, and the value rebuilt on every
 * click — there is no **Apply**, because a half-assembled value is not a thing
 * the cvar can hold. The colour of a jedi is not here: the game takes it from
 * `char_color_*`, which the profile owns as three sliders of its own.
 */
function PartsPanel({
  parts,
  picked,
  icon,
  tintBelow,
  onChange,
}: {
  parts: NonNullable<PlayerModel["parts"]>;
  picked: AssembledSkin;
  icon: string;
  tintBelow: boolean;
  onChange: (value: AssembledSkin) => void;
}) {
  const { t } = useTranslation("clients");

  return (
    <div className="flex flex-col gap-8 rounded-md border border-line bg-input p-8">
      {/* The word the tile has no room for. */}
      <p className="flex items-center gap-4 text-label-xs text-fg-accent">
        <Blocks size={12} className="shrink-0" />
        {t("clientWindow.profiles.form.skinAssembled")}
        <span className="text-fg-muted normal-case tracking-normal">
          {picked.model}
        </span>
      </p>
      {ROWS.map((row) => (
        <PartRow
          key={row.key}
          label={t(row.label)}
          parts={parts[row.key]}
          value={picked[row.field]}
          icon={icon}
          onSelect={(id) => onChange({ ...picked, [row.field]: id })}
        />
      ))}
      {tintBelow ? (
        <p className="text-body-sm text-fg-muted">
          {t("clientWindow.profiles.form.skinPartsTint")}
        </p>
      ) : null}
    </div>
  );
}

/** One row of parts: its name, then its icons on a line that scrolls. */
function PartRow({
  label,
  parts,
  value,
  icon,
  onSelect,
}: {
  label: string;
  parts: ModelPart[];
  value: string;
  icon: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("clients");
  // A part the client no longer carries still stands in the value, so it keeps
  // a tile of its own: a row with nothing lit over a value that is set would
  // read as a choice the player never made.
  const missing = parts.every((part) => part.id !== value);

  return (
    <div className="flex flex-col gap-4">
      <span className="text-label-xs text-fg-muted">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex gap-8 overflow-x-auto pb-4"
      >
        {parts.map((part) => (
          <Tile
            key={part.id}
            selected={part.id === value}
            caption={partCaption(part.id)}
            title={part.id}
            icon={icon}
            onSelect={() => onSelect(part.id)}
            picture={
              skinIconUrl(part.icon) === null ? (
                <span className="text-label-xs text-fg-muted text-center px-4">
                  {t("clientWindow.profiles.form.skinNoIcon")}
                </span>
              ) : (
                <img
                  src={skinIconUrl(part.icon) ?? undefined}
                  alt=""
                  loading="lazy"
                  className={cn(icon, "object-cover rounded-sm")}
                />
              )
            }
          />
        ))}
        {missing ? (
          <Tile
            selected
            caption={partCaption(value)}
            title={value}
            icon={icon}
            onSelect={() => onSelect(value)}
            picture={
              <span className="text-label-xs text-fg-muted text-center px-4">
                {t("clientWindow.profiles.form.skinNoIcon")}
              </span>
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a part tile is captioned: `head_a1` under the **Head** row is `a1`.
 *
 * The prefix is the row, and the row is already named above the line. The
 * whole name stays in the tooltip, because it is what the cvar carries.
 */
function partCaption(id: string): string {
  const underscore = id.indexOf("_");
  return underscore < 0 ? id : id.slice(underscore + 1);
}

/** One skin of the grid: its icon when there is one, its name when there is not. */
function SkinTile({
  model,
  selected,
  picked,
  icon,
  onSelect,
}: {
  model: PlayerModel;
  selected: boolean;
  /**
   * --- slice: assembled skins ---
   * The parts the value names, when this tile is the assembled model that is
   * selected. The tile then wears the head the player chose rather than the
   * one the list opens on, which is also the picture the game itself falls
   * back to for a three-part skin.
   */
  picked: AssembledSkin | null;
  icon: string;
  onSelect: () => void;
}) {
  const { t } = useTranslation("clients");
  const assembled = model.parts !== null;
  const head =
    picked === null
      ? null
      : (model.parts?.heads.find((part) => part.id === picked.head) ?? null);
  const url = skinIconUrl(head === null ? model.icon : head.icon);
  const caption = assembled
    ? model.model
    : model.variant === "default"
      ? model.model
      : `${model.model}/${model.variant}`;
  // What the cvar would hold: the parts the player picked when this is the
  // assembled model they are building, and the list's own value otherwise.
  const value =
    picked === null ? model.value : assembledSkinValue(picked);

  return (
    <Tile
      selected={selected}
      caption={caption}
      title={
        assembled
          ? `${t("clientWindow.profiles.form.skinAssembled")} · ${value}`
          : value
      }
      icon={icon}
      onSelect={onSelect}
      badge={assembled ? <Blocks size={12} /> : undefined}
      picture={
        url === null ? (
          <span className="text-label-xs text-fg-muted text-center px-4">
            {t("clientWindow.profiles.form.skinNoIcon")}
          </span>
        ) : (
          <img
            src={url}
            alt=""
            loading="lazy"
            className={cn(icon, "object-cover rounded-sm")}
          />
        )
      }
    />
  );
}

/** The shell every tile of the grid shares, the «Not set» one included. */
function Tile({
  selected,
  caption,
  title,
  picture,
  badge,
  icon,
  onSelect,
}: {
  selected: boolean;
  caption: string;
  title?: string;
  picture?: React.ReactNode;
  /**
   * --- slice: assembled skins ---
   * A mark in the corner of the picture, for a tile that is not what the rest
   * of the grid is.
   *
   * A glyph and not the word **Assembled**: the tiles are 44 px wide in the
   * **Connect…** dialog and 64 px in the client window, and the word is about
   * 56 px at the smallest size the design tokens carry. It would be cut in
   * both. The word itself is on the button's tooltip and over the panel the
   * tile opens, where there is a line to put it on.
   */
  badge?: React.ReactNode;
  /** Tailwind size class of the picture, from the grid's own metrics. */
  icon: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      title={title ?? caption}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-center gap-4 p-4 rounded-md border transition-colors duration-150",
        "shrink-0",
        selected
          ? "border-line-focus bg-accent-subtle"
          : "border-transparent hover:bg-hover-overlay",
      )}
    >
      <span
        className={cn(
          "relative flex items-center justify-center rounded-sm bg-elevated overflow-hidden",
          icon,
        )}
      >
        {picture}
        {badge === undefined ? null : (
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-2 right-2 flex items-center justify-center",
              "size-16 rounded-sm bg-accent-subtle text-fg-accent",
            )}
          >
            {badge}
          </span>
        )}
      </span>
      <span className="w-full text-label-xs text-fg-secondary text-center truncate">
        {caption}
      </span>
    </button>
  );
}

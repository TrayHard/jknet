import { Loader2, Search } from "lucide-react";
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
import { useAssembledPreview, usePlayerModels } from "../../lib/queries";
import { Input } from "../ui";

// --- slice: connect dialog ---
/**
 * How much room the grid takes.
 *
 * `md` is the profile form of the client window, which owns its page. `sm` is
 * the **Connect…** dialog, where the grid is one field of a modal that also
 * has to hold a nickname, the saber controls, an argument field and a command
 * line — so the tiles shrink rather than the dialog growing past the window.
 */
export type SkinPickerSize = "sm" | "md";

/** What each size measures, in the pixel scale of the design tokens. */
const SIZES: Record<
  SkinPickerSize,
  { icon: string; column: string; list: string; card: string }
> = {
  // --- slice: skins and hilts ---
  // The card is the icon three times over, because the composed preview is
  // three square rows stacked: a frame of any other shape would either
  // letterbox the picture or cut a row off it.
  sm: { icon: "size-44", column: "52px", list: "max-h-160", card: "w-44 h-132" },
  md: { icon: "size-64", column: "72px", list: "max-h-232", card: "w-64 h-192" },
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
 * a pair of legs. Picking one opens three rows of parts under it, and the
 * value is assembled on every click, so the token preview and the profile
 * always hold a whole `<model>/<head>|<torso>|<legs>` and never a half-made
 * one.
 *
 * --- slice: skins and hilts ---
 * Those six stand in a group of their own, **Custom characters**, under the
 * grid of whole skins, and each wears a picture of the character it is
 * currently set to rather than the icon of its head. Among the whole skins
 * they were a tile that looked like the others and behaved differently, and
 * the head icon alone was a cut-out face over a dark surface. The picture is
 * composed by the core; see `appearance::compose_preview`.
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

  // --- slice: skins and hilts ---
  // Two groups out of one list, because the two are picked differently: a
  // whole skin is one click and a character is a click plus three rows.
  const stock = found.filter((model) => model.parts === null);
  const characters = found.filter((model) => model.parts !== null);

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

  // --- slice: skins and hilts ---
  // The picture of the combination being built. Only one combination is ever
  // being built, so one query answers both the card in the group and the
  // panel under it. While it is in flight the card keeps the picture of the
  // combination the list opened on, which is the same character in different
  // clothes rather than an empty frame.
  const composed = useAssembledPreview(
    clientId,
    building === null ? null : assembledSkinValue(building.picked),
  );

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
              frame={metrics.icon}
              onSelect={() => onChange(null)}
            />
            {stock.map((model) => (
              <SkinTile
                key={model.value}
                model={model}
                selected={model.value === value}
                frame={metrics.icon}
                onSelect={() => onChange(model.value)}
              />
            ))}
          </div>

          {characters.length === 0 ? null : (
            <div className="flex flex-col gap-4">
              <span className="text-label-xs text-fg-muted">
                {t("clientWindow.profiles.form.skinCustom")}
              </span>
              <div
                role="radiogroup"
                aria-label={t("clientWindow.profiles.form.skinCustom")}
                className="flex gap-8 overflow-x-auto p-8 rounded-md border border-line bg-input"
              >
                {characters.map((model) => (
                  <CharacterCard
                    key={model.model}
                    model={model}
                    // A character is one card however its parts are set, so
                    // it answers for every value that names it.
                    selected={building?.model === model.model}
                    preview={
                      building?.model === model.model
                        ? (composed.data ?? model.preview)
                        : model.preview
                    }
                    picked={
                      building?.model === model.model ? building.picked : null
                    }
                    frame={metrics.card}
                    onSelect={() => {
                      // Clicking the card of the character already being
                      // built keeps the parts the player chose. `model.value`
                      // carries the first part of each row, and a second
                      // click that threw a choice away would be a trap.
                      if (building?.model === model.model) return;
                      onChange(model.value);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {found.length === 0 ? (
            <p className="text-body-sm text-fg-muted">
              {t("clientWindow.profiles.form.skinNoMatch", { query: query.trim() })}
            </p>
          ) : null}
          {building === null ? null : (
            <PartsPanel
              parts={building.parts}
              picked={building.picked}
              preview={composed.data ?? null}
              frame={metrics.icon}
              card={metrics.card}
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
 * The head, the torso and the legs of the character that is selected.
 *
 * One row of icons each, the current part lit, and the value rebuilt on every
 * click — there is no **Apply**, because a half-assembled value is not a thing
 * the cvar can hold. The colour of a jedi is not here: the game takes it from
 * `char_color_*`, which the profile owns as three sliders of its own.
 *
 * --- slice: skins and hilts ---
 * The picture of what the three rows add up to stands beside them, so the
 * player sees the character and not only the parts. It is the same composed
 * file the card in the group above wears.
 */
function PartsPanel({
  parts,
  picked,
  preview,
  frame,
  card,
  tintBelow,
  onChange,
}: {
  parts: NonNullable<PlayerModel["parts"]>;
  picked: AssembledSkin;
  preview: string | null;
  frame: string;
  card: string;
  tintBelow: boolean;
  onChange: (value: AssembledSkin) => void;
}) {
  const { t } = useTranslation("clients");

  return (
    <div className="flex gap-8 rounded-md border border-line bg-input p-8">
      <Picture
        src={preview}
        frame={card}
        alt={t("clientWindow.profiles.form.skinPreview", { model: picked.model })}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-8">
        <p className="text-label-xs text-fg-accent">
          {t("clientWindow.profiles.form.skinAssembled")}
          <span className="text-fg-muted normal-case tracking-normal"> {picked.model}</span>
        </p>
        {ROWS.map((row) => (
          <PartRow
            key={row.key}
            label={t(row.label)}
            parts={parts[row.key]}
            value={picked[row.field]}
            frame={frame}
            onSelect={(id) => onChange({ ...picked, [row.field]: id })}
          />
        ))}
        {tintBelow ? (
          <p className="text-body-sm text-fg-muted">
            {t("clientWindow.profiles.form.skinPartsTint")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** One row of parts: its name, then its icons on a line that scrolls. */
function PartRow({
  label,
  parts,
  value,
  frame,
  onSelect,
}: {
  label: string;
  parts: ModelPart[];
  value: string;
  frame: string;
  onSelect: (id: string) => void;
}) {
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
          <PartTile
            key={part.id}
            part={part}
            selected={part.id === value}
            frame={frame}
            onSelect={() => onSelect(part.id)}
          />
        ))}
        {missing ? (
          <PartTile
            part={{ id: value, icon: null }}
            selected
            frame={frame}
            onSelect={() => onSelect(value)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** One part of one row. */
function PartTile({
  part,
  selected,
  frame,
  onSelect,
}: {
  part: ModelPart;
  selected: boolean;
  frame: string;
  onSelect: () => void;
}) {
  return (
    <Tile
      selected={selected}
      caption={partCaption(part.id)}
      title={part.id}
      frame={frame}
      onSelect={onSelect}
      // --- slice: skins and hilts ---
      // A part icon is a cut-out limb: whatever the artist removed is
      // transparent, and over the dark surface of the page the head read as a
      // hole. The plate is the one light ground of the launcher and the very
      // colour the core paints behind the composed preview.
      plate
      picture={<Picture src={part.icon} frame={frame} />}
    />
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

/** One whole skin of the grid: its icon when there is one, its name when not. */
function SkinTile({
  model,
  selected,
  frame,
  onSelect,
}: {
  model: PlayerModel;
  selected: boolean;
  frame: string;
  onSelect: () => void;
}) {
  const caption =
    model.variant === "default" ? model.model : `${model.model}/${model.variant}`;

  return (
    <Tile
      selected={selected}
      caption={caption}
      title={model.value}
      frame={frame}
      onSelect={onSelect}
      picture={<Picture src={model.icon} frame={frame} />}
    />
  );
}

// --- slice: skins and hilts ---

/**
 * One character of the **Custom characters** group.
 *
 * Portrait and not square, because the picture is a head over a torso over a
 * pair of legs and that is the shape a person has. The card wears the
 * combination the value names as soon as one is picked, so the group is a row
 * of characters and not a row of faces.
 */
function CharacterCard({
  model,
  selected,
  preview,
  picked,
  frame,
  onSelect,
}: {
  model: PlayerModel;
  selected: boolean;
  /** The composed picture, or `null` when none of the icons could be read. */
  preview: string | null;
  /** The parts the value names, when this is the character being built. */
  picked: AssembledSkin | null;
  frame: string;
  onSelect: () => void;
}) {
  const { t } = useTranslation("clients");
  // What the cvar would hold: the parts the player picked when this is the
  // character they are building, and the list's own value otherwise.
  const value = picked === null ? model.value : assembledSkinValue(picked);

  return (
    <Tile
      selected={selected}
      caption={model.model}
      title={`${t("clientWindow.profiles.form.skinAssembled")} · ${value}`}
      frame={frame}
      plate
      onSelect={onSelect}
      picture={
        <Picture
          src={preview}
          frame={frame}
          alt={t("clientWindow.profiles.form.skinPreview", { model: model.model })}
        />
      }
    />
  );
}

/**
 * A cached picture of the core, or the words that stand in for one.
 *
 * `alt` is empty for an icon that repeats its own caption — a screen reader
 * would read `kyle` twice — and carries the character's name for a composed
 * preview, which is the one picture here that says something the caption does
 * not.
 */
function Picture({
  src,
  frame,
  alt = "",
}: {
  src: string | null;
  frame: string;
  alt?: string;
}) {
  const { t } = useTranslation("clients");
  const url = skinIconUrl(src);

  if (url === null) {
    return (
      <span className="text-label-xs text-fg-muted text-center px-4">
        {t("clientWindow.profiles.form.skinNoIcon")}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className={cn(frame, "object-cover rounded-sm")}
    />
  );
}

/** The shell every tile and card shares, the «Not set» one included. */
function Tile({
  selected,
  caption,
  title,
  picture,
  frame,
  plate = false,
  onSelect,
}: {
  selected: boolean;
  caption: string;
  title?: string;
  picture?: React.ReactNode;
  /** Tailwind size class of the picture, from the grid's own metrics. */
  frame: string;
  /**
   * --- slice: skins and hilts ---
   * Whether the picture sits on the light plate. On for anything that may
   * carry an alpha channel of its own: a part icon and a composed preview.
   */
  plate?: boolean;
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
          "relative flex items-center justify-center rounded-sm overflow-hidden",
          plate ? "bg-icon-plate" : "bg-elevated",
          frame,
        )}
      >
        {picture}
      </span>
      <span className="w-full text-label-xs text-fg-secondary text-center truncate">
        {caption}
      </span>
    </button>
  );
}

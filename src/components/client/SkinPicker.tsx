import { Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import { skinIconUrl, type PlayerModel } from "../../lib/ipc";
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
 */
export function SkinPicker({
  clientId,
  value,
  onChange,
  size = "md",
}: {
  clientId: string;
  /** The `model` of the profile, or `null` when it sets none. */
  value: string | null;
  onChange: (value: string | null) => void;
  size?: SkinPickerSize;
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
                key={model.value}
                model={model}
                selected={model.value === value}
                icon={metrics.icon}
                onSelect={() => onChange(model.value)}
              />
            ))}
          </div>
          {found.length === 0 ? (
            <p className="text-body-sm text-fg-muted">
              {t("clientWindow.profiles.form.skinNoMatch", { query: query.trim() })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One skin of the grid: its icon when there is one, its name when there is not. */
function SkinTile({
  model,
  selected,
  icon,
  onSelect,
}: {
  model: PlayerModel;
  selected: boolean;
  icon: string;
  onSelect: () => void;
}) {
  const { t } = useTranslation("clients");
  const url = skinIconUrl(model.icon);
  const caption = model.variant === "default" ? model.model : `${model.model}/${model.variant}`;

  return (
    <Tile
      selected={selected}
      caption={caption}
      title={model.value}
      icon={icon}
      onSelect={onSelect}
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
  icon,
  onSelect,
}: {
  selected: boolean;
  caption: string;
  title?: string;
  picture?: React.ReactNode;
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
        selected
          ? "border-line-focus bg-accent-subtle"
          : "border-transparent hover:bg-hover-overlay",
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center rounded-sm bg-elevated overflow-hidden",
          icon,
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

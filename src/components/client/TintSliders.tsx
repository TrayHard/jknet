import { useTranslation } from "react-i18next";
import { cn } from "../../lib/format";
import type { CharColor } from "../../lib/ipc";
import { Slider } from "./Slider";
const DEFAULT_TINT: CharColor = { red: 255, green: 255, blue: 255 };

/** The three channels of `char_color_*`, with the colour they make. */
export function TintSliders({
  value,
  onChange,
}: {
  value: CharColor | null;
  onChange: (value: CharColor) => void;
}) {
  const { t } = useTranslation("clients");
  const tint = value ?? DEFAULT_TINT;
  const channels: Array<[keyof CharColor, string]> = [
    ["red", t("clientWindow.profiles.form.charColorRed")],
    ["green", t("clientWindow.profiles.form.charColorGreen")],
    ["blue", t("clientWindow.profiles.form.charColorBlue")],
  ];

  return (
    <div className="flex items-center gap-12">
      <span
        aria-hidden="true"
        className={cn(
          "size-36 shrink-0 rounded-md border border-line",
          value === null ? "opacity-40" : undefined,
        )}
        style={{ backgroundColor: `rgb(${tint.red} ${tint.green} ${tint.blue})` }}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {channels.map(([channel, label]) => (
          <label key={channel} className="flex items-center gap-8">
            <span className="w-44 shrink-0 text-label-xs text-fg-muted">{label}</span>
            <Slider
              className="flex-1 min-w-0"
              min={0}
              max={255}
              step={1}
              value={tint[channel]}
              aria-label={label}
              onChange={(event) =>
                onChange({ ...tint, [channel]: Number(event.target.value) })
              }
            />
            {/* The number beside the track, because a colour channel is a
                value a player copies and types back, not only a position. */}
            <span className="w-32 shrink-0 text-mono-xs text-fg-secondary text-right tabular-nums">
              {tint[channel]}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}


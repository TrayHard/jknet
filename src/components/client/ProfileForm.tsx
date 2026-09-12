import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn, commandLine } from "../../lib/format";
import {
  NO_SECOND_HILT,
  SABER_COLORS,
  type CharColor,
  type Client,
  type PlayerProfile,
  type SaberHilt,
} from "../../lib/ipc";
import {
  useAppearanceEvents,
  useGameInfo,
  useSaberHilts,
  useSaveProfile,
} from "../../lib/queries";
import {
  Button,
  Input,
  Select,
  type SelectOption,
  type SelectSize,
} from "../ui";
import { SettingRow } from "./CvarControls";
import { MAX_NICKNAME_BYTES, NicknameField, nicknameBytes } from "./NicknameField";
import { SkinPicker } from "./SkinPicker";
import { Slider } from "./Slider";

/** The tint the sliders start on when the player switches the tint on. */
const DEFAULT_TINT: CharColor = { red: 255, green: 255, blue: 255 };

/** An empty profile, which is what **New profile** opens the form on. */
export function blankProfile(): PlayerProfile {
  return {
    id: "",
    name: "",
    nickname: null,
    model: null,
    saber1: null,
    saber2: null,
    color1: null,
    color2: null,
    charColor: null,
  };
}

/**
 * The form that fills one player profile in.
 *
 * Every field but the name is optional, and an empty one means «this profile
 * has no opinion»: no token goes out and the engine keeps whatever its own
 * configuration says. That is why each list carries a **Not set** option and
 * the tint carries a clear button — a control with no empty state would make a
 * profile say something the player never chose.
 *
 * The draft lives here and reaches the core only on **Save profile**. A form
 * that wrote on every keystroke would rewrite `profiles.json` a dozen times
 * per nickname and, worse, would leave half a profile behind when the player
 * changed their mind.
 */
export function ProfileForm({
  client,
  profile,
  onDone,
}: {
  client: Client;
  profile: PlayerProfile;
  onDone: () => void;
}) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const save = useSaveProfile(client.id);
  const [draft, setDraft] = useState<PlayerProfile>(profile);
  // A pk3 installed in the main window while this form is open carries skins
  // and hilts this form should offer.
  useAppearanceEvents();

  // --- slice: player profiles ---
  // Jedi Outcast ships no `ext_data/sabers/`, so there is no hilt to name and
  // the core writes neither cvar. The two lists are hidden rather than left
  // empty: an empty list looks like a launcher that failed to read something.
  const hasHilts = useGameInfo(client.game)?.hasSaberHilts ?? true;
  const hilts = useSaberHilts(client.id, hasHilts);

  const edit = (changes: Partial<PlayerProfile>) =>
    setDraft((current) => ({ ...current, ...changes }));

  const tokens = profileTokens(draft, hasHilts);
  // The core refuses a nickname over `MAX_NETNAME`, so the button says so
  // before the round trip does. The field itself shows the count.
  const ready =
    draft.name.trim() !== "" &&
    nicknameBytes(draft.nickname ?? "") <= MAX_NICKNAME_BYTES &&
    !save.isPending;

  return (
    <form
      className="flex flex-col gap-8 rounded-md border border-line-accent bg-elevated p-12"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        save.mutate(draft, { onSuccess: () => onDone() });
      }}
    >
      <h3 className="text-label-xs text-fg-muted">
        {profile.id === ""
          ? t("clientWindow.profiles.form.newHeading")
          : t("clientWindow.profiles.form.editHeading", { profile: profile.name })}
      </h3>

      <SettingRow
        label={t("clientWindow.profiles.form.name")}
        htmlFor="profile-form-name"
      >
        <Input
          id="profile-form-name"
          value={draft.name}
          maxLength={48}
          placeholder={t("clientWindow.profiles.form.namePlaceholder")}
          onChange={(event) => edit({ name: event.target.value })}
        />
      </SettingRow>

      <SettingRow
        label={t("clientWindow.profiles.form.nickname")}
        htmlFor="profile-form-nickname"
      >
        <NicknameField
          id="profile-form-nickname"
          value={draft.nickname ?? ""}
          onChange={(value) => edit({ nickname: value === "" ? null : value })}
        />
      </SettingRow>

      <SettingRow label={t("clientWindow.profiles.form.skin")}>
        <SkinPicker
          clientId={client.id}
          value={draft.model}
          onChange={(value) => edit({ model: value })}
        />
      </SettingRow>

      {hasHilts ? (
        <>
          <SettingRow label={t("clientWindow.profiles.form.saber1")}>
            <HiltSelect
              value={draft.saber1}
              hilts={hilts.data ?? []}
              label={t("clientWindow.profiles.form.saber1")}
              onChange={(value) => edit({ saber1: value })}
            />
          </SettingRow>

          <SettingRow label={t("clientWindow.profiles.form.saber2")}>
            <HiltSelect
              value={draft.saber2}
              hilts={hilts.data ?? []}
              label={t("clientWindow.profiles.form.saber2")}
              extra={[
                {
                  value: NO_SECOND_HILT,
                  label: t("clientWindow.profiles.form.saber2None"),
                },
              ]}
              onChange={(value) => edit({ saber2: value })}
            />
          </SettingRow>

          {hilts.data?.length === 0 ? (
            <p className="text-body-sm text-fg-muted">
              {t("clientWindow.profiles.form.saberEmpty")}
            </p>
          ) : null}
        </>
      ) : null}

      <SettingRow label={t("clientWindow.profiles.form.color1")}>
        <ColorSelect
          value={draft.color1}
          label={t("clientWindow.profiles.form.color1")}
          onChange={(value) => edit({ color1: value })}
        />
      </SettingRow>

      <SettingRow label={t("clientWindow.profiles.form.color2")}>
        <ColorSelect
          value={draft.color2}
          label={t("clientWindow.profiles.form.color2")}
          onChange={(value) => edit({ color2: value })}
        />
      </SettingRow>

      <SettingRow
        label={t("clientWindow.profiles.form.charColor")}
        {...(draft.charColor === null
          ? {}
          : {
              onClear: () => edit({ charColor: null }),
              clearLabel: t("clientWindow.clear", {
                setting: t("clientWindow.profiles.form.charColor"),
              }),
            })}
      >
        <TintSliders
          value={draft.charColor}
          onChange={(value) => edit({ charColor: value })}
        />
      </SettingRow>

      <div className="flex flex-col gap-4">
        <span className="text-label-xs text-fg-muted">
          {t("clientWindow.profiles.form.tokens")}
        </span>
        <pre className="rounded-md border border-line bg-input p-12 text-mono-xs text-fg-secondary whitespace-pre-wrap break-all">
          {tokens.length === 0
            ? t("clientWindow.profiles.form.tokensEmpty")
            : commandLine(tokens)}
        </pre>
      </div>

      {save.error ? (
        <p role="alert" className="text-body-sm text-fg-danger break-words">
          {errorText(save.error)}
        </p>
      ) : null}

      <div className="flex items-center gap-8 justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("clientWindow.profiles.form.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!ready}>
          {t("clientWindow.profiles.form.save")}
        </Button>
      </div>
    </form>
  );
}

/**
 * One hilt list, with «Not set» in front and whatever else the caller adds.
 *
 * --- slice: connect dialog ---
 * Exported because the **Connect…** dialog offers the same two hilts over the
 * same values: the list a player learns in the client window is the list they
 * meet again before joining a server.
 */
export function HiltSelect({
  value,
  hilts,
  label,
  extra = [],
  size,
  onChange,
}: {
  value: string | null;
  hilts: SaberHilt[];
  label: string;
  extra?: SelectOption[];
  size?: SelectSize;
  onChange: (value: string | null) => void;
}) {
  const { t } = useTranslation("clients");
  const shape = (hilt: SaberHilt) => {
    if (hilt.saberType === "single") {
      return t("clientWindow.profiles.saberTypes.single");
    }
    if (hilt.saberType === "staff") {
      return t("clientWindow.profiles.saberTypes.staff");
    }
    // The dozen shapes only story sabers use have no word of their own: the
    // value of `saberType` is what the file says and what a mod author reads.
    return hilt.saberType;
  };
  // «Not set» is an option and not only the placeholder: a list whose empty
  // state is unreachable would let a player pick a hilt and never take it
  // back, and the profile would go on writing a cvar they no longer want.
  const options: SelectOption[] = [
    { value: "", label: t("clientWindow.notSet") },
    ...extra,
    ...hilts.map((hilt) => ({
      value: hilt.id,
      label: `${hilt.name} · ${shape(hilt)}`,
    })),
  ];
  // A hilt a mod once provided and no longer does still stands in the profile,
  // so it keeps a place of its own: dropping it would show the list as empty
  // over a cvar that is set, and the next change would silently be a second one.
  if (value !== null && !options.some((option) => option.value === value)) {
    options.push({ value, label: value });
  }

  return (
    <Select
      value={value ?? ""}
      options={options}
      ariaLabel={label}
      size={size}
      placeholder={t("clientWindow.notSet")}
      onChange={(next) => onChange(next === "" ? null : next)}
    />
  );
}

/**
 * The catalog key of each blade colour, by the number the cvar takes.
 *
 * A table of literals rather than a key built at run time, so a renamed key
 * fails `npm run typecheck` instead of printing itself on the screen. The
 * index is the value of `color1`, which is `saber_colors_t` of the engine.
 */
const SABER_COLOR_KEYS = [
  "clientWindow.profiles.saberColors.0",
  "clientWindow.profiles.saberColors.1",
  "clientWindow.profiles.saberColors.2",
  "clientWindow.profiles.saberColors.3",
  "clientWindow.profiles.saberColors.4",
  "clientWindow.profiles.saberColors.5",
] as const;

/** The six blade colours of the engine, by the number the cvar takes. */
function ColorSelect({
  value,
  label,
  onChange,
}: {
  value: number | null;
  label: string;
  onChange: (value: number | null) => void;
}) {
  const { t } = useTranslation("clients");
  const options: SelectOption[] = [
    { value: "", label: t("clientWindow.notSet") },
    ...SABER_COLOR_KEYS.slice(0, SABER_COLORS.length).map((key, index) => ({
      value: String(index),
      label: t(key),
    })),
  ];

  return (
    <Select
      value={value === null ? "" : String(value)}
      options={options}
      ariaLabel={label}
      placeholder={t("clientWindow.notSet")}
      onChange={(next) => onChange(next === "" ? null : Number(next))}
    />
  );
}

/** The three channels of `char_color_*`, with the colour they make. */
function TintSliders({
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

/**
 * The `+set` tokens this draft would add to the command line.
 *
 * A copy of the order in `profiles::launch_tokens`, and the core stays the
 * authority: the **Command line preview** card below reads the whole line out
 * of the core for the profile that is *saved*. This line is about the draft on
 * screen, which the core has never seen, and it changes as the form is filled.
 * Keep the two in step — the order is the order of the form.
 */
export function profileTokens(profile: PlayerProfile, hasHilts: boolean): string[] {
  const tokens: string[] = [];
  const set = (name: string, value: string) => {
    tokens.push("+set", name, value);
  };

  const nickname = profile.nickname?.trim() ?? "";
  if (nickname !== "") set("name", nickname);
  if (profile.model !== null) set("model", profile.model);
  if (hasHilts) {
    if (profile.saber1 !== null) set("saber1", profile.saber1);
    if (profile.saber2 !== null) set("saber2", profile.saber2);
  }
  if (profile.color1 !== null) set("color1", String(profile.color1));
  if (profile.color2 !== null) set("color2", String(profile.color2));
  if (profile.charColor !== null) {
    set("char_color_red", String(profile.charColor.red));
    set("char_color_green", String(profile.charColor.green));
    set("char_color_blue", String(profile.charColor.blue));
  }
  return tokens;
}


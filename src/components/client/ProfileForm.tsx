import { TintSliders } from "./TintSliders";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn, commandLine } from "../../lib/format";
import { type CharColor, type Client, type PlayerProfile } from "../../lib/ipc";
import {
  useAppearanceEvents,
  useGameInfo,
  useSaberHilts,
  useSaveProfile,
} from "../../lib/queries";
import { Button, Input } from "../ui";
import { SettingRow } from "./CvarControls";
import { HiltFields } from "./HiltFields";
import { MAX_NICKNAME_BYTES, NicknameField, nicknameBytes } from "./NicknameField";
import { SkinPicker } from "./SkinPicker";
import { DEFAULT_SINGLE_HILT, saberModeOf, saberValuesFor } from "../../lib/sabers";
import { ModelPreview } from "../ModelPreview";
import { useUnsavedGuard } from "./UnsavedGuard";


/** An empty profile, which is what **New profile** opens the form on. */
export function blankProfile(): PlayerProfile {
  return {
    id: "",
    name: "",
    nickname: "Padawan",
    model: null,
    saber1: DEFAULT_SINGLE_HILT,
    saber2: "none",
    color1: 4,
    color2: null,
    charColor: null,
    tokensOverride: null,
  };
}

/**
 * The form that fills one player profile in.
 *
 * Active sabers and colours always have values. The nickname defaults to
 * Padawan; character tint and the command override remain optional.
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
  const [storedDraft, setDraft] = useState<PlayerProfile>({ ...profile, nickname: profile.nickname?.trim() || "Padawan" });
  // --- slice: profiles polish ---
  const guard = useUnsavedGuard();
  // A pk3 installed in the main window while this form is open carries skins
  // and hilts this form should offer.
  useAppearanceEvents();

  // --- slice: player profiles ---
  // Jedi Outcast ships no `ext_data/sabers/`, so there is no hilt to name and
  // the core writes neither cvar. The two lists are hidden rather than left
  // empty: an empty list looks like a launcher that failed to read something.
  const hasHilts = useGameInfo(client.game)?.hasSaberHilts ?? true;
  const hilts = useSaberHilts(client.id, hasHilts);

  const draft = { ...storedDraft, ...(hasHilts ? saberValuesFor(saberModeOf(storedDraft, hilts.data ?? []), storedDraft, hilts.data ?? []) : {}) };
  const initial = { ...profile, nickname: profile.nickname?.trim() || "Padawan", ...(hasHilts ? saberValuesFor(saberModeOf(profile, hilts.data ?? []), profile, hilts.data ?? []) : {}) };

  const edit = (changes: Partial<PlayerProfile>) =>
    setDraft((current) => ({ ...current, ...changes }));

  // --- slice: profiles polish ---
  // The draft against what the form opened on: the window asks this before it
  // closes and the Cancel button asks it before it goes back to the list.
  const dirty = !sameProfile(draft, initial);
  useEffect(() => {
    guard.setDirty(dirty);
    // A form taken off the screen leaves no unsaved edits behind it, whether
    // it was saved, cancelled or replaced.
    return () => guard.setDirty(false);
  }, [guard, dirty]);

  const tokens = profileTokens(draft, hasHilts);
  // --- slice: profiles polish ---
  // The very test the core makes of the field: a line of spaces is no line at
  // all, and `clean_tokens` turns it back into «assemble from the fields».
  const overridden = isOverridden(draft.tokensOverride);
  // The core refuses a nickname over `MAX_NETNAME`, so the button says so
  // before the round trip does. The field itself shows the count.
  const ready =
    draft.name.trim() !== "" &&
    nicknameBytes(draft.nickname ?? "") <= MAX_NICKNAME_BYTES &&
    !save.isPending;

  return (
    <form
      className="flex flex-col gap-16"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        save.mutate({ ...draft, nickname: draft.nickname?.trim() || "Padawan" }, {
          onSuccess: () => {
            // Saved edits are not unsaved ones, and `onDone` unmounts this
            // form before the effect above could say so.
            guard.setDirty(false);
            onDone();
          },
        });
      }}
    >
      <h3 className="text-label-xs text-fg-muted">
        {profile.id === ""
          ? t("clientWindow.profiles.form.newHeading")
          : t("clientWindow.profiles.form.editHeading", { profile: profile.name })}
      </h3>

      {/* --- slice: profiles polish ---
          Every field below still edits the profile, and none of them reaches
          the game while the line at the bottom is a line the player wrote. A
          form that stayed silent about that would let somebody change a skin
          six times and wonder why the game keeps the old one. */}
      {overridden ? (
        <p className="rounded-md border border-line-warm bg-warm-subtle p-12 text-body-sm text-fg">
          {t("clientWindow.profiles.form.tokensOverrideNotice")}
        </p>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(280px,38%)] gap-24 items-start">
      <div className="min-w-0 flex flex-col gap-16">
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
          // --- slice: assembled skins ---
          // The **Character tint** row is a few fields below, so the panel of
          // parts may point at it for the colour it does not set itself.
          tintBelow
          onChange={(value) => edit({ model: value })}
        />
      </SettingRow>

      {/* --- slice: skins and hilts ---
          One row for the whole saber instead of four. The shape decides how
          many hilts there are to name and how many blades there are to
          colour, and the four values only ever made sense together. */}
      <SettingRow label={t("clientWindow.profiles.form.saber")}>
        <HiltFields
          values={draft}
          hilts={hilts}
          hasHilts={hasHilts}
          onChange={(values) => edit(values)}
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

      <TokenLine
        built={tokens}
        override={draft.tokensOverride}
        onChange={(value) => edit({ tokensOverride: value })}
      />

      </div>
      <aside className="sticky top-16 min-w-0 flex flex-col gap-12 max-h-[calc(100vh-64px)] overflow-y-auto">
        <ModelPreview clientId={client.id} kind="character" value={draft.model ?? "kyle/default"} tint={draft.charColor} sabers={hasHilts ? draft : undefined} height="clamp(240px, 40vh, 420px)" className="shrink-0"/>
        {hasHilts ? <div className={cn("grid gap-12 shrink-0", draft.saber2 && draft.saber2 !== "none" ? "grid-cols-2" : "grid-cols-1")}>
          <ModelPreview clientId={client.id} kind="hilt" value={draft.saber1 ?? DEFAULT_SINGLE_HILT} bladeColor={draft.color1} height="clamp(120px, 20vh, 200px)" />
          {draft.saber2 && draft.saber2 !== "none" ? <ModelPreview clientId={client.id} kind="hilt" value={draft.saber2} bladeColor={draft.color2} height="clamp(120px, 20vh, 200px)" /> : null}
        </div> : null}
      </aside>
      </div>

      {save.error ? (
        <p role="alert" className="text-body-sm text-fg-danger break-words">
          {errorText(save.error)}
        </p>
      ) : null}

      <div className="flex items-center gap-8 justify-end">
        {/* --- slice: profiles polish ---
            The way back to the list, and therefore the way to another
            profile: the list is what this form replaced. A draft nobody
            saved is worth a question before it goes. */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => guard.ask(onDone)}
        >
          {t("clientWindow.profiles.form.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!ready}>
          {t("clientWindow.profiles.form.save")}
        </Button>
      </div>
    </form>
  );
}

// --- slice: profiles polish ---

/**
 * Whether two profiles say the same thing.
 *
 * Field by field rather than by comparing their JSON: the draft is built here
 * and the stored profile comes off the wire, and two objects with the same
 * fields in a different order have different JSON. Keep the list in step with
 * {@link PlayerProfile} — a field missing here is a field whose edit the
 * window would let a player lose without asking.
 */
function sameProfile(a: PlayerProfile, b: PlayerProfile): boolean {
  return (
    a.name === b.name &&
    a.nickname === b.nickname &&
    a.model === b.model &&
    a.saber1 === b.saber1 &&
    a.saber2 === b.saber2 &&
    a.color1 === b.color1 &&
    a.color2 === b.color2 &&
    a.tokensOverride === b.tokensOverride &&
    sameTint(a.charColor, b.charColor)
  );
}

/** The tint of two profiles, `null` for «no opinion» included. */
function sameTint(a: CharColor | null, b: CharColor | null): boolean {
  if (a === null || b === null) return a === b;
  return a.red === b.red && a.green === b.green && a.blue === b.blue;
}

/**
 * Whether this profile launches by its hand-written line rather than by its
 * fields.
 *
 * The same test `profiles::clean_tokens` makes in the core: a line of spaces
 * is stored as «no line», so a form that called it an override would promise
 * a launch that will not happen. Exported for the form and its guard.
 */
export function isOverridden(line: string | null): boolean {
  return line !== null && line.trim() !== "";
}

/**
 * The `+set` line of the profile, and the field that edits it.
 *
 * The line was a read-only preview of what the fields build. It is now the
 * other way round as soon as the player types in it: the string is kept on the
 * profile as `tokensOverride` and it is what the launch carries, because a
 * player who edits a command line means the command line, not the controls
 * that happened to have produced it. **Reset to fields** drops the string and
 * the assembling starts again.
 *
 * A `textarea` and not an `<input>`: the line is long, and wrapping it is the
 * difference between reading nine cvars and scrolling through them. Line
 * breaks are refused by the core, so the field commits whatever is typed and
 * the refusal, if any, is the core's to give.
 */
function TokenLine({
  built,
  override,
  onChange,
}: {
  built: string[];
  override: string | null;
  onChange: (value: string | null) => void;
}) {
  const { t } = useTranslation("clients");
  const edited = override !== null;
  const line = override ?? commandLine(built);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-8">
        <label
          htmlFor="profile-form-tokens"
          className="text-label-xs text-fg-muted"
        >
          {t("clientWindow.profiles.form.tokens")}
        </label>
        {edited ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={14} />}
            onClick={() => onChange(null)}
          >
            {t("clientWindow.profiles.form.tokensReset")}
          </Button>
        ) : null}
      </div>
      <textarea
        id="profile-form-tokens"
        value={line}
        rows={2}
        spellCheck={false}
        placeholder={t("clientWindow.profiles.form.tokensEmpty")}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "w-full px-12 py-8 rounded-md resize-y",
          "bg-input border focus:border-line-focus outline-none",
          edited ? "border-line-warm" : "border-line",
          "text-mono-xs text-fg placeholder:text-fg-muted",
        )}
      />
      <p className="text-body-sm text-fg-muted">
        {edited
          ? t("clientWindow.profiles.form.tokensOverrideHint")
          : t("clientWindow.profiles.form.tokensHint")}
      </p>
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

  set("name", profile.nickname?.trim() || "Padawan");
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

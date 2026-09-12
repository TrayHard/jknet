import { BookmarkPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import { useSettings, useUpdateSettings } from "../../lib/queries";
import { Button, Select } from "../ui";
import { ColoredNickname } from "./ColoredNickname";
import { ColoredNicknameInput } from "./ColoredNicknameInput";

/**
 * Longest nickname the field accepts, in **bytes of UTF-8**.
 *
 * `MAX_NETNAME` of the engine, `codemp/game/g_local.h:478` of OpenJK
 * `1a6a6434`: `ClientCleanName` copies the name byte by byte into a buffer of
 * this size, so what fills it is bytes and not letters. A Cyrillic letter
 * costs two of them and eighteen of them fill the name; colour codes count
 * towards the limit as well. The core holds the same limit in
 * `src-tauri/src/profiles.rs`.
 */
export const MAX_NICKNAME_BYTES = 36;

/** The encoder the counter measures with. One per module, not per keystroke. */
const encoder = new TextEncoder();

/**
 * What the nickname weighs against {@link MAX_NICKNAME_BYTES}.
 *
 * The value is trimmed first, the way the core trims it before measuring, so
 * a stray space at the end never costs the player a letter.
 */
export function nicknameBytes(value: string): number {
  return encoder.encode(value.trim()).length;
}

/**
 * The nickname of a profile, with the colours it will have in the game and the
 * list of names the player saved.
 *
 * Saved names are one list of the launcher, not of this client: a nickname is
 * who the player is, and one made up in a Jedi Academy profile should be there
 * in a Jedi Outcast one. The list lives in `settings.json` and the core keeps
 * it tidy, so **Save nickname** simply puts the name in front.
 */
export function NicknameField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  const saved = settings.data?.savedNicknames ?? [];
  const trimmed = value.trim();
  const bytes = nicknameBytes(value);
  const tooLong = bytes > MAX_NICKNAME_BYTES;
  const canSave =
    trimmed !== "" &&
    !tooLong &&
    !saved.some((name) => name.toLowerCase() === trimmed.toLowerCase());

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-8">
        {/* The letters are coloured in the field itself and not only in the
            preview below: a player writing `^1Kyle^7 the ^2Grey` is composing
            a coloured name, and reading the result two rows away is reading
            it somewhere else. The preview stays for the name without its
            markup, which is the other half of the question. */}
        <ColoredNicknameInput
          id={id}
          className="flex-1 min-w-0"
          value={value}
          // A safe upper bound, not the limit: a name of thirty-six bytes is
          // never more than thirty-six characters, so this stops a runaway
          // paste without ever cutting a nickname the server would accept.
          // The byte counter below is what holds the real limit.
          maxLength={MAX_NICKNAME_BYTES}
          invalid={tooLong}
          placeholder={t("clientWindow.profiles.form.nicknamePlaceholder")}
          onChange={onChange}
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<BookmarkPlus size={14} />}
          disabled={!canSave || updateSettings.isPending}
          title={t("clientWindow.profiles.form.nicknameSave")}
          onClick={() => {
            // One field, one patch: the document on disk keeps everything this
            // window never read. The core trims, drops repeats and caps the
            // list, so the form only has to put the new name in front.
            updateSettings.mutate({ savedNicknames: [trimmed, ...saved] });
          }}
        >
          {t("clientWindow.profiles.form.nicknameSave")}
        </Button>
      </div>

      <div className="flex items-center gap-8 min-w-0">
        <span className="text-label-xs text-fg-muted shrink-0">
          {t("clientWindow.profiles.form.nicknamePreview")}
        </span>
        <ColoredNickname
          raw={value}
          placeholder={t("clientWindow.profiles.form.nicknamePlaceholder")}
          className="text-body-md truncate"
        />
      </div>

      {/* A menu of names to copy into the field, not a bound control: the
          value stays empty so the list always reads «Saved nicknames» and the
          field above is the one place the nickname lives. */}
      {saved.length > 0 ? (
        <Select
          value=""
          options={saved.map((name) => ({ value: name, label: name }))}
          ariaLabel={t("clientWindow.profiles.form.nicknameSaved")}
          placeholder={t("clientWindow.profiles.form.nicknameSaved")}
          size="sm"
          onChange={onChange}
        />
      ) : null}

      {updateSettings.error ? (
        <span role="alert" className="text-body-sm text-fg-danger">
          {errorText(updateSettings.error)}
        </span>
      ) : null}

      {/* The counter, not the field, is what tells a player they have run out
          of room: the engine measures the name in bytes, and no HTML attribute
          can count those. */}
      <div className="flex items-start justify-between gap-8">
        <p className="text-body-sm text-fg-muted">
          {t("clientWindow.profiles.form.nicknameHint")}
        </p>
        <span
          className={cn(
            "text-label-xs shrink-0 tabular-nums",
            tooLong ? "text-fg-danger" : "text-fg-muted",
          )}
        >
          {t("clientWindow.profiles.form.nicknameBytes", {
            used: bytes,
            max: MAX_NICKNAME_BYTES,
          })}
        </span>
      </div>

      {tooLong ? (
        <span role="alert" className="text-body-sm text-fg-danger">
          {t("clientWindow.profiles.form.nicknameTooLong", { max: MAX_NICKNAME_BYTES })}
        </span>
      ) : null}
    </div>
  );
}

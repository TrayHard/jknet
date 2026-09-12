import { BookmarkPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useSettings, useUpdateSettings } from "../../lib/queries";
import { Button, Select } from "../ui";
import { MAX_NICKNAME_BYTES, NicknameEditor, nicknameBytes } from "./NicknameEditor";

// The limit and the counter moved into the editor together with the control
// that draws them, and they are re-exported here because the profile form and
// the «Connect…» window ask this module for them: the byte rule of a nickname
// is one rule, and a second import path would be a second place to change it.
export { MAX_NICKNAME_BYTES, nicknameBytes };

/**
 * The nickname of a profile, with the colours it will have in the game and the
 * list of names the player saved.
 *
 * The field itself, the preview and the byte counter are {@link
 * NicknameEditor}, which the `name` cvar of the client window uses as well.
 * What this component adds is the list: saved names are one list of the
 * launcher, not of this client, because a nickname is who the player is, and
 * one made up in a Jedi Academy profile should be there in a Jedi Outcast one.
 * The list lives in `settings.json` and the core keeps it tidy, so **Save
 * nickname** simply puts the name in front.
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
  const tooLong = nicknameBytes(value) > MAX_NICKNAME_BYTES;
  const canSave =
    trimmed !== "" &&
    !tooLong &&
    !saved.some((name) => name.toLowerCase() === trimmed.toLowerCase());

  return (
    <NicknameEditor
      id={id}
      value={value}
      onChange={onChange}
      placeholder={t("clientWindow.profiles.form.nicknamePlaceholder")}
      hint={t("clientWindow.profiles.form.nicknameHint")}
      action={
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
      }
    >
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
    </NicknameEditor>
  );
}

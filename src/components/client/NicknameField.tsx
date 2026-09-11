import { BookmarkPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useSettings, useUpdateSettings } from "../../lib/queries";
import { Button, Input, Select } from "../ui";
import { ColoredNickname } from "./ColoredNickname";

/**
 * Longest nickname the field accepts.
 *
 * `MAX_NETNAME` of the engine, `codemp/game/g_local.h:478` of OpenJK
 * `1a6a6434`: `ClientCleanName` cuts the name to this before anybody reads it.
 * Colour codes count towards it, which is why the limit is on characters typed
 * and not on letters shown.
 */
const MAX_NICKNAME = 36;

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
  const canSave =
    trimmed !== "" && !saved.some((name) => name.toLowerCase() === trimmed.toLowerCase());

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-8">
        <Input
          id={id}
          className="flex-1 min-w-0"
          value={value}
          maxLength={MAX_NICKNAME}
          spellCheck={false}
          placeholder={t("clientWindow.profiles.form.nicknamePlaceholder")}
          onChange={(event) => onChange(event.target.value)}
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

      <p className="text-body-sm text-fg-muted">
        {t("clientWindow.profiles.form.nicknameHint")}
      </p>
    </div>
  );
}

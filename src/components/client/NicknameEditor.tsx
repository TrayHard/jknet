import type { InputHTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
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

interface NicknameEditorProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "children"> {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Stands in for an empty field and for an empty preview. */
  placeholder: string;
  /** A sentence under the field, to the left of the counter. */
  hint?: ReactNode;
  /** A control drawn to the right of the field. */
  action?: ReactNode;
  /** Rows drawn between the preview and the counter. */
  children?: ReactNode;
}

/**
 * A name the game will show, in the control that shows what it will look like:
 * the field whose letters carry the colour codes, the preview of the name as
 * other players read it, and the byte counter.
 *
 * The launcher writes such a name in two places — the nickname of a player
 * profile ({@link NicknameField}, which adds the saved names around this
 * control) and the `name` cvar of the client window (`CvarNameField` in
 * `CvarControls.tsx`) — and both are the same control. A field that coloured
 * the letters in one place and left them grey in the other would tell the
 * player the two names are different things, and they are the same name from
 * the same engine with the same limit.
 *
 * The wording is the wording of the profile form, keys included. It belongs to
 * the control rather than to the card it stands in: one question asked in two
 * sentences is two translations of one thing.
 */
export function NicknameEditor({
  id,
  value,
  onChange,
  placeholder,
  hint,
  action,
  children,
  ...rest
}: NicknameEditorProps) {
  const { t } = useTranslation("clients");
  const bytes = nicknameBytes(value);
  const tooLong = bytes > MAX_NICKNAME_BYTES;

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
          placeholder={placeholder}
          onChange={onChange}
          {...rest}
        />
        {action}
      </div>

      <div className="flex items-center gap-8 min-w-0">
        <span className="text-label-xs text-fg-muted shrink-0">
          {t("clientWindow.profiles.form.nicknamePreview")}
        </span>
        <ColoredNickname
          raw={value}
          placeholder={placeholder}
          className="text-body-md truncate"
        />
      </div>

      {children}

      {/* The counter, not the field, is what tells a player they have run out
          of room: the engine measures the name in bytes, and no HTML attribute
          can count those. */}
      <div
        className={cn(
          "flex items-start gap-8",
          hint === undefined ? "justify-end" : "justify-between",
        )}
      >
        {hint === undefined ? null : <p className="text-body-sm text-fg-muted">{hint}</p>}
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

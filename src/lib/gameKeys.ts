/** Bind tokens verified against OpenJK codemp/client/cl_keys.cpp (1a6a6434).
 * Left/right modifiers share a token; Escape and console are engine-reserved.
 */
export interface GameKey {
  token: string;
  label: string;
  width?: number;
  reserved?: boolean;
}
const key = (
  token: string,
  label = token,
  width = 1,
  reserved = false,
): GameKey => ({ token, label, width, reserved });
export const KEY_ROWS: GameKey[][] = [
  [
    key("ESCAPE", "Esc", 1, true),
    ...Array.from({ length: 12 }, (_, i) => key(`F${i + 1}`)),
  ],
  [
    key("CONSOLE", "~", 1, true),
    ..."1234567890-=".split("").map((k) => key(k)),
    key("BACKSPACE", "Backspace", 2),
  ],
  [
    key("TAB", "Tab", 1.5),
    ..."QWERTYUIOP[]".split("").map((k) => key(k)),
    key("\\", "\\", 1.5),
  ],
  [
    key("CAPSLOCK", "Caps", 1.75),
    ..."ASDFGHJKL".split("").map((k) => key(k)),
    key("SEMICOLON", ";"),
    key("'"),
    key("ENTER", "Enter", 2.25),
  ],
  [
    key("SHIFT", "Shift", 2.25),
    ..."ZXCVBNM,./".split("").map((k) => key(k)),
    key("SHIFT", "Shift", 2.75),
  ],
  [
    key("CTRL", "Ctrl", 1.25),
    key("META_LEFT", "Win", 1.25, true),
    key("ALT", "Alt", 1.25),
    key("SPACE", "Space", 6.25),
    key("ALT", "Alt", 1.25),
    key("META_RIGHT", "Win", 1.25, true),
    key("CONTEXT_MENU", "Menu", 1.25, true),
    key("CTRL", "Ctrl", 1.25),
  ],
];
export const SYSTEM_KEYS = [key("PRINT_SCREEN", "PrtSc", 1, true), key("SCROLLLOCK", "ScrLk"), key("PAUSE", "Pause")];
export const NAV_KEYS = [
  "INS",
  "HOME",
  "PGUP",
  "DEL",
  "END",
  "PGDN",
  "LEFTARROW",
  "UPARROW",
  "DOWNARROW",
  "RIGHTARROW",
].map((token) =>
  key(
    token,
    (
      {
        LEFTARROW: "←",
        UPARROW: "↑",
        DOWNARROW: "↓",
        RIGHTARROW: "→",
      } as Record<string, string>
    )[token] ?? token,
  ),
);
export const NUMPAD_KEYS = [
  "KP_NUMLOCK",
  "KP_SLASH",
  "KP_STAR",
  "KP_MINUS",
  "KP_HOME",
  "KP_UPARROW",
  "KP_PGUP",
  "KP_PLUS",
  "KP_LEFTARROW",
  "KP_5",
  "KP_RIGHTARROW",
  "KP_ENTER",
  "KP_END",
  "KP_DOWNARROW",
  "KP_PGDN",
  "KP_INS",
  "KP_DEL",
].map((token) =>
  key(
    token,
    (
      {
        KP_NUMLOCK: "Num",
        KP_SLASH: "/",
        KP_STAR: "*",
        KP_MINUS: "−",
        KP_HOME: "7",
        KP_UPARROW: "8",
        KP_PGUP: "9",
        KP_PLUS: "+",
        KP_LEFTARROW: "4",
        KP_5: "5",
        KP_RIGHTARROW: "6",
        KP_ENTER: "Enter",
        KP_END: "1",
        KP_DOWNARROW: "2",
        KP_PGDN: "3",
        KP_INS: "0",
        KP_DEL: ".",
      } as Record<string, string>
    )[token],
  ),
);
export const MOUSE_KEYS = [
  "MOUSE1",
  "MOUSE2",
  "MOUSE3",
  "MOUSE4",
  "MOUSE5",
  "MWHEELUP",
  "MWHEELDOWN",
].map((token) =>
  key(
    token,
    token
      .replace("MOUSE", "M")
      .replace("MWHEELUP", "Wheel ↑")
      .replace("MWHEELDOWN", "Wheel ↓"),
  ),
);
export const GAME_KEYS = [
  ...KEY_ROWS.flat(),
  ...SYSTEM_KEYS,
  ...NAV_KEYS,
  ...NUMPAD_KEYS,
  ...MOUSE_KEYS,
];
export function browserGameKey(code: string): string | null {
  if (/^(Key[A-Z]|Digit[0-9])$/.test(code))
    return code.replace(/^(Key|Digit)/, "");
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  const keys: Record<string, string> = {
    Space: "SPACE",
    Tab: "TAB",
    Enter: "ENTER",
    Backspace: "BACKSPACE",
    ShiftLeft: "SHIFT",
    ShiftRight: "SHIFT",
    ControlLeft: "CTRL",
    ControlRight: "CTRL",
    AltLeft: "ALT",
    AltRight: "ALT",
    CapsLock: "CAPSLOCK",
    ArrowUp: "UPARROW",
    ArrowDown: "DOWNARROW",
    ArrowLeft: "LEFTARROW",
    ArrowRight: "RIGHTARROW",
    Insert: "INS",
    Delete: "DEL",
    Home: "HOME",
    End: "END",
    PageUp: "PGUP",
    PageDown: "PGDN",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: "SEMICOLON",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    NumpadEnter: "KP_ENTER",
    NumpadAdd: "KP_PLUS",
    NumpadSubtract: "KP_MINUS",
    NumpadMultiply: "KP_STAR",
    NumpadDivide: "KP_SLASH",
    NumpadDecimal: "KP_DEL",
    NumLock: "KP_NUMLOCK",
    ScrollLock: "SCROLLLOCK",
    Pause: "PAUSE",
  };
  if (/^Numpad\d$/.test(code))
    return [
      "KP_INS",
      "KP_END",
      "KP_DOWNARROW",
      "KP_PGDN",
      "KP_LEFTARROW",
      "KP_5",
      "KP_RIGHTARROW",
      "KP_HOME",
      "KP_UPARROW",
      "KP_PGUP",
    ][Number(code.slice(-1))];
  return keys[code] ?? null;
}

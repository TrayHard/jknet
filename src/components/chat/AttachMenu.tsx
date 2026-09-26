import {
  Box,
  Clipboard,
  Clapperboard,
  FileCode,
  Keyboard,
  Map as MapIcon,
  Package,
  Paperclip,
  Server,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Floating } from "./Floating";

/** What the attach menu can put into a message. */
export type AttachKind =
  | "file"
  | "clipboard"
  | "media"
  | "server"
  | "map"
  | "profile"
  | "bind"
  | "config"
  | "bundle"
  | "jkhubMod";

export const ATTACH_KINDS: AttachKind[] = [
  "file",
  "clipboard",
  "media",
  "server",
  "map",
  "profile",
  "bind",
  "config",
  "bundle",
  "jkhubMod",
];

const ICONS: Record<AttachKind, LucideIcon> = {
  file: Paperclip,
  clipboard: Clipboard,
  media: Clapperboard,
  server: Server,
  map: MapIcon,
  profile: UserRound,
  bind: Keyboard,
  config: FileCode,
  bundle: Package,
  jkhubMod: Box,
};

interface AttachMenuProps {
  /** The kinds this composer can act on now; the rest are listed, switched off. */
  available: ReadonlySet<AttachKind>;
  onPick: (kind: AttachKind) => void;
  disabled?: boolean;
}

/**
 * --- slice: chat ---
 *
 * The paperclip of the composer: every kind of thing a message can carry,
 * with the file limits under the list. A file and a picture from the
 * clipboard go through the core's staging; the cards — a server, a map, a
 * profile, a bind, a cfg, a bundle, a JKHub mod, a Media item — are picked
 * by the pickers of the cards slice, and stay switched off here until the
 * composer is given them.
 */
export function AttachMenu({ available, onPick, disabled = false }: AttachMenuProps) {
  const { t } = useTranslation("chat");
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={t("attach.open")}
        title={t("attach.open")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="flex size-32 shrink-0 items-center justify-center rounded-md text-fg-secondary cursor-pointer hover:bg-hover-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Paperclip size={16} />
      </button>
      <Floating anchor={open ? button.current : null} onClose={() => setOpen(false)} placement="top-start" label={t("attach.open")}>
        <div role="menu" className="flex w-[240px] flex-col gap-2 rounded-lg border border-line-strong bg-elevated p-4 shadow-popover">
          {ATTACH_KINDS.map((kind) => {
            const Icon = ICONS[kind];
            const on = available.has(kind);
            return (
              <button
                key={kind}
                type="button"
                role="menuitem"
                disabled={!on}
                onClick={() => {
                  setOpen(false);
                  onPick(kind);
                }}
                className="flex items-center gap-8 rounded-md px-8 py-6 text-left text-body-sm text-fg cursor-pointer select-none hover:bg-hover-overlay disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-transparent"
              >
                <Icon size={14} className="shrink-0" />
                {t(`attach.kinds.${kind}`)}
              </button>
            );
          })}
          <p className="border-t border-line-subtle px-8 pt-6 pb-2 text-body-sm text-fg-muted">{t("attach.limits")}</p>
        </div>
      </Floating>
    </>
  );
}

import {
  Box,
  Camera,
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

import type { PlatformCaps } from "../../lib/backend";
import { cn } from "../../lib/format";
import { useDialogPresentation } from "../ui/DialogPresentation";
import { Floating } from "./Floating";

/** What the attach menu can put into a message. */
export type AttachKind =
  | "file"
  | "clipboard"
  // --- slice: web app --- a picture from the gallery or the camera of a phone.
  | "photo"
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

/**
 * --- slice: web app ---
 * The kinds of a platform without game clients on the machine: a file or a
 * photo the browser picks, and the cards of the catalogs. A pasted picture
 * needs no entry there, and a Media item, a map, a player profile, a bind and
 * a cfg all come out of game clients.
 */
export const WEB_ATTACH_KINDS: AttachKind[] = ["file", "photo", "server", "bundle", "jkhubMod"];

/** The kinds the attach menu lists on this platform. */
export function attachKindsFor(caps: PlatformCaps): AttachKind[] {
  return caps.localFiles ? ATTACH_KINDS : WEB_ATTACH_KINDS;
}

const ICONS: Record<AttachKind, LucideIcon> = {
  file: Paperclip,
  clipboard: Clipboard,
  photo: Camera,
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
  /** The kinds listed, in order: `ATTACH_KINDS` unless the platform has fewer. */
  kinds?: readonly AttachKind[];
  onPick: (kind: AttachKind) => void;
  disabled?: boolean;
}

/**
 * --- slice: chat ---
 *
 * The paperclip of the composer: every kind of thing a message can carry,
 * with the file limits under the list. A file and a picture from the
 * clipboard go through the core's staging; a Media item and the cards — a
 * server, a map, a profile, a bind, a cfg, a bundle, a JKHub mod — open the
 * pickers of `pickers/AttachPicker.tsx`. A kind left out of `available` is
 * listed switched off.
 */
export function AttachMenu({ available, kinds = ATTACH_KINDS, onPick, disabled = false }: AttachMenuProps) {
  const { t } = useTranslation("chat");
  const sheet = useDialogPresentation() === "sheet";
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
        className="flex size-32 pointer-coarse:size-44 shrink-0 items-center justify-center rounded-md text-fg-secondary cursor-pointer hover:bg-hover-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Paperclip size={16} />
      </button>
      <Floating anchor={open ? button.current : null} onClose={() => setOpen(false)} placement="top-start" label={t("attach.open")}>
        <div
          role="menu"
          className={cn(
            "flex flex-col gap-2",
            // A sheet is the frame already: the list fills it.
            sheet ? "w-full p-4" : "w-[240px] rounded-lg border border-line-strong bg-elevated p-4 shadow-popover",
          )}
        >
          {kinds.map((kind) => {
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

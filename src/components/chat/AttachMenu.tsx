import {
  Box,
  Camera,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Clapperboard,
  FileCode,
  Film,
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
  | "screenshot"
  | "demo"
  | "video"
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
  "screenshot",
  "demo",
  "video",
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
 * needs no entry there, and a media item, a map, a player profile, a bind and
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
  screenshot: Camera,
  demo: Film,
  video: Clapperboard,
  server: Server,
  map: MapIcon,
  profile: UserRound,
  bind: Keyboard,
  config: FileCode,
  bundle: Package,
  jkhubMod: Box,
};

const MEDIA_KINDS = new Set<AttachKind>(["screenshot", "demo", "video"]);

const MENU_GROUPS = [
  { id: "files", kinds: ["file", "clipboard", "photo"] },
  { id: "media", kinds: ["screenshot", "demo", "video"] },
  { id: "game", kinds: ["server", "map", "profile"] },
  { id: "settings", kinds: ["bind", "config"] },
  { id: "catalogs", kinds: ["bundle", "jkhubMod"] },
] as const;

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
  const [mediaOpen, setMediaOpen] = useState(false);
  const listed = new Set(kinds);
  const close = () => {
    setOpen(false);
    setMediaOpen(false);
  };

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
      <Floating anchor={open ? button.current : null} onClose={close} placement="top-start" label={t("attach.open")}>
        <div
          role="menu"
          className={cn(
            "flex flex-col gap-2",
            // A sheet is the frame already: the list fills it.
            sheet ? "w-full p-4" : "w-[240px] rounded-lg border border-line-strong bg-elevated p-4 shadow-popover",
          )}
        >
          {MENU_GROUPS.map((group) => {
            const groupKinds = group.kinds.filter((kind) => listed.has(kind));
            if (groupKinds.length === 0) return null;
            if (group.id === "media") {
              const mediaAvailable = groupKinds.some((kind) => available.has(kind));
              return (
                <div key={group.id} className="border-t border-line-subtle pt-2 first:border-t-0 first:pt-0">
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={mediaOpen}
                    disabled={!mediaAvailable}
                    onClick={() => setMediaOpen((value) => !value)}
                    className="flex w-full items-center gap-8 rounded-md px-8 py-6 text-left text-body-sm text-fg cursor-pointer select-none hover:bg-hover-overlay disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-transparent"
                  >
                    <Clapperboard size={14} className="shrink-0" />
                    <span className="flex-1">{t("attach.groups.media")}</span>
                    {mediaOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {mediaOpen ? (
                    <div role="menu" aria-label={t("attach.groups.media")} className="ml-14 border-l border-line-subtle pl-4">
                      {groupKinds.map((kind) => {
                        const Icon = ICONS[kind];
                        return (
                          <button
                            key={kind}
                            type="button"
                            role="menuitem"
                            disabled={!available.has(kind)}
                            onClick={() => {
                              close();
                              onPick(kind);
                            }}
                            className="flex w-full items-center gap-8 rounded-md px-8 py-6 text-left text-body-sm text-fg cursor-pointer select-none hover:bg-hover-overlay disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-transparent"
                          >
                            <Icon size={14} className="shrink-0" />
                            {t(`attach.kinds.${kind}`)}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            }
            return (
              <div key={group.id} className="border-t border-line-subtle pt-2 first:border-t-0 first:pt-0">
                <p className="px-8 py-2 text-caption uppercase tracking-wide text-fg-muted">{t(`attach.groups.${group.id}`)}</p>
                {groupKinds.filter((kind) => !MEDIA_KINDS.has(kind)).map((kind) => {
                  const Icon = ICONS[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      disabled={!available.has(kind)}
                      onClick={() => {
                        close();
                        onPick(kind);
                      }}
                      className="flex w-full items-center gap-8 rounded-md px-8 py-6 text-left text-body-sm text-fg cursor-pointer select-none hover:bg-hover-overlay disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-transparent"
                    >
                      <Icon size={14} className="shrink-0" />
                      {t(`attach.kinds.${kind}`)}
                    </button>
                  );
                })}
              </div>
            );
          })}
          <p className="border-t border-line-subtle px-8 pt-6 pb-2 text-body-sm text-fg-muted">{t("attach.limits")}</p>
        </div>
      </Floating>
    </>
  );
}

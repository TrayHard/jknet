import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { Ellipsis, Maximize2, Minus, Monitor, PictureInPicture2, Pin, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../../i18n/useFormat";
import { clampOpacity, OPACITY_MAX, OPACITY_MIN, OPACITY_STEP } from "../../../lib/chatWindow";
import { cn } from "../../../lib/format";
import type { ChatWindowView } from "../../../lib/ipc";
import {
  useSetChatWindowAlwaysOnTop,
  useSetChatWindowCompact,
  useSetChatWindowOpacity,
} from "../../../lib/queries";
import { isTauri } from "../../../lib/runtime";
import { logWindowFailure } from "../../../lib/windowLog";
import { Slider } from "../../client/Slider";
import { Logo } from "../../Logo";
import { Toggle } from "../../ui";
import { Floating } from "../Floating";

interface ChatWindowBarProps {
  view: ChatWindowView;
  /** The line after the title in the full mode: unread messages or friends online. */
  subtitle: string;
  /** **Open in launcher**: the launcher window's drawer takes the chat over. */
  onOpenInLauncher: () => void;
}

/**
 * --- slice: chat window ---
 *
 * The title bar of the chat window, drawn by the page like every window of
 * the launcher (`decorations: false`).
 *
 * The full mode has the launcher's own bar: the mark, **JKNet Chat** and a
 * line of what waits — unread messages, else friends online — then
 * **Always on top**, **Compact mode**, **Minimize** and **Close**. There is
 * no **Maximize**: the list and the thread have nothing to grow into, and a
 * maximised window would come back maximised in the other mode.
 *
 * The compact mode sits over a game in a 360 px window, so its bar is lower
 * and narrower: **Always on top**, **Window options** — the opacity slider,
 * the same switch, the way back to the full window and to the launcher —
 * **Minimize** and **Close**.
 *
 * The switches run in the core, which changes the window and answers the
 * new state; the bar only shows it. Dragging is started by hand rather than
 * by `data-tauri-drag-region`, whose double click maximises the window.
 */
export function ChatWindowBar({ view, subtitle, onOpenInLauncher }: ChatWindowBarProps) {
  const { t } = useTranslation("chat");
  const common = useTranslation("common").t;
  const setCompact = useSetChatWindowCompact().mutate;
  const setOnTop = useSetChatWindowAlwaysOnTop().mutate;
  const [options, setOptions] = useState<HTMLElement | null>(null);
  const compact = view.compact;

  const onTopLabel = view.alwaysOnTop ? t("window.alwaysOnTopOn") : t("window.alwaysOnTopOff");
  const onTop = (
    <BarButton
      compact={compact}
      label={t("window.alwaysOnTop")}
      title={onTopLabel}
      pressed={view.alwaysOnTop}
      onClick={() => setOnTop(!view.alwaysOnTop)}
    >
      <Pin size={16} />
    </BarButton>
  );
  const minimize = (
    <BarButton
      compact={compact}
      label={common("window.minimize")}
      onClick={windowAction("minimize", (appWindow) => appWindow.minimize())}
    >
      <Minus size={16} />
    </BarButton>
  );
  const close = (
    <BarButton
      compact={compact}
      label={t("window.close")}
      danger
      onClick={windowAction("close", (appWindow) => appWindow.close())}
    >
      <X size={16} />
    </BarButton>
  );

  return (
    <header
      onMouseDown={startDragging}
      className={cn(
        "flex shrink-0 items-center select-none bg-titlebar border-b border-line-subtle",
        compact ? "h-36 gap-6 pl-10" : "h-40 gap-8 pl-16",
      )}
    >
      <div className="flex min-w-0 items-center gap-8">
        <Logo size={compact ? 16 : 20} />
        <span className="text-display-nav whitespace-nowrap text-fg">{t("window.title")}</span>
        {!compact && subtitle !== "" ? (
          <span className="truncate text-mono-xs text-fg-secondary">{subtitle}</span>
        ) : null}
      </div>

      <div className="h-full min-w-0 flex-1" />

      {compact ? (
        <div className="flex h-full items-center">
          {onTop}
          <BarButton
            compact
            label={t("window.options")}
            pressed={options !== null}
            haspopup
            onClick={(event) => {
              const anchor = event.currentTarget;
              setOptions((open) => (open === null ? anchor : null));
            }}
          >
            <Ellipsis size={16} />
          </BarButton>
          {minimize}
          {close}
          <Floating
            anchor={options}
            onClose={() => setOptions(null)}
            placement="bottom-end"
            label={t("window.options")}
          >
            <WindowOptions
              view={view}
              onFull={() => {
                setOptions(null);
                setCompact(false);
              }}
              onOpenInLauncher={() => {
                setOptions(null);
                onOpenInLauncher();
              }}
            />
          </Floating>
        </div>
      ) : (
        <div className="flex h-full items-center">
          {onTop}
          <BarButton label={t("window.compact")} onClick={() => setCompact(true)}>
            <PictureInPicture2 size={16} />
          </BarButton>
          <span aria-hidden="true" className="mx-4 h-16 w-1 shrink-0 bg-line-strong" />
          {minimize}
          {close}
        </div>
      )}
    </header>
  );
}

interface WindowOptionsProps {
  view: ChatWindowView;
  onFull: () => void;
  onOpenInLauncher: () => void;
}

/** What **Window options** of the compact bar holds: E2's menu, less the banner strip. */
function WindowOptions({ view, onFull, onOpenInLauncher }: WindowOptionsProps) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const setOpacity = useSetChatWindowOpacity().mutate;
  const setOnTop = useSetChatWindowAlwaysOnTop().mutate;
  const sliderId = useId();
  // The slider's own value while the layer is open. The switch reaches the
  // cache a moment after the key or the pointer moved it, and a controlled
  // range put back to the old value in between loses the next step.
  const [draft, setDraft] = useState<number | null>(null);
  const opacity = draft ?? clampOpacity(view.opacity);
  const opacityText = format.percent(opacity / 100);
  const root = useRef<HTMLDivElement>(null);

  // The layer is drawn at the end of the page, out of the bar's tab order:
  // the keyboard starts on the slider, and `Escape` hands it back to the
  // button that opened the layer. A frame later: the layer stays hidden
  // until it has been placed, and nothing hidden takes the focus.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      root.current?.querySelector<HTMLInputElement>('input[type="range"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div ref={root} className="flex w-256 flex-col rounded-md border border-line bg-elevated py-4 shadow-popover">
      <p className="px-12 pt-4 pb-2 text-label-xs text-fg-muted select-none">{t("window.optionsTitle")}</p>
      <div className="flex flex-col gap-6 px-12 py-8">
        <div className="flex items-center justify-between gap-8 text-body-sm text-fg">
          <label htmlFor={sliderId} className="select-none">
            {t("window.opacity")}
          </label>
          <span className="text-mono-xs text-fg-secondary">{opacityText}</span>
        </div>
        <Slider
          id={sliderId}
          value={opacity}
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_STEP}
          aria-valuetext={opacityText}
          onChange={(event) => {
            const next = clampOpacity(Number(event.target.value));
            if (next === opacity) return;
            setDraft(next);
            setOpacity(next);
          }}
        />
      </div>
      <div aria-hidden="true" className="my-4 h-1 bg-line-subtle" />
      <div className="flex h-32 items-center gap-8 px-12 text-body-sm text-fg">
        <Pin size={14} className="shrink-0 text-fg-secondary" />
        <span className="min-w-0 flex-1 truncate select-none">{t("window.alwaysOnTop")}</span>
        <Toggle
          checked={view.alwaysOnTop}
          label={t("window.alwaysOnTop")}
          onChange={(on) => setOnTop(on)}
          className="scale-[0.8] origin-right"
        />
      </div>
      <OptionButton icon={<Maximize2 size={14} />} onClick={onFull}>
        {t("window.full")}
      </OptionButton>
      <OptionButton icon={<Monitor size={14} />} onClick={onOpenInLauncher}>
        {t("window.openInLauncher")}
      </OptionButton>
      <div aria-hidden="true" className="my-4 h-1 bg-line-subtle" />
      <p className="px-12 pt-2 pb-6 text-body-sm text-fg-secondary">{t("window.onTopNote")}</p>
    </div>
  );
}

/** A line of **Window options** that does one thing, drawn like a line of the kit's `Menu`. */
function OptionButton({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-32 w-full items-center gap-8 px-12 text-left text-body-sm text-fg cursor-pointer select-none",
        "transition-colors duration-100 hover:bg-hover-overlay focus-visible:bg-hover-overlay",
      )}
    >
      <span className="flex shrink-0 items-center text-fg-secondary">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

interface BarButtonProps {
  label: string;
  /** The tooltip when it says more than the name: the state of a switch. */
  title?: string;
  /** The smaller buttons of the compact bar. */
  compact?: boolean;
  /** Set for a switch, which stays lit while it is on. */
  pressed?: boolean;
  /** Opens a layer: **Window options**. */
  haspopup?: boolean;
  danger?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}

/** One button of the bar, the size of the launcher's window buttons or of the compact bar's. */
function BarButton({
  label,
  title,
  compact = false,
  pressed,
  haspopup = false,
  danger = false,
  onClick,
  children,
}: BarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={haspopup ? undefined : pressed}
      aria-haspopup={haspopup ? "dialog" : undefined}
      aria-expanded={haspopup ? pressed === true : undefined}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center cursor-pointer transition-colors duration-150",
        compact ? "h-36 w-34" : "h-40 w-44",
        pressed ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary",
        danger
          ? "hover:bg-danger hover:text-white"
          : pressed
            ? "hover:bg-selected-overlay"
            : "hover:bg-hover-overlay hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Moves the window while the left button is held on the bar, anywhere but a
 * button. A double click does nothing: the chat window is not maximised.
 *
 * **Window options** is a portal into `body`, yet React bubbles its events
 * through the bar: a press on the layer is not a press on the bar.
 */
function startDragging(event: MouseEvent<HTMLElement>): void {
  if (!isTauri() || event.button !== 0 || event.detail > 1) return;
  const target = event.target;
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
  if (target.closest("button, a, input, label") !== null) return;
  getCurrentWindow()
    .startDragging()
    .catch((e: unknown) => logWindowFailure("startDragging", e));
}

/** A window action of the bar: nothing in a plain browser, a line in the log when the core refuses. */
function windowAction(name: string, action: (appWindow: TauriWindow) => Promise<unknown>) {
  return () => {
    if (!isTauri()) return;
    action(getCurrentWindow()).catch((e: unknown) => logWindowFailure(name, e));
  };
}

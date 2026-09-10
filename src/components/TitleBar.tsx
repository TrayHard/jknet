import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../lib/format";
import { isTauri } from "../lib/runtime";
import { Logo } from "./Logo";

/**
 * The window title bar the app draws itself.
 *
 * `decorations: false` in `tauri.conf.json` removes the system bar, so this
 * strip owns dragging, the double click that maximises the window and the
 * three window buttons. Only the strip itself carries
 * `data-tauri-drag-region`: the attribute does not reach children, which is
 * exactly what keeps the buttons clickable.
 *
 * Outside the Tauri runtime the bar still renders, because the design is
 * reviewed in a plain browser, but the buttons do nothing.
 */
export function TitleBar() {
  const { t } = useTranslation("common");
  const [version, setVersion] = useState("");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  // The window can be maximised from the button, from a double click on the
  // drag region and from the system menu, so the icon follows the window
  // rather than the click: `onResized` fires for all three.
  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let live = true;
    const sync = () => {
      appWindow
        .isMaximized()
        .then((value) => {
          if (live) setMaximized(value);
        })
        .catch(() => undefined);
    };

    sync();
    const unlisten = appWindow.onResized(sync);
    return () => {
      live = false;
      unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  /** Runs a window action, and nothing at all in a plain browser. */
  const windowAction = (action: (appWindow: TauriWindow) => Promise<unknown>) => () => {
    if (!isTauri()) return;
    action(getCurrentWindow()).catch(() => undefined);
  };

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex items-center shrink-0 h-40 pl-16 select-none",
        "bg-titlebar border-b border-line-subtle",
      )}
    >
      <div data-tauri-drag-region className="flex items-center gap-8 pointer-events-none">
        <Logo size={20} />
        <span className="text-display-nav text-fg tracking-[0.12em]">JKNET</span>
        {version ? (
          <span className="text-mono-xs text-fg-muted">v{version}</span>
        ) : null}
      </div>

      <div data-tauri-drag-region className="flex-1 h-full" />

      <div className="flex items-center h-full">
        <WindowButton
          label={t("window.minimize")}
          onClick={windowAction((appWindow) => appWindow.minimize())}
        >
          <Minus size={16} />
        </WindowButton>
        <WindowButton
          label={maximized ? t("window.restore") : t("window.maximize")}
          onClick={windowAction((appWindow) => appWindow.toggleMaximize())}
        >
          {maximized ? <Copy size={12} /> : <Square size={13} />}
        </WindowButton>
        <WindowButton
          label={t("window.close")}
          danger
          onClick={windowAction((appWindow) => appWindow.close())}
        >
          <X size={16} />
        </WindowButton>
      </div>
    </header>
  );
}

interface WindowButtonProps {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function WindowButton({ label, danger = false, onClick, children }: WindowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center w-44 h-40 cursor-pointer",
        "text-fg-secondary transition-colors duration-150",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-hover-overlay hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

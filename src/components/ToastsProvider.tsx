import {
  createContext,
  use,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Toast, type ToastVariant } from "./ui";

/**
 * One place for the messages that float over the screens.
 *
 * --- slice: friends ---
 *
 * The launcher had one such message before this: the update notice, which
 * `AppUpdateProvider` pinned to the bottom right corner itself. A second
 * pinned corner would have covered it, so the corner moved here and both
 * kinds of message now share one column. The update notice keeps its own
 * state and only borrows the column, through [`ToastSlot`]; the invites of
 * the friends slice are pushed with [`useToasts`] and forgotten.
 */

/** Everything a pushed toast can say. Mirrors the props of `Toast`. */
export interface ToastContent {
  variant?: ToastVariant;
  title: string;
  text?: ReactNode;
  /** Buttons on the right. Keep it to one or two. */
  action?: ReactNode;
  /**
   * Runs instead of removing the toast from the column.
   *
   * For a toast that stands for something the core owns — an invitation lives
   * on the hub until it is dismissed there — so that closing it here does not
   * bring it back on the next refresh.
   */
  onDismiss?: () => void;
}

export interface ToastsApi {
  /**
   * Shows a toast, replacing the one with the same `id`.
   *
   * The id is the caller's own key — `invite:<id>` for an invitation — so a
   * list that is re-read every few seconds cannot stack up duplicates of the
   * same message.
   */
  show: (id: string, content: ToastContent) => void;
  dismiss: (id: string) => void;
}

const NOWHERE: ToastsApi = { show: () => {}, dismiss: () => {} };

const ToastsContext = createContext<ToastsApi>(NOWHERE);

/** The column itself, so a component with its own state can render into it. */
const ToastHostContext = createContext<HTMLElement | null>(null);

export function ToastsProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: string; content: ToastContent }>>(
    [],
  );

  const api = useMemo<ToastsApi>(
    () => ({
      show: (id, content) =>
        setToasts((current) => {
          const without = current.filter((toast) => toast.id !== id);
          return [...without, { id, content }];
        }),
      dismiss: (id) =>
        setToasts((current) => current.filter((toast) => toast.id !== id)),
    }),
    [],
  );

  return (
    <ToastsContext value={api}>
      <ToastHostContext value={host}>
        {children}
        <div
          ref={setHost}
          className="fixed bottom-24 right-24 z-50 flex flex-col gap-12"
        >
          {toasts.map(({ id, content }) => (
            <Toast
              key={id}
              variant={content.variant}
              title={content.title}
              text={content.text}
              action={content.action}
              onDismiss={content.onDismiss ?? (() => api.dismiss(id))}
            />
          ))}
        </div>
      </ToastHostContext>
    </ToastsContext>
  );
}

/** Pushes and clears toasts. Outside the provider every call does nothing. */
export function useToasts(): ToastsApi {
  return use(ToastsContext);
}

/**
 * Renders its children into the toast column.
 *
 * For a message whose content is derived from live state rather than pushed
 * once — the update notice, whose text is a download counter. Nothing renders
 * on the first frame, when the column has not been laid out yet.
 */
export function ToastSlot({ children }: { children: ReactNode }) {
  const host = use(ToastHostContext);
  if (host === null) return null;
  return createPortal(children, host);
}

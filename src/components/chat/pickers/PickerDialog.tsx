import { Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { fold } from "../../../lib/chat/conversation";
import { cn } from "../../../lib/format";
import { Button, Dialog, Input } from "../../ui";

/** One row of a picker. */
export interface PickerItem {
  id: string;
  title: string;
  /** A second line: an address, a map name, a nickname. */
  detail?: string | null;
  /** A picture or a mark, left of the text. */
  lead?: ReactNode;
  /** Why the row cannot be picked; the row stays listed, switched off. */
  disabledReason?: string | null;
  /** What the search matches besides the title and the detail. */
  keywords?: string;
  /** The title drawn instead of the plain one: a nickname in its colours. */
  titleNode?: ReactNode;
}

interface PickerDialogProps {
  title: string;
  body?: string;
  items: PickerItem[];
  onPick: (id: string) => void;
  onClose: () => void;
  loading?: boolean;
  /** A picked row is on its way into the message: the list waits. */
  busy?: boolean;
  /** The read or the pick failed, in words. */
  error?: string | null;
  /** The sentence of an empty list. */
  emptyText: string;
  /** Controls above the search: the client whose profiles are listed. */
  header?: ReactNode;
  /** The search runs somewhere else — JKHub — and the list is already the answer. */
  onQuery?: (query: string) => void;
  searchLabel?: string;
}

/** Rows a picker draws at most; the search narrows the rest. */
const ROWS_MAX = 150;

/**
 * --- slice: chat cards ---
 *
 * The one list every picker of the attach menu is: a search field, rows with
 * a picture or a mark, a title and a second line, and a press that picks.
 *
 * The search folds case and accents, like the conversation list does, and
 * matches the title, the detail and the keywords of a row. A picker whose
 * search runs elsewhere hands the query out instead and lists what comes
 * back.
 */
export function PickerDialog({
  title,
  body,
  items,
  onPick,
  onClose,
  loading = false,
  busy = false,
  error = null,
  emptyText,
  header,
  onQuery,
  searchLabel,
}: PickerDialogProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const [query, setQuery] = useState("");
  const needle = fold(query.trim());
  const shown =
    onQuery !== undefined || needle === ""
      ? items
      : items.filter((item) => fold(`${item.title} ${item.detail ?? ""} ${item.keywords ?? ""}`).includes(needle));
  const rows = shown.slice(0, ROWS_MAX);

  return (
    <Dialog
      wide
      title={title}
      body={body}
      onClose={onClose}
      actions={
        <Button variant="ghost" onClick={onClose}>
          {tCommon("actions.cancel")}
        </Button>
      }
    >
      <div className="flex flex-col gap-12 pt-12">
        {header}
        <Input
          autoFocus
          icon={<Search size={14} />}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            onQuery?.(event.target.value);
          }}
          placeholder={searchLabel ?? t("pickers.search")}
          aria-label={searchLabel ?? t("pickers.search")}
        />
        {error !== null ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {error}
          </p>
        ) : null}
        <ul className="flex max-h-[46vh] min-h-120 flex-col gap-2 overflow-y-auto" aria-busy={loading || busy}>
          {loading ? (
            <li className="px-8 py-12 text-body-sm text-fg-muted">{t("pickers.loading")}</li>
          ) : rows.length === 0 ? (
            <li className="px-8 py-12 text-body-sm text-fg-muted">
              {needle === "" ? emptyText : t("pickers.noMatch", { query: query.trim() })}
            </li>
          ) : (
            rows.map((item) => {
              const off = busy || (item.disabledReason ?? null) !== null;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={off}
                    title={item.disabledReason ?? undefined}
                    onClick={() => onPick(item.id)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-12 rounded-md px-8 py-6 text-left select-none",
                      "cursor-pointer hover:bg-hover-overlay disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent",
                    )}
                  >
                    {item.lead ?? null}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body-sm-medium text-fg [unicode-bidi:isolate]">
                        {item.titleNode ?? item.title}
                      </span>
                      {item.detail ? (
                        <span className="truncate text-mono-xs text-fg-muted [unicode-bidi:isolate]">{item.detail}</span>
                      ) : null}
                      {item.disabledReason ? (
                        <span className="text-body-sm text-fg-warm">{item.disabledReason}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
        {shown.length > rows.length ? (
          <p className="text-body-sm text-fg-muted">{t("pickers.narrow", { count: shown.length - rows.length })}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

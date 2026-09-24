import { ArrowDown, ArrowUp, FilePlus, FileText, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { cn } from "../../../lib/format";
import { SHARED_SCOPE, type ConfigDocument, type Draft, type DraftConfig } from "../../../lib/ipc";
import { useConfigs, type DraftActions } from "../../../lib/queries";
import { ConfigCodeEditor } from "../../ConfigCodeEditor";
import { Button, Dialog, Input } from "../../ui";
import { Notice } from "../bundleFiles";

/** How long the editor waits after the last keystroke before it writes the draft. */
const COMMIT_MS = 800;

/** The most documents a scope may hold, as the service checks it. */
const MAX_CONFIGS = 20;

/** The most bytes of text a document may hold: 64 KiB. */
const MAX_TEXT = 64 * 1024;

/**
 * --- slice: bundles ---
 *
 * **Configs** of a component, or **Shared configs** of the draft: the config
 * documents the install makes layers of, in the order they apply.
 *
 * The list is edited here and written whole through `draft_set_configs`: a
 * rename, a move and a deletion go at once, the text of the open document
 * goes after a pause in the typing. A document comes from the Configs screen
 * — its text copied, its id kept so the origin is known — or starts empty.
 * Lines with passwords are removed by the core at publish time, which the
 * **Publish** section says.
 */
export function ConfigsTab({
  draft,
  scope,
  actions,
}: {
  draft: Draft;
  /** A component id, or `shared`. */
  scope: string;
  actions: DraftActions;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const saved: DraftConfig[] =
    scope === SHARED_SCOPE
      ? draft.shared.configs
      : (draft.components.find((component) => component.id === scope)?.configs ?? []);

  // The list as the author has it. It starts as the record and follows the
  // author from then on; the record follows the list a moment later.
  const [list, setList] = useState<DraftConfig[]>(saved);
  const [open, setOpen] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedJson = JSON.stringify(saved);

  const commit = (next: DraftConfig[]) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (JSON.stringify(next) === savedJson) return;
    setFailure(null);
    actions.setConfigs.mutate({ scope, configs: next }, { onError: (e) => setFailure(errorText(e)) });
  };

  /** A change that goes at once: a rename, a move, an addition, a deletion. */
  const change = (next: DraftConfig[]) => {
    setList(next);
    commit(next);
  };

  /** A change of text: written after a pause, or on the next change of any other kind. */
  const changeText = (index: number, text: string) => {
    const next = list.map((config, at) => (at === index ? { ...config, text } : config));
    setList(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(next), COMMIT_MS);
  };

  // A pending text goes out when the tab is left, so nothing typed is lost.
  const latest = useRef(list);
  latest.current = list;
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        commit(latest.current);
      }
    },
    // Once per mount: a tab is mounted per scope, and the commit it closes
    // over is the one of that scope.
    [],
  );

  const current = list[open] ?? null;
  const tooLong = current !== null && new TextEncoder().encode(current.text).length > MAX_TEXT;

  const add = (config: DraftConfig) => {
    const next = [...list, { ...config, priority: list.length }];
    change(next);
    setOpen(next.length - 1);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    change(next.map((config, at) => ({ ...config, priority: at })));
    setOpen(target);
  };

  const remove = (index: number) => {
    const next = list.filter((_, at) => at !== index).map((config, at) => ({ ...config, priority: at }));
    change(next);
    setOpen(Math.max(0, Math.min(open, next.length - 1)));
  };

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        <p className="text-body-sm text-fg-muted flex-1 min-w-200">
          {scope === SHARED_SCOPE ? t("editor.configs.textShared") : t("editor.configs.text")}
        </p>
        <Button
          size="sm"
          icon={<FileText size={14} />}
          disabled={list.length >= MAX_CONFIGS}
          onClick={() => setPickerOpen(true)}
        >
          {t("editor.configs.addFromConfigs")}
        </Button>
        <Button
          size="sm"
          icon={<FilePlus size={14} />}
          disabled={list.length >= MAX_CONFIGS}
          onClick={() =>
            add({ name: t("editor.configs.untitled", { index: list.length + 1 }), text: "", priority: 0, sourceConfigId: null })
          }
        >
          {t("editor.configs.addEmpty")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {failure}
        </p>
      ) : null}

      {list.length === 0 ? (
        <p className="text-body-sm text-fg-muted">{t("editor.configs.empty")}</p>
      ) : (
        <div className="flex items-start gap-16">
          <ul className="w-232 shrink-0 flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
            {list.map((config, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => setOpen(index)}
                  aria-pressed={index === open}
                  className={cn(
                    "flex w-full items-center gap-8 px-12 py-8 text-left cursor-pointer select-none",
                    index === open ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
                  )}
                >
                  <span className="text-mono-xs text-fg-muted shrink-0">{index + 1}</span>
                  <span className="text-body-sm truncate flex-1 min-w-0">{config.name || t("editor.configs.unnamed")}</span>
                </button>
              </li>
            ))}
          </ul>

          {current !== null ? (
            <div className="flex-1 min-w-0 flex flex-col gap-8">
              <div className="flex items-center gap-8">
                <Input
                  value={current.name}
                  aria-label={t("editor.configs.name")}
                  placeholder={t("editor.configs.namePlaceholder")}
                  maxLength={64}
                  onChange={(event) =>
                    setList(list.map((config, at) => (at === open ? { ...config, name: event.target.value } : config)))
                  }
                  onBlur={() => commit(list)}
                  className="flex-1 max-w-[360px]"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ArrowUp size={14} />}
                  disabled={open === 0}
                  aria-label={t("editor.configs.moveUp")}
                  title={t("editor.configs.moveUp")}
                  onClick={() => move(open, -1)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ArrowDown size={14} />}
                  disabled={open === list.length - 1}
                  aria-label={t("editor.configs.moveDown")}
                  title={t("editor.configs.moveDown")}
                  onClick={() => move(open, 1)}
                />
                <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => remove(open)}>
                  {tCommon("actions.remove")}
                </Button>
              </div>
              {current.sourceConfigId ? (
                <span className="text-body-sm text-fg-muted">{t("editor.configs.fromDocument")}</span>
              ) : null}
              <ConfigCodeEditor
                key={`${scope}:${open}`}
                value={current.text}
                onChange={(text) => changeText(open, text)}
                height={320}
                // A fixed label: the editor is rebuilt when its label changes,
                // and the name is typed in the field above it.
                ariaLabel={t("editor.configs.editor")}
              />
              {tooLong ? <Notice tone="danger">{t("editor.configs.tooLong")}</Notice> : null}
              <span className="text-body-sm text-fg-muted">{t("editor.configs.passwordsNote")}</span>
            </div>
          ) : null}
        </div>
      )}

      {pickerOpen ? (
        <ConfigPickerDialog
          draft={draft}
          onPick={(document) => {
            setPickerOpen(false);
            add({ name: document.name, text: document.text, priority: 0, sourceConfigId: document.id });
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** The documents of the Configs screen for this game, one to copy into the draft. */
function ConfigPickerDialog({
  draft,
  onPick,
  onClose,
}: {
  draft: Draft;
  onPick: (document: ConfigDocument) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const book = useConfigs();
  const documents = useMemo(
    () => (book.data?.documents ?? []).filter((document) => document.game === draft.game),
    [book.data, draft.game],
  );

  return (
    <Dialog
      title={t("editor.configs.pickTitle")}
      onClose={onClose}
      actions={
        <Button variant="ghost" onClick={onClose}>
          {tCommon("actions.cancel")}
        </Button>
      }
    >
      <div className="flex flex-col gap-8 pt-16 max-h-[50vh] overflow-y-auto pr-4">
        {book.error ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {errorText(book.error)}
          </p>
        ) : book.isLoading ? (
          <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
        ) : documents.length === 0 ? (
          <p className="text-body-sm text-fg-muted">{t("editor.configs.pickEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
            {documents.map((document) => (
              <li key={document.id}>
                <button
                  type="button"
                  onClick={() => onPick(document)}
                  className="flex w-full items-center gap-8 px-12 py-8 text-left cursor-pointer hover:bg-hover-overlay"
                >
                  <FileText size={14} className="text-fg-muted shrink-0" aria-hidden />
                  <span className="text-body-sm text-fg truncate flex-1 min-w-0">{document.name}</span>
                  <span className="text-mono-xs text-fg-muted shrink-0">
                    {t("editor.configs.lines", { count: document.text.split("\n").length })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

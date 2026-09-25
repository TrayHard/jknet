import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, Pencil, Plus, Trash2, Undo2, X } from "lucide-react";
import { Button, Input, Select } from "./ui";
import { ColoredNickname } from "./client/ColoredNickname";
import { useErrorText } from "../i18n/errors";
import { cn } from "../lib/format";
import type { BindSource } from "../lib/quakeConfig";
import {
  ChainEditError,
  addBranch,
  bindingOf,
  changeKey,
  cycleEditable,
  exploreChain,
  insertCycleStep,
  keyCycle,
  keyInfo,
  loadChainState,
  overrideBinding,
  overrideVariable,
  removeBranch,
  removeCycleStep,
  reorderCycle,
  setStepCommands,
  variableInfo,
  withStartBinding,
  type ChainDiagnostic,
  type ChainGraph,
  type ChainPress,
  type ChainState,
  type CommandContainer,
} from "../lib/vstrChain";

/** Rows deeper than this start collapsed. */
const OPEN_DEPTH = 2;

type Editing = { id: string; mode: "commands" | "branch" } | { id: "cycle"; mode: "step" } | null;

interface Tree {
  /** The key the panel explains: its own rebinds are the mechanics of its cycle, not news. */
  root: string;
  graph: ChainGraph;
  state: ChainState;
  sources: BindSource[];
  editable: boolean;
  labels: Map<number, string>;
  selected: string | null;
  /** The row that holds the tree's single tab stop. */
  active: string | null;
  items: Map<string, HTMLLIElement>;
  editing: Editing;
  isOpen: (id: string, depth: number) => boolean;
  toggle: (id: string) => void;
  select: (press: ChainPress) => void;
  hover: (press: ChainPress | null) => void;
  focus: (id: string) => void;
  navigate: (event: KeyboardEvent<HTMLLIElement>, id: string) => void;
  edit: (editing: Editing) => void;
  write: (change: () => string) => void;
}

/** A visible row, in document order: what the arrow keys walk. */
interface Row {
  id: string;
  parent: string | null;
  kids: number;
  open: boolean;
}

const rowId = (press: ChainPress) => press.path.join(" ");

function childrenOf(graph: ChainGraph, press: ChainPress): ChainPress[] {
  return press.kind === "branch" && press.to !== null ? graph.nodes[press.to].presses : [];
}

/** Keys a press rebinds, the explained key aside: what the keyboard outlines for it. */
const reboundKeys = (press: ChainPress, root: string) =>
  press.step.rebinds.filter((change) => change.key !== root).map((change) => change.key);

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

/**
 * What a key's `vstr` chain does, as a tree of presses. It sits under the
 * Command field of the Binds tab. Every change is written into the edited
 * config through `onChange`, so the Script section shows the same text.
 */
export function VstrChainPanel({
  sources,
  keyName,
  command,
  readOnly,
  onChange,
  onKeyChange,
  onOutline,
}: {
  sources: BindSource[];
  keyName: string;
  command: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  onKeyChange: (key: string) => void;
  onOutline: (keys: string[]) => void;
}) {
  const { t } = useTranslation("common");
  const errorText = useErrorText();
  // The page builds a new `sources` array on every render; the signature changes only with the texts.
  const signature = sources.map((source) => `${source.kind}\u0000${source.source}\u0000${source.text}`).join("\u0001");
  const state = useMemo(() => loadChainState(sources), [signature]);
  const preview = command.trim() !== "" && command !== bindingOf(state, keyName);
  const start = useMemo(
    () => (preview ? withStartBinding(state, keyName, command) : state),
    [state, preview, keyName, command],
  );
  const graph = useMemo(() => exploreChain(start, keyName), [start, keyName]);
  const editable = !readOnly && !preview && state.editedIndex >= 0;
  const cycle = useMemo(() => keyCycle(start, keyName), [start, keyName]);
  const canCycle = useMemo(
    () => editable && cycle.loopsTo === 0 && cycle.steps.length >= 2 && cycleEditable(sources, keyName),
    [editable, cycle, signature, keyName],
  );
  const root = graph.nodes[0].presses[0];
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<ChainPress | null>(null);
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<unknown>(null);
  const [moveFrom, setMoveFrom] = useState(keyName);
  const [moveTo, setMoveTo] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLLIElement>());

  const presses = useMemo(() => {
    const all = new Map<string, ChainPress>();
    for (const node of graph.nodes) for (const press of node.presses) all.set(rowId(press), press);
    return all;
  }, [graph]);
  const selectedPress = (selected ? presses.get(selected) : undefined) ?? root;
  const shown = hovered ?? selectedPress;
  const outline = shown ? reboundKeys(shown, keyName) : [];
  const outlineKey = outline.join(" ");
  useEffect(() => {
    onOutline(outlineKey ? outlineKey.split(" ") : []);
  }, [outlineKey, onOutline]);
  useEffect(() => () => onOutline([]), [onOutline]);

  const labels = useMemo(() => {
    const made = new Map<number, string>();
    for (const node of graph.nodes)
      for (const press of node.presses)
        if (press.kind === "branch" && press.to !== null) {
          const body = press.step.body;
          made.set(press.to, `${press.key} ${body?.kind === "variable" ? body.name : t("configs.chain.binding")}`);
        }
    return made;
  }, [graph, t]);

  const write = (change: () => string) => {
    try {
      onChange(change());
      setError(null);
      setEditing(null);
    } catch (caught) {
      setError(caught);
    }
  };
  const isOpen = (id: string, depth: number) => (depth < OPEN_DEPTH) !== toggled.has(id);
  const toggle = (id: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const rows: Row[] = [];
  const walk = (press: ChainPress, parent: string | null, depth: number) => {
    const id = rowId(press);
    const kids = childrenOf(graph, press);
    const open = kids.length > 0 && isOpen(id, depth);
    rows.push({ id, parent, kids: kids.length, open });
    if (open) for (const kid of kids) walk(kid, id, depth + 1);
  };
  if (root) walk(root, null, 0);
  const selectedId = selected ?? (root ? rowId(root) : null);
  const visible = (id: string | null) => id !== null && rows.some((row) => row.id === id);
  const active = visible(focused) ? focused : visible(selectedId) ? selectedId : (rows[0]?.id ?? null);
  const moveFocus = (id: string | null | undefined) => {
    if (!id) return;
    setFocused(id);
    items.current.get(id)?.focus();
  };
  // The treeview keyboard model of WAI-ARIA: arrows walk the visible rows,
  // Right and Left open, close and climb, Enter and Space select.
  const navigate = (event: KeyboardEvent<HTMLLIElement>, id: string) => {
    if (event.target !== event.currentTarget) return;
    const at = rows.findIndex((row) => row.id === id);
    const row = rows[at];
    if (!row) return;
    if (event.key === "ArrowDown") moveFocus(rows[at + 1]?.id);
    else if (event.key === "ArrowUp") moveFocus(rows[at - 1]?.id);
    else if (event.key === "Home") moveFocus(rows[0]?.id);
    else if (event.key === "End") moveFocus(rows[rows.length - 1]?.id);
    else if (event.key === "ArrowRight") {
      if (row.kids && !row.open) toggle(id);
      else if (row.open) moveFocus(rows[at + 1]?.id);
    } else if (event.key === "ArrowLeft") {
      if (row.open) toggle(id);
      else moveFocus(row.parent);
    } else if (event.key === "Enter" || event.key === " ") setSelected(id);
    else return;
    event.preventDefault();
  };
  const tree: Tree = {
    root: keyName,
    graph,
    state: start,
    sources,
    editable,
    labels,
    selected: selectedId,
    active,
    items: items.current,
    editing,
    isOpen,
    toggle,
    select: (press) => setSelected(rowId(press)),
    hover: setHovered,
    focus: setFocused,
    navigate,
    edit: (next) => {
      setEditing(next);
      setError(null);
    },
    write,
  };
  const message = (caught: unknown) =>
    caught instanceof ChainEditError ? t(`configs.chain.error_${caught.code}`) : errorText(caught);
  const loadProblems = graph.diagnostics.filter((diagnostic) => diagnostic.path === null);

  return (
    <section
      aria-label={t("configs.chain.label", { command })}
      className="flex flex-col gap-12 rounded-md border border-line bg-input p-12"
    >
      <div className="flex flex-col gap-4">
        <h3 className="text-body-md-medium text-fg">
          <Trans t={t} i18nKey="configs.chain.title" values={{ command }} components={[<code className="text-mono-sm text-fg-accent" />]} />
        </h3>
        <p className="text-body-xs text-fg-muted">{t(preview ? "configs.chain.preview" : "configs.chain.hint")}</p>
      </div>
      {loadProblems.length ? (
        <div className="flex flex-col gap-2">
          {loadProblems.map((diagnostic, i) => (
            <DiagnosticLine key={i} diagnostic={diagnostic} />
          ))}
        </div>
      ) : null}
      {root ? (
        <ul role="tree" aria-label={t("configs.chain.label", { command })} className="flex flex-col gap-2">
          <PressRow press={root} parent={null} depth={0} tree={tree} />
        </ul>
      ) : null}
      {graph.truncated ? (
        <p className="text-body-xs text-fg-muted">{t("configs.chain.truncated", { count: graph.nodes.length })}</p>
      ) : null}
      {canCycle ? (
        <CycleSteps keyName={keyName} steps={cycle.steps.map((step) => step.body)} tree={tree} />
      ) : null}
      {editable && graph.keys.length ? (
        <div className="flex flex-wrap items-end gap-8 border-t border-line pt-12">
          <span className="text-body-sm text-fg-secondary basis-full">{t("configs.chain.moveKey")}</span>
          <Select
            className="w-120"
            ariaLabel={t("configs.chain.moveKeyFrom")}
            value={graph.keys.some((info) => info.key === moveFrom) ? moveFrom : keyName}
            onChange={setMoveFrom}
            options={graph.keys.map((info) => ({ value: info.key, label: info.key }))}
          />
          <span aria-hidden="true" className="text-fg-muted pb-8">→</span>
          <Input
            className="w-160"
            aria-label={t("configs.chain.moveKeyTo")}
            placeholder={t("configs.chain.moveKeyTo")}
            value={moveTo}
            onChange={(event) => setMoveTo(event.target.value)}
          />
          <Button
            size="sm"
            disabled={!moveTo.trim()}
            onClick={() => {
              const from = graph.keys.some((info) => info.key === moveFrom) ? moveFrom : keyName;
              const to = moveTo.trim();
              try {
                onChange(changeKey(sources, from, to));
                setError(null);
                setMoveTo("");
                if (from === keyName) onKeyChange(to.toUpperCase());
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            {t("configs.chain.move")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {message(error)}
        </p>
      ) : null}
    </section>
  );
}

function KeyChip({ label, tone = "neutral", id }: { label: string; tone?: "neutral" | "accent" | "danger"; id?: string }) {
  return (
    <span
      id={id}
      className={cn(
        "inline-flex h-22 min-w-22 items-center justify-center rounded-sm border px-4 text-mono-xs",
        tone === "accent" && "border-line-accent bg-accent-subtle text-fg-accent",
        tone === "danger" && "border-line-danger text-fg-danger",
        tone === "neutral" && "border-line bg-elevated text-fg-secondary",
      )}
    >
      {label}
    </span>
  );
}

function DiagnosticLine({ diagnostic }: { diagnostic: ChainDiagnostic }) {
  const { t } = useTranslation("common");
  const tone =
    diagnostic.kind === "missing" || diagnostic.kind === "immediateLoop"
      ? "text-fg-danger"
      : diagnostic.kind === "frameLoop"
        ? "text-fg-warm"
        : "text-fg-muted";
  if (diagnostic.kind === "limit") {
    const text =
      diagnostic.subject === "commands"
        ? t("configs.chain.limit_commands")
        : diagnostic.subject === "depth"
          ? t("configs.chain.limit_depth")
          : diagnostic.subject === "presses"
            ? t("configs.chain.limit_presses")
            : t("configs.chain.limit_nodes");
    return <p className={cn("text-body-xs", tone)}>{text}</p>;
  }
  return (
    <p className={cn("text-body-xs", tone)}>
      <Trans
        t={t}
        i18nKey={`configs.chain.diag_${diagnostic.kind}`}
        values={{ subject: diagnostic.subject }}
        components={[<code className="text-mono-xs" />]}
      />
      {diagnostic.afterOpaque ? ` ${t("configs.chain.diag_afterOpaque")}` : null}
    </p>
  );
}

function Commands({ press, showEmpty }: { press: ChainPress; showEmpty: boolean }) {
  const { t } = useTranslation("common");
  const step = press.step;
  const parts: ReactNode[] = step.visible.map((command, i) => (
    <ColoredNickname key={`v${i}`} raw={command.text} placeholder="" className="text-mono-sm text-fg break-all" />
  ));
  for (const [i, name] of step.calls.entries())
    parts.push(
      <span key={`c${i}`} className="text-body-sm text-fg-secondary">
        <Trans t={t} i18nKey="configs.chain.runs" values={{ name }} components={[<code className="text-mono-sm text-fg" />]} />
      </span>,
    );
  if (!step.binding) return <span className="text-body-sm text-fg-muted">{t("configs.chain.unbound")}</span>;
  if (!parts.length)
    return step.missing || !showEmpty ? null : <span className="text-body-sm text-fg-muted">{t("configs.chain.noCommands")}</span>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-baseline gap-8">
          {i ? <span aria-hidden="true" className="text-fg-muted">·</span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function PressRow({ press, parent, depth, tree }: { press: ChainPress; parent: ChainPress | null; depth: number; tree: Tree }) {
  const { t } = useTranslation("common");
  const uid = useId();
  const step = press.step;
  const id = rowId(press);
  const children = childrenOf(tree.graph, press);
  const open = tree.isOpen(id, depth);
  // Only the row that holds the tab stop lets Tab into its own buttons.
  const tabStop = tree.active === id ? 0 : -1;
  const body = step.body;
  const variable = body?.kind === "variable" ? variableInfo(tree.state, body.name) : null;
  const binding = body?.kind === "binding" ? keyInfo(tree.state, press.key) : null;
  const owner = variable ?? binding;
  // A binding the chain wrote itself is no line of the config: only the start binding is.
  const ownBinding = binding !== null && bindingOf(tree.graph.nodes[press.from].state, press.key) === binding.command;
  const canEdit =
    tree.editable && (step.missing !== null || (variable?.editable ?? false) || (ownBinding && (binding?.editable ?? false)));
  const canBranch = tree.editable && (variable?.editable ?? false);
  const isBranch =
    parent !== null &&
    press.key !== parent.key &&
    parent.step.bodyCommands.some((command) => command.role === "branch" && command.target === press.key);
  const canRemove = tree.editable && isBranch && parent.step.body?.kind === "variable" &&
    variableInfo(tree.state, parent.step.body.name).editable;
  const rebinds = step.rebinds.filter((change) => change.key !== tree.root && !change.restore);
  // A press that leads back to a known state says so; the keys it gives back on the way are that state.
  const restores =
    press.kind === "link" ? [] : step.rebinds.filter((change) => change.key !== tree.root && change.restore);
  const problems = step.diagnostics.filter(
    (diagnostic, i, all) => all.findIndex((other) => other.kind === diagnostic.kind && other.subject === diagnostic.subject) === i,
  );
  const danger = step.missing !== null || step.outcome === "immediateLoop";
  const editingHere = tree.editing && tree.editing.id === id ? tree.editing.mode : null;
  return (
    <li
      ref={(element) => {
        if (element) tree.items.set(id, element);
        else tree.items.delete(id);
      }}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={children.length ? open : undefined}
      aria-selected={tree.selected === id}
      aria-labelledby={`${uid}-key ${uid}-name`}
      aria-describedby={`${uid}-what`}
      tabIndex={tabStop}
      onKeyDown={(event) => tree.navigate(event, id)}
      onFocus={(event) => {
        if (event.target === event.currentTarget) tree.focus(id);
      }}
      // The ring goes round the row, not round the row and its whole subtree.
      className="flex flex-col gap-2 focus-visible:outline-none [&:focus-visible>div]:outline-2 [&:focus-visible>div]:outline-offset-1 [&:focus-visible>div]:outline-line-focus"
    >
      <div
        className={cn(
          "group flex items-start gap-8 rounded-md px-8 py-6",
          danger && "bg-danger-subtle",
          tree.selected === id && !danger && "bg-selected-overlay",
        )}
        onMouseEnter={() => tree.hover(press)}
        onMouseLeave={() => tree.hover(null)}
        onClick={() => tree.select(press)}
      >
        <span className="flex w-16 shrink-0 justify-center pt-4">
          {children.length ? (
            <button
              type="button"
              tabIndex={-1}
              className="select-none text-fg-muted hover:text-fg"
              aria-label={t(open ? "configs.chain.collapse" : "configs.chain.expand")}
              title={t(open ? "configs.chain.collapse" : "configs.chain.expand")}
              onClick={(event) => {
                event.stopPropagation();
                tree.toggle(id);
              }}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : null}
        </span>
        <div className="flex w-160 shrink-0 items-center gap-6">
          <button
            type="button"
            tabIndex={-1}
            className="select-none"
            aria-pressed={tree.selected === id}
            aria-label={t("configs.chain.selectPress", { key: press.key })}
            title={t("configs.chain.selectPress", { key: press.key })}
            onClick={() => tree.select(press)}
          >
            <KeyChip id={`${uid}-key`} label={press.key} tone={danger ? "danger" : depth === 0 ? "accent" : "neutral"} />
          </button>
          <span id={`${uid}-name`} className={cn("truncate text-mono-xs", step.missing ? "text-fg-danger" : "text-fg-muted")}>
            {step.missing ?? (body?.kind === "variable" ? body.name : body ? t("configs.chain.binding") : "")}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {editingHere === "commands" ? (
            <CommandsEditor
              name={step.missing ?? (body?.kind === "variable" ? body.name : press.key)}
              initial={step.visible.map((command) => command.text).join("\n")}
              onSave={(text) => tree.write(() => setStepCommands(tree.sources, press.path, lines(text)))}
              onCancel={() => tree.edit(null)}
            />
          ) : null}
          <div id={`${uid}-what`} className="flex flex-col gap-4">
            {editingHere === "commands" ? null : (
              <Commands press={press} showEmpty={press.kind !== "link" && !rebinds.length && !restores.length} />
            )}
            {rebinds.length || restores.length ? (
              <span className="flex flex-wrap items-center gap-4 text-body-xs">
                {rebinds.length ? <span className="text-fg-accent">{t("configs.chain.rebinds")}</span> : null}
                {rebinds.map((change) => (
                  <KeyChip key={`r${change.key}`} label={change.key} tone="accent" />
                ))}
                {rebinds.length && restores.length ? <span aria-hidden="true" className="text-fg-muted">·</span> : null}
                {restores.length ? <span className="text-fg-muted">{t("configs.chain.restores")}</span> : null}
                {restores.map((change) => (
                  <KeyChip key={`g${change.key}`} label={change.key} />
                ))}
              </span>
            ) : null}
            {press.kind === "link" && press.to !== null ? (
              <span className="inline-flex items-center gap-4 text-body-xs text-fg-muted">
                <Undo2 size={12} aria-hidden="true" />
                {press.to === 0 ? (
                  t("configs.chain.backToStart")
                ) : (
                  <Trans
                    t={t}
                    i18nKey="configs.chain.backTo"
                    values={{ step: tree.labels.get(press.to) ?? "" }}
                    components={[<code className="text-mono-xs text-fg-secondary" />]}
                  />
                )}
              </span>
            ) : null}
            {press.kind === "cut" ? <span className="text-body-xs text-fg-muted">{t("configs.chain.cut")}</span> : null}
            {problems.map((diagnostic, i) => (
              <DiagnosticLine key={i} diagnostic={diagnostic} />
            ))}
          </div>
          {owner && owner.kind !== "edited" && owner.source !== null ? (
            <span className="flex flex-wrap items-center gap-8 text-body-xs text-fg-muted">
              <span className="break-all">
                {t(owner.overridable ? "configs.chain.source" : "configs.chain.shadowed", { source: owner.source })}
              </span>
              {tree.editable && owner.overridable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  tabIndex={tabStop}
                  onClick={() =>
                    tree.write(() =>
                      variable ? overrideVariable(tree.sources, variable.name) : overrideBinding(tree.sources, press.key),
                    )
                  }
                >
                  {t("configs.chain.override")}
                </Button>
              ) : null}
            </span>
          ) : null}
          {editingHere === "branch" ? (
            <BranchEditor
              onAdd={(key, text) => tree.write(() => addBranch(tree.sources, press.path, key, lines(text)))}
              onCancel={() => tree.edit(null)}
            />
          ) : null}
          {!editingHere && (canEdit || canBranch || canRemove) ? (
            // Actions show on the row under the pointer, the row with the tab stop and the selected one.
            <span
              className={cn(
                "flex-wrap gap-4",
                tree.selected === id || tree.active === id ? "flex" : "hidden group-hover:flex group-focus-within:flex",
              )}
            >
              {canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  tabIndex={tabStop}
                  icon={<Pencil size={12} />}
                  onClick={() => tree.edit({ id, mode: "commands" })}
                >
                  {t("configs.chain.edit")}
                </Button>
              ) : null}
              {canBranch ? (
                <Button
                  size="sm"
                  variant="ghost"
                  tabIndex={tabStop}
                  icon={<GitBranch size={12} />}
                  onClick={() => tree.edit({ id, mode: "branch" })}
                >
                  {t("configs.chain.addBranch")}
                </Button>
              ) : null}
              {canRemove && parent ? (
                <Button
                  size="sm"
                  variant="ghost"
                  tabIndex={tabStop}
                  icon={<Trash2 size={12} />}
                  aria-label={t("configs.chain.removeBranch", { key: press.key })}
                  title={t("configs.chain.removeBranch", { key: press.key })}
                  onClick={() => tree.write(() => removeBranch(tree.sources, parent.path, press.key))}
                >
                  {t("configs.chain.removeBranchShort")}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
      {children.length && open ? (
        <ul role="group" className="ml-16 flex flex-col gap-2 border-l border-line pl-12">
          {children.map((child) => (
            <PressRow key={rowId(child)} press={child} parent={press} depth={depth + 1} tree={tree} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const textareaClass = cn(
  "w-full px-12 py-8 rounded-md resize-y bg-app border border-line focus:border-line-focus outline-none",
  "text-mono-xs text-fg placeholder:text-fg-muted",
);

function CommandsEditor({ name, initial, onSave, onCancel }: { name: string; initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const { t } = useTranslation("common");
  const [text, setText] = useState(initial);
  return (
    <span className="flex flex-col gap-6">
      <textarea
        autoFocus
        rows={Math.max(2, text.split("\n").length)}
        spellCheck={false}
        value={text}
        aria-label={t("configs.chain.commandsLabel", { name })}
        className={textareaClass}
        onChange={(event) => setText(event.target.value)}
      />
      <span className="flex gap-4">
        <Button size="sm" variant="primary" onClick={() => onSave(text)}>
          {t("configs.chain.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("configs.chain.cancel")}
        </Button>
      </span>
    </span>
  );
}

function BranchEditor({ onAdd, onCancel }: { onAdd: (key: string, text: string) => void; onCancel: () => void }) {
  const { t } = useTranslation("common");
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  return (
    <span className="flex flex-col gap-6">
      <span className="flex items-center gap-8">
        <Input
          autoFocus
          className="w-96"
          aria-label={t("configs.chain.branchKey")}
          placeholder={t("configs.chain.branchKey")}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </span>
      <textarea
        rows={2}
        spellCheck={false}
        value={text}
        aria-label={t("configs.chain.branchCommands")}
        placeholder={t("configs.chain.branchCommands")}
        className={textareaClass}
        onChange={(event) => setText(event.target.value)}
      />
      <span className="flex gap-4">
        <Button size="sm" variant="primary" icon={<Plus size={12} />} disabled={!key.trim()} onClick={() => onAdd(key.trim(), text)}>
          {t("configs.chain.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("configs.chain.cancel")}
        </Button>
      </span>
    </span>
  );
}

function CycleSteps({ keyName, steps, tree }: { keyName: string; steps: (CommandContainer | null)[]; tree: Tree }) {
  const { t } = useTranslation("common");
  const names = steps.map((body) => (body?.kind === "variable" ? body.name : ""));
  const order = names.map((_, i) => i);
  const move = (from: number, to: number) => {
    const next = [...order];
    [next[from], next[to]] = [next[to], next[from]];
    tree.write(() => reorderCycle(tree.sources, keyName, next));
  };
  return (
    <div className="flex flex-col gap-6 border-t border-line pt-12">
      <span className="text-body-sm text-fg-secondary">{t("configs.chain.cycle", { key: keyName })}</span>
      <ol className="flex flex-col gap-4">
        {names.map((name, i) => (
          <li key={name} className="flex items-center gap-6">
            <span className="w-20 text-right text-mono-xs text-fg-muted">{i + 1}</span>
            <code className="min-w-0 flex-1 truncate text-mono-sm text-fg">{name}</code>
            <Button
              size="sm"
              variant="ghost"
              className="px-4"
              disabled={i === 0}
              aria-label={t("configs.chain.moveEarlier", { name })}
              title={t("configs.chain.moveEarlier", { name })}
              icon={<ArrowUp size={12} />}
              onClick={() => move(i, i - 1)}
            />
            <Button
              size="sm"
              variant="ghost"
              className="px-4"
              disabled={i === names.length - 1}
              aria-label={t("configs.chain.moveLater", { name })}
              title={t("configs.chain.moveLater", { name })}
              icon={<ArrowDown size={12} />}
              onClick={() => move(i, i + 1)}
            />
            <Button
              size="sm"
              variant="ghost"
              className="px-4"
              disabled={names.length < 2}
              aria-label={t("configs.chain.removeStep", { name })}
              title={t("configs.chain.removeStep", { name })}
              icon={<X size={12} />}
              onClick={() => tree.write(() => removeCycleStep(tree.sources, keyName, i))}
            />
          </li>
        ))}
      </ol>
      {tree.editing?.id === "cycle" ? (
        <CommandsEditor
          name={keyName}
          initial=""
          onSave={(text) => tree.write(() => insertCycleStep(tree.sources, keyName, names.length, lines(text)))}
          onCancel={() => tree.edit(null)}
        />
      ) : (
        <span>
          <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => tree.edit({ id: "cycle", mode: "step" })}>
            {t("configs.chain.addStep")}
          </Button>
        </span>
      )}
    </div>
  );
}

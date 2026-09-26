import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { linter, lintGutter } from "@codemirror/lint";
import {
  catalog,
  SCRIPT_COMMANDS,
  scriptIssues,
  configAssignments,
} from "../lib/configScript";
import { GAME_KEYS } from "../lib/gameKeys";

export function ConfigCodeEditor({
  value,
  onChange,
  height = 420,
  ariaLabel,
  marks,
}: {
  value: string;
  onChange: (text: string) => void;
  height?: number;
  ariaLabel?: string;
  // --- slice: chat cards ---
  /**
   * Lines to mark as errors in the gutter and under the text, 1-based, with
   * the sentence the tooltip shows: the dangerous commands of a config that
   * came in a chat. Read when the editor is created.
   */
  marks?: { line: number; message: string }[];
}) {
  const { t } = useTranslation("common"),
    host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    callback = useRef(onChange),
    // --- slice: chat cards --- read by the linter on every pass.
    marked = useRef(marks ?? []);
  callback.current = onChange;
  marked.current = marks ?? [];
  useEffect(() => {
    if (!host.current) return;
    const language = StreamLanguage.define({
      token(stream) {
        if (stream.eatSpace()) return null;
        if (stream.match("//")) {
          stream.skipToEnd();
          return "comment";
        }
        if (stream.match(/"[^"\n]*"/)) return "string";
        if (stream.match(/[+-]?\d+(?:\.\d+)?/)) return "number";
        if (
          stream.match(
            /\b(?:set[aus]?|bind|unbind|unbindall|exec|vstr|wait|echo)\b/i,
          )
        )
          return "keyword";
        if (stream.match(/[\w.+-]+/)) return "variableName";
        stream.next();
        return null;
      },
    });
    const colors = HighlightStyle.define([
      { tag: tags.keyword, color: "var(--color-text-accent)" },
      { tag: tags.string, color: "var(--color-text-success)" },
      { tag: tags.number, color: "var(--color-text-warm)" },
      {
        tag: tags.comment,
        color: "var(--color-text-muted)",
        fontStyle: "italic",
      },
      { tag: tags.variableName, color: "var(--color-text-primary)" },
    ]);
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          highlightSelectionMatches(),
          lintGutter(),
          language,
          syntaxHighlighting(colors),
          EditorView.lineWrapping,
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          autocompletion({
            override: [
              (context) => {
                const word = context.matchBefore(/[\w.+-]*/);
                if (!word || (word.from === word.to && !context.explicit))
                  return null;
                const vars = [
                  ...configAssignments(context.state.doc.toString()).keys(),
                ];
                return {
                  from: word.from,
                  options: [
                    ...SCRIPT_COMMANDS.map((label) => ({
                      label,
                      type: "keyword",
                    })),
                    ...catalog.map((c) => ({
                      label: c.name,
                      type: "variable",
                      detail: c.defaultValue,
                    })),
                    ...vars.map((label) => ({ label, type: "variable" })),
                    ...[...new Set(GAME_KEYS.map((k) => k.token))].map(
                      (label) => ({ label, type: "constant" }),
                    ),
                  ],
                };
              },
            ],
          }),
          linter((v) => [
            ...scriptIssues(v.state.doc.toString()).map((issue) => {
              const line = v.state.doc.line(issue.line);
              return {
                from: line.from,
                to: line.to,
                severity:
                  issue.kind === "quote"
                    ? ("error" as const)
                    : ("warning" as const),
                message: t(`configStudio.issue_${issue.kind}`, {
                  value: issue.value,
                }),
              };
            }),
            // --- slice: chat cards --- the lines a chat card asks the
            // player to read, as long as the text still has them.
            ...marked.current
              .filter((mark) => mark.line >= 1 && mark.line <= v.state.doc.lines)
              .map((mark) => {
                const line = v.state.doc.line(mark.line);
                return {
                  from: line.from,
                  to: line.to,
                  severity: "error" as const,
                  message: mark.message,
                };
              }),
          ]),
          EditorView.theme(
            {
              "&": {
                height: `${height}px`,
                color: "var(--color-fg)",
                backgroundColor: "var(--color-bg-input)",
              },
              ".cm-scroller": {
                overflow: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: "13px",
              },
              ".cm-gutters": {
                backgroundColor: "var(--color-bg-elevated)",
                color: "var(--color-fg-muted)",
                border: "none",
              },
              ".cm-activeLine,.cm-activeLineGutter": {
                backgroundColor: "var(--color-bg-hover-overlay)",
              },
              ".cm-content": { padding: "12px 0" },
              ".cm-tooltip": {
                backgroundColor: "var(--color-bg-elevated)",
                color: "var(--color-fg)",
                borderColor: "var(--color-line)",
              },
              ".cm-panels": {
                backgroundColor: "var(--color-bg-elevated)",
                color: "var(--color-fg)",
              },
              ".cm-search input": {
                backgroundColor: "var(--color-bg-input)",
                border: "1px solid var(--color-line)",
              },
              ".cm-cursor": { borderLeftColor: "var(--color-fg)" },
            },
            { dark: true },
          ),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel ?? t("configs.editor"),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callback.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [t, height, ariaLabel]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  }, [value]);
  return (
    <div
      ref={host}
      className="min-w-0 overflow-hidden rounded-md border border-line"
    />
  );
}

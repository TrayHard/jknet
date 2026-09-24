import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * --- slice: pk3 editor ---
 * A text file of an archive, editable: the grammar the game's text formats
 * share, as `CodeView` of the preview reads them, with the history, the
 * search and the selection helpers `ConfigCodeEditor` gives a config. A
 * shader, an effect, a menu, a config and a script are all blocks in braces
 * with one directive per line, so the first word of a line is the keyword,
 * a line or block comment is a comment, and what stands in quotes is a
 * string. No completion and no lint: those know the cvars of a config, and
 * a shader is not one.
 */

/** The commands a config line starts with; anything else at the top level is a name being defined. */
const COMMANDS = /^(?:set[aus]?|bind|unbind|unbindall|exec|vstr|wait|echo|cmd|rcon|alias)$/i;

interface Scope {
  depth: number;
  inBlockComment: boolean;
}

const grammar = StreamLanguage.define<Scope>({
  startState: () => ({ depth: 0, inBlockComment: false }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match(/^.*?\*\//)) state.inBlockComment = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }
    if (stream.match(/^"[^"\n]*"?/)) return "string";
    if (stream.match("{")) {
      state.depth += 1;
      return "brace";
    }
    if (stream.match("}")) {
      state.depth = Math.max(0, state.depth - 1);
      return "brace";
    }
    if (stream.match(/^[+-]?\d+(?:\.\d+)?\b/)) return "number";
    // The first word of a line is the directive; whatever follows are its arguments.
    const first = stream.string.slice(0, stream.start).trim() === "";
    if (stream.match(/^[^\s{}"]+/)) {
      const word = stream.current();
      if (!first) return "variableName";
      if (state.depth > 0 || COMMANDS.test(word)) return "keyword";
      return "typeName";
    }
    stream.next();
    return null;
  },
});

const colors = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--color-text-accent)" },
  { tag: tags.typeName, color: "var(--color-text-purple)" },
  { tag: tags.string, color: "var(--color-text-success)" },
  { tag: tags.number, color: "var(--color-text-warm)" },
  { tag: tags.brace, color: "var(--color-text-secondary)" },
  { tag: tags.comment, color: "var(--color-text-muted)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--color-text-primary)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", color: "var(--color-fg)", backgroundColor: "var(--color-bg-input)" },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "18px" },
    ".cm-gutters": { backgroundColor: "var(--color-bg-elevated)", color: "var(--color-fg-muted)", border: "none" },
    ".cm-activeLine,.cm-activeLineGutter": { backgroundColor: "var(--color-bg-hover-overlay)" },
    ".cm-content": { padding: "8px 0" },
    ".cm-panels": { backgroundColor: "var(--color-bg-elevated)", color: "var(--color-fg)" },
    ".cm-search input": { backgroundColor: "var(--color-bg-input)", border: "1px solid var(--color-line)" },
    ".cm-selectionBackground": { backgroundColor: "var(--color-bg-selected-overlay) !important" },
    ".cm-cursor": { borderLeftColor: "var(--color-fg)" },
  },
  { dark: true },
);

export function Pk3TextEditor({
  value,
  onChange,
  readOnly = false,
  ariaLabel,
  className = "",
}: {
  value: string;
  onChange: (text: string) => void;
  /** A text too long to be read whole is shown but not edited. */
  readOnly?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      grammar,
      syntaxHighlighting(colors),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      theme,
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callback.current(update.state.doc.toString());
      }),
    ];
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The document is seeded once; later values arrive through the effect below.
  }, [readOnly, ariaLabel]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  // Escape with the search panel open closes the panel, and the editor has
  // already done that when the key gets here: it is kept from the dialog
  // around the editor, which would otherwise take the same press as its own.
  const keepEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && event.nativeEvent.defaultPrevented) event.stopPropagation();
  };

  return (
    <div ref={host} onKeyDown={keepEscape} className={`min-w-0 overflow-hidden rounded-md border border-line ${className}`} />
  );
}

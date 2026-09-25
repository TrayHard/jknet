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

/**
 * Whether two texts are the same once their line breaks are.
 *
 * CodeMirror splits a document on `\n`, `\r\n` and `\r` alike and gives it
 * back joined with `\n`, so a file written on Windows comes out of the
 * editor with every line break changed before a key is pressed. The editor
 * and the panel around it compare through this, or such a file would count
 * as edited the moment it is shown.
 */
export function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");
}

/**
 * The line break a file keeps through an edit: the one most of its lines end
 * with, `\r\n` or `\n`. The editor holds one line break for the whole text,
 * so a file that mixes them comes back with the majority one throughout and
 * only its few odd lines change, which the game reads the same way.
 */
export function lineBreakOf(text: string): "\r\n" | "\n" {
  const pairs = text.split("\r\n").length - 1;
  const lone = text.split("\n").length - 1 - pairs;
  return pairs > 0 && pairs >= lone ? "\r\n" : "\n";
}

/** A text out of the editor, which joins its lines with `\n`, with its lines joined by `lineBreak`. */
export function withLineBreak(text: string, lineBreak: "\r\n" | "\n"): string {
  return lineBreak === "\n" ? text : text.replace(/\r\n?|\n/g, lineBreak);
}

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
    // A value that differs from the document only in its line breaks is the
    // document already: writing it again would report it as an edit.
    if (editor && !sameText(editor.state.doc.toString(), value)) {
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

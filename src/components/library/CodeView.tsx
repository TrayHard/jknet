import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * --- slice: pk3 contents ---
 * A text file of an archive, read only: line numbers, wrapping, and the
 * one grammar the game's text formats share. A shader, an effect, a menu, a
 * config and a script are all blocks in braces with one directive per line,
 * so the first word of a line is the keyword, a line or block comment is a
 * comment, and what stands in quotes is a string. The same engine as
 * `ConfigCodeEditor`, without its history, completion and lint: nothing
 * here is edited, so the reader gets the search of Ctrl+F and nothing else.
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
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.inBlockComment = true; return "comment"; }
    if (stream.match(/^"[^"\n]*"?/)) return "string";
    if (stream.match("{")) { state.depth += 1; return "brace"; }
    if (stream.match("}")) { state.depth = Math.max(0, state.depth - 1); return "brace"; }
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

export function CodeView({ text, ariaLabel, height = "100%", className = "" }: {
  text: string;
  ariaLabel: string;
  /** A CSS height; the default fills the box the view is put in. */
  height?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          drawSelection(),
          bracketMatching(),
          grammar,
          syntaxHighlighting(colors),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          keymap.of([...defaultKeymap, ...searchKeymap]),
          EditorView.theme(
            {
              "&": { height, color: "var(--color-fg)", backgroundColor: "var(--color-bg-input)" },
              ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "18px" },
              ".cm-gutters": { backgroundColor: "var(--color-bg-elevated)", color: "var(--color-fg-muted)", border: "none" },
              ".cm-content": { padding: "8px 0" },
              ".cm-panels": { backgroundColor: "var(--color-bg-elevated)", color: "var(--color-fg)" },
              ".cm-search input": { backgroundColor: "var(--color-bg-input)", border: "1px solid var(--color-line)" },
              ".cm-selectionBackground": { backgroundColor: "var(--color-bg-selected-overlay) !important" },
            },
            { dark: true },
          ),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [text, ariaLabel, height]);
  return <div ref={host} className={`min-w-0 overflow-hidden rounded-md border border-line ${className}`} />;
}

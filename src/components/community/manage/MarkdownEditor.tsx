import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading2, ImageIcon, Italic, Link2, List, ListOrdered, Redo2, TextQuote, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../lib/format";
import { Button, Dialog, Input } from "../../ui";

/**
 * A picture inside the text, drawn as its caption: the page does not fetch
 * the pictures organizers link either, so the editor does not ask a server
 * nobody chose to reach. The node keeps the picture in the Markdown.
 */
function PictureStub({ node }: NodeViewProps) {
  const { t } = useTranslation("community");
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  return (
    <NodeViewWrapper className="jkc-md-picture" data-drag-handle="">
      <ImageIcon size={14} aria-hidden="true" />
      <span>{t("manage.editor.picture", { name: alt || src })}</span>
    </NodeViewWrapper>
  );
}

const Picture = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PictureStub);
  },
});

/**
 * One button of the toolbar: a 28 px square, as the design's F1 draws it,
 * so the whole toolbar fits one row of a half-width field.
 */
function ToolButton({ icon, label, active = false, disabled, onClick }: { icon: ReactNode; label: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-sm transition-colors select-none pointer-coarse:size-44",
        "disabled:cursor-not-allowed disabled:text-fg-disabled",
        active ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
      )}
      // The press keeps the selection where the organizer left it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/** Whether a link may go into a description: the two web schemes, as the page opens them. */
function isWebLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function LinkDialog({ initial, canRemove, onApply, onRemove, onClose }: { initial: string; canRemove: boolean; onApply: (href: string) => void; onRemove: () => void; onClose: () => void }) {
  const { t } = useTranslation("community");
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const apply = () => {
    const href = value.trim();
    if (!isWebLink(href)) {
      setInvalid(true);
      return;
    }
    onApply(href);
  };
  return (
    <Dialog
      title={t("manage.editor.linkTitle")}
      body={t("manage.editor.linkText")}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" wrap onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {canRemove ? (
            <Button variant="danger" wrap onClick={onRemove}>
              {t("manage.editor.removeLink")}
            </Button>
          ) : null}
          <Button variant="primary" wrap onClick={apply}>
            {t("manage.editor.apply")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 pt-16">
        <Input
          aria-label={t("manage.editor.linkAddress")}
          placeholder={t("manage.editor.linkPlaceholder")}
          value={value}
          invalid={invalid}
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              apply();
            }
          }}
        />
        {invalid ? (
          <span role="alert" className="text-body-sm text-fg-danger">
            {t("manage.editor.linkInvalid")}
          </span>
        ) : null}
      </div>
    </Dialog>
  );
}

interface MarkdownEditorProps {
  /** The text as the form holds it. */
  value: string;
  /** Takes the Markdown after every change the organizer makes. */
  onChange: (markdown: string) => void;
  /** The id of the label that names the text. */
  labelledBy: string;
  /** The ids of the lines under the editor: its note or its problem. */
  describedBy?: string;
  /** What the toolbar is read out as. */
  toolbarLabel: string;
  placeholder: string;
  invalid?: boolean;
}

/**
 * The description or the rules of a community, edited as text and stored as
 * Markdown: TipTap with the Markdown extension, the engine of the bundle
 * descriptions of the launcher (`DescriptionEditor`), with the toolbar of the
 * design's F1 board — a heading, the two marks, the two lists, a quote and
 * a link, then undo and redo.
 *
 * The schema knows more than the toolbar offers: strikethrough, code,
 * tables, task lists and pictures of GitHub's Markdown, which the page draws.
 * A node the schema lacks would be dropped when the text is parsed, and the
 * next save would write the page without it.
 *
 * Parsing and writing the Markdown back may spell the same text differently.
 * The editor remembers how it wrote the text it was given, so the form sees
 * a change only when the organizer made one.
 */
export function MarkdownEditor({ value, onChange, labelledBy, describedBy, toolbarLabel, placeholder, invalid = false }: MarkdownEditorProps) {
  const { t } = useTranslation("community");
  const [linkOpen, setLinkOpen] = useState(false);
  /** The text as the form gave it, and the same text as the editor writes it. */
  const baseline = useRef({ given: value, written: value });
  /** The last text this editor reported, to tell an outside change from its own. */
  const reported = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Underline has no Markdown; a link is applied through the dialog and never followed here.
        underline: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" },
      }),
      Picture.configure({ inline: false, allowBase64: false }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      Markdown,
    ],
    [],
  );

  const attributes = (): Record<string, string> => ({
    class: "jkc-md jkc-md-editor-content",
    role: "textbox",
    "aria-multiline": "true",
    "aria-labelledby": labelledBy,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(invalid ? { "aria-invalid": "true" } : {}),
  });

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    // The website forbids inline <style> by its CSP: the base rules of
    // ProseMirror come from `community.css` instead of a style tag.
    injectCSS: false,
    editorProps: { attributes: attributes() },
    onCreate: ({ editor: created }) => {
      baseline.current = { given: value, written: created.getMarkdown() };
    },
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown();
      const next = markdown === baseline.current.written ? baseline.current.given : markdown;
      reported.current = next;
      onChangeRef.current(next);
    },
  });

  // The label, the note or the problem changed under the editor. The
  // attributes are read from the three values the effect names.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setOptions({ editorProps: { attributes: attributes() } });
  }, [editor, labelledBy, describedBy, invalid]);

  // The form changed the text itself — **Discard**, a reload, a save that
  // came back — and the editor follows without reporting it as an edit.
  useEffect(() => {
    if (!editor || editor.isDestroyed || value === reported.current) return;
    reported.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    baseline.current = { given: value, written: editor.getMarkdown() };
  }, [editor, value]);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current === null
        ? null
        : {
            heading: current.isActive("heading", { level: 2 }),
            bold: current.isActive("bold"),
            italic: current.isActive("italic"),
            bulletList: current.isActive("bulletList"),
            orderedList: current.isActive("orderedList"),
            quote: current.isActive("blockquote"),
            link: current.isActive("link"),
            canUndo: current.can().undo(),
            canRedo: current.can().redo(),
          },
  });

  const busy = editor === null;
  const currentLink = (): string => {
    const href = editor?.getAttributes("link").href;
    return typeof href === "string" ? href : "";
  };
  const applyLink = (href: string) => {
    if (!editor) return;
    setLinkOpen(false);
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
      return;
    }
    chain.extendMarkRange("link").setLink({ href }).run();
  };

  return (
    <>
      <div className="jkc-md-editor" data-invalid={invalid}>
        <div role="toolbar" aria-label={toolbarLabel} className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-4">
          <ToolButton
            icon={<Heading2 size={16} />}
            label={t("manage.editor.heading")}
            active={state?.heading}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          />
          <ToolButton icon={<Bold size={16} />} label={t("manage.editor.bold")} active={state?.bold} disabled={busy} onClick={() => editor?.chain().focus().toggleBold().run()} />
          <ToolButton icon={<Italic size={16} />} label={t("manage.editor.italic")} active={state?.italic} disabled={busy} onClick={() => editor?.chain().focus().toggleItalic().run()} />
          <ToolButton
            icon={<List size={16} />}
            label={t("manage.editor.bulletList")}
            active={state?.bulletList}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          />
          <ToolButton
            icon={<ListOrdered size={16} />}
            label={t("manage.editor.orderedList")}
            active={state?.orderedList}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          />
          <ToolButton
            icon={<TextQuote size={16} />}
            label={t("manage.editor.quote")}
            active={state?.quote}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          />
          <ToolButton icon={<Link2 size={16} />} label={t("manage.editor.link")} active={state?.link} disabled={busy} onClick={() => setLinkOpen(true)} />
          <span className="mx-4 h-16 w-1 bg-line-subtle" aria-hidden="true" />
          <ToolButton icon={<Undo2 size={16} />} label={t("manage.editor.undo")} disabled={busy || state?.canUndo !== true} onClick={() => editor?.chain().focus().undo().run()} />
          <ToolButton icon={<Redo2 size={16} />} label={t("manage.editor.redo")} disabled={busy || state?.canRedo !== true} onClick={() => editor?.chain().focus().redo().run()} />
          <span className="ml-auto px-6 text-mono-xs text-fg-secondary select-none">{t("manage.editor.markdown")}</span>
        </div>
        <EditorContent editor={editor} />
      </div>
      {linkOpen ? (
        <LinkDialog
          initial={currentLink()}
          canRemove={state?.link === true}
          onApply={applyLink}
          onRemove={() => {
            setLinkOpen(false);
            editor?.chain().focus().extendMarkRange("link").unsetLink().run();
          }}
          onClose={() => setLinkOpen(false)}
        />
      ) : null}
    </>
  );
}

import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Extension, type NodeViewProps } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Code,
  Columns3,
  Heading2,
  Heading3,
  ImageOff,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Redo2,
  Rows3,
  Strikethrough,
  Table,
  TextQuote,
  Trash2,
  Undo2,
  Video,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { cn } from "../../../lib/format";
import { blobSha256 } from "../../../lib/ipc";
import { useAddDraftImage, useDraftImagePath } from "../../../lib/queries";
import { isTauri } from "../../../lib/runtime";
import { VIDEO_HOST_NAMES, isSecureLink, isWebLink, videoLink } from "../../../lib/videoLinks";
import { Button, Dialog, Input } from "../../ui";

/** How long after the last keystroke the text goes to the core. */
const COMMIT_MS = 500;

/** The draft the pictures belong to, for the node view of a picture. */
const DraftContext = createContext<{ draftId: string }>({ draftId: "" });

/** The one link a paragraph holds and nothing else, or `null`. */
function paragraphLink(node: ProseMirrorNode): string | null {
  if (node.childCount !== 1) return null;
  const child = node.child(0);
  if (!child.isText) return null;
  const link = child.marks.find((mark) => mark.type.name === "link");
  const href = link?.attrs.href;
  return typeof href === "string" && href !== "" ? href : null;
}

const VIDEO_LINKS = new PluginKey("videoLinks");

/**
 * Marks every paragraph that is one link to a video page, so the editor
 * shows it the way the catalogue will: a block with the host in front of
 * the address. A decoration, not a node: the text stays a paragraph with a
 * link, which is what the Markdown says.
 */
const VideoLinks = Extension.create({
  name: "videoLinks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: VIDEO_LINKS,
        props: {
          decorations(state) {
            const found: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "paragraph") return;
              const href = paragraphLink(node);
              const link = href === null ? null : videoLink(href);
              if (link === null) return;
              found.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: "prose-jknet-video-link",
                  "data-host": VIDEO_HOST_NAMES[link.host],
                }),
              );
            });
            return DecorationSet.create(state.doc, found);
          },
        },
      }),
    ];
  },
});

/**
 * A picture inside the editor.
 *
 * A `blob:` address names a file of the draft, and the node shows that
 * file through the asset protocol; an outside address is drawn as written
 * when it is `https:`, the one scheme the catalogue draws, and as missing
 * otherwise, so the author sees what the player will. The path of a draft
 * picture is read once and kept for as long as the draft is.
 */
function PictureView({ node }: NodeViewProps) {
  const { t } = useTranslation("bundles");
  const { draftId } = useContext(DraftContext);
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const sha256 = blobSha256(src);
  const outside = sha256 === null;
  const path = useDraftImagePath(outside ? null : draftId, sha256);
  const url = outside ? (isSecureLink(src) ? src : null) : path.data === undefined ? null : convertFileSrc(path.data);

  return (
    <NodeViewWrapper className="prose-jknet-image" data-drag-handle="">
      {url !== null ? (
        <img src={url} alt={alt} draggable={false} />
      ) : outside || path.error ? (
        <span className="prose-jknet-picture-missing">
          <ImageOff size={16} aria-hidden />
          <span>{alt || t("description.pictureFailed")}</span>
        </span>
      ) : (
        <span className="prose-jknet-picture-pending" aria-hidden="true" />
      )}
    </NodeViewWrapper>
  );
}

/** The picture node, drawn by `PictureView`. */
const PictureNode = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PictureView);
  },
});

/** One button of the toolbar: an icon, a name, and whether it is pressed. */
function ToolButton({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={icon}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      className={cn("px-6", active && "bg-selected-overlay text-fg-accent")}
      // The press must not take the focus off the text: the command needs
      // the selection where the author left it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    />
  );
}

/** A dialog with one address field: the link and the video share it. */
function AddressDialog({
  title,
  body,
  label,
  initial,
  problem,
  removeLabel,
  onRemove,
  onApply,
  onClose,
}: {
  title: string;
  body: string;
  label: string;
  initial: string;
  /** Answers the reason an address is refused, or `null`. */
  problem: (value: string) => string | null;
  /** The third button, for a link that already exists. */
  removeLabel?: string;
  onRemove?: () => void;
  onApply: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const [value, setValue] = useState(initial);
  const [shown, setShown] = useState<string | null>(null);
  const apply = () => {
    const trimmed = value.trim();
    const found = problem(trimmed);
    setShown(found);
    if (found !== null) return;
    onApply(trimmed);
  };
  return (
    <Dialog
      title={title}
      body={body}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          {removeLabel && onRemove ? (
            <Button variant="danger" onClick={onRemove}>
              {removeLabel}
            </Button>
          ) : null}
          <Button variant="primary" onClick={apply}>
            {tCommon("actions.apply")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pt-16">
        <Input
          aria-label={label}
          placeholder={t("editor.overview.addressPlaceholder")}
          value={value}
          invalid={shown !== null}
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            if (shown !== null) setShown(problem(event.target.value.trim()));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              apply();
            }
          }}
        />
        {shown !== null ? (
          <span role="alert" className="text-body-sm text-fg-danger">
            {shown}
          </span>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The name of a picture file without its extension, for the caption. */
function captionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

interface DescriptionEditorProps {
  draftId: string;
  /** The description as the record holds it. */
  value: string;
  /** The most bytes the description may be, as the service counts them. */
  maxBytes: number;
  /** Accessible name of the text. */
  label: string;
  /**
   * Takes the Markdown after a pause in typing, and when the focus leaves.
   * May answer with the promise of the write: a refusal is what makes the
   * editor send the same text again next time.
   */
  onCommit: (markdown: string) => unknown;
  /**
   * Given a function that writes what is typed down at once, the way a blur
   * does, and answers whether it could: `false` when the text is over the
   * limit and stays in the field with the reason under it. For a section
   * that has to have everything written before it goes on.
   */
  flushRef?: RefObject<(() => boolean) | null>;
}

/** The table the toolbar inserts: a header row and one row under it, three columns; Tab in the last cell adds a row. */
const NEW_TABLE = { rows: 2, cols: 3, withHeaderRow: true };

/** The attributes of the editable element; its accessible name is the label of the field. */
function editorAttributes(label: string): Record<string, string> {
  return { class: "prose-jknet", role: "textbox", "aria-multiline": "true", "aria-label": label };
}

/**
 * --- slice: bundles ---
 *
 * The description of a draft, edited as text and stored as Markdown.
 *
 * TipTap over ProseMirror, with the Markdown extension parsing the record
 * on the way in and serializing the document on the way out. The toolbar
 * offers what the Markdown of a description can say: two headings, the
 * three marks, the three lists, a quote, code, a link, a picture, a video
 * and a table. A picture is a file of the draft — `draft_add_image` copies
 * it and the node points at it as `blob:<sha256>` — and a video is a
 * paragraph holding one link, which the catalogue draws as a player. Tables
 * and task lists are the GFM additions the catalogue draws, and the editor
 * has to know them for the same reason: a node the schema lacks is dropped
 * when the record is parsed, and the next commit would write the record
 * without it. The text goes to the core half a second after the last
 * keystroke and when the focus leaves, the way the config text of a
 * component does.
 */
export function DescriptionEditor({
  draftId,
  value,
  maxBytes,
  label,
  onCommit,
  flushRef: flushOut,
}: DescriptionEditorProps) {
  const { t } = useTranslation("bundles");
  const errorText = useErrorText();
  const addImage = useAddDraftImage(draftId);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What the record holds as far as this editor knows: the value it was given, or the last one it sent. */
  const known = useRef(value);

  // The two strings the extensions read are reached through a ref: the
  // editor is made once per draft, and the language may change under it.
  const placeholder = t("editor.overview.descriptionPlaceholder");
  const textsRef = useRef({ placeholder, t });
  textsRef.current = { placeholder, t };

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Underline has no Markdown; a link is applied through the dialog,
        // never followed inside the editor.
        underline: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" },
      }),
      PictureNode.configure({ inline: false, allowBase64: false }),
      // The columns are not dragged to a width: a Markdown table has none.
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({
        nested: true,
        a11y: {
          checkboxLabel: (node) =>
            node.textContent.trim() === ""
              ? textsRef.current.t("editor.overview.taskEmpty")
              : textsRef.current.t("editor.overview.taskItem", { text: node.textContent }),
        },
      }),
      Placeholder.configure({ placeholder: () => textsRef.current.placeholder }),
      Markdown,
      VideoLinks,
    ],
    [],
  );

  // The two callbacks the editor is created with call through refs, so the
  // instance made on the first render always reaches the newest closure.
  const flushRef = useRef<() => boolean>(() => true);
  const scheduleRef = useRef<() => void>(() => undefined);

  const editor = useEditor(
    {
      extensions,
      content: value,
      contentType: "markdown",
      editorProps: { attributes: editorAttributes(label) },
      onUpdate: () => scheduleRef.current(),
      onBlur: () => flushRef.current(),
    },
    [draftId],
  );

  // The language changed under the editor: the accessible name is written
  // again, and an empty transaction has the placeholder decoration rebuilt
  // from the ref. Nothing in the document changes, so no commit follows.
  const shown = useRef({ placeholder, label });
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (shown.current.placeholder === placeholder && shown.current.label === label) return;
    shown.current = { placeholder, label };
    editor.setOptions({ editorProps: { attributes: editorAttributes(label) } });
    editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder, label]);

  const flush = (): boolean => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!editor || editor.isDestroyed) return true;
    const markdown = editor.getMarkdown().trim();
    const found = new TextEncoder().encode(markdown).length > maxBytes ? t("editor.overview.invalid.description") : null;
    setProblem(found);
    if (found !== null) return false;
    if (markdown === known.current) return true;
    const held = known.current;
    known.current = markdown;
    // A refusal leaves the record as it was, and the editor knows it again:
    // the next flush sends the text once more rather than passing it over.
    void Promise.resolve(onCommit(markdown)).catch(() => {
      if (known.current === markdown) known.current = held;
    });
    return true;
  };
  flushRef.current = flush;
  scheduleRef.current = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), COMMIT_MS);
  };
  // The section above reaches the same flush through the ref it gave, and
  // the ref is emptied when the editor goes: a flush of a gone editor is a
  // flush of nothing.
  useEffect(() => {
    if (!flushOut) return;
    flushOut.current = () => flushRef.current();
    return () => {
      flushOut.current = null;
    };
  }, [flushOut]);

  // The record changed under the editor — another section answered, or the
  // draft was re-read — and the text follows it, unless the change is the
  // answer to what this editor sent, or a commit is on its way.
  useEffect(() => {
    if (!editor || value === known.current || timer.current !== null) return;
    known.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  // What is typed and not yet sent goes out when the section is left.
  useEffect(
    () => () => {
      if (timer.current !== null) flushRef.current();
    },
    [],
  );

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current === null
        ? null
        : {
            h2: current.isActive("heading", { level: 2 }),
            h3: current.isActive("heading", { level: 3 }),
            bold: current.isActive("bold"),
            italic: current.isActive("italic"),
            strike: current.isActive("strike"),
            bulletList: current.isActive("bulletList"),
            orderedList: current.isActive("orderedList"),
            taskList: current.isActive("taskList"),
            blockquote: current.isActive("blockquote"),
            code: current.isActive("code"),
            link: current.isActive("link"),
            table: current.isActive("table"),
            canUndo: current.can().undo(),
            canRedo: current.can().redo(),
          },
  });

  const currentLink = (): string => {
    const href = editor?.getAttributes("link").href;
    return typeof href === "string" ? href : "";
  };

  const applyLink = (href: string) => {
    if (!editor) return;
    setLinkOpen(false);
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive("link")) {
      // Nothing selected: the address is the text of the link.
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
      return;
    }
    chain.extendMarkRange("link").setLink({ href }).run();
  };

  const removeLink = () => {
    setLinkOpen(false);
    editor?.chain().focus().extendMarkRange("link").unsetLink().run();
  };

  const applyVideo = (href: string) => {
    if (!editor) return;
    setVideoOpen(false);
    // Its own paragraph with one link: the shape the catalogue draws as a block.
    editor
      .chain()
      .focus()
      .insertContent({
        type: "paragraph",
        content: [{ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }],
      })
      .run();
  };

  const pickImage = async () => {
    if (!editor || !isTauri()) return;
    setFailure(null);
    try {
      const picked = await open({
        multiple: false,
        title: t("editor.overview.imageTitle"),
        filters: [{ name: t("editor.overview.imageFilter"), extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      if (typeof picked !== "string") return;
      const image = await addImage.mutateAsync(picked);
      editor
        .chain()
        .focus()
        .setImage({ src: `blob:${image.sha256}`, alt: captionOf(image.fileName) })
        .run();
    } catch (e) {
      setFailure(errorText(e));
    }
  };

  const busy = editor === null || addImage.isPending;

  return (
    <DraftContext.Provider value={{ draftId }}>
      <div className="prose-jknet-editor" data-invalid={problem !== null}>
        <div
          role="toolbar"
          aria-label={t("editor.overview.toolbar")}
          className="flex flex-wrap items-center gap-2 px-6 py-4 border-b border-line-subtle"
        >
          <ToolButton
            icon={<Heading2 size={16} />}
            label={t("editor.overview.tool.heading2")}
            active={state?.h2}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          />
          <ToolButton
            icon={<Heading3 size={16} />}
            label={t("editor.overview.tool.heading3")}
            active={state?.h3}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          />
          <span className="w-1 h-16 mx-4 bg-line-subtle" aria-hidden="true" />
          <ToolButton
            icon={<Bold size={16} />}
            label={t("editor.overview.tool.bold")}
            active={state?.bold}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          />
          <ToolButton
            icon={<Italic size={16} />}
            label={t("editor.overview.tool.italic")}
            active={state?.italic}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          />
          <ToolButton
            icon={<Strikethrough size={16} />}
            label={t("editor.overview.tool.strike")}
            active={state?.strike}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
          />
          <ToolButton
            icon={<Code size={16} />}
            label={t("editor.overview.tool.code")}
            active={state?.code}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleCode().run()}
          />
          <span className="w-1 h-16 mx-4 bg-line-subtle" aria-hidden="true" />
          <ToolButton
            icon={<List size={16} />}
            label={t("editor.overview.tool.bulletList")}
            active={state?.bulletList}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          />
          <ToolButton
            icon={<ListOrdered size={16} />}
            label={t("editor.overview.tool.orderedList")}
            active={state?.orderedList}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          />
          <ToolButton
            icon={<ListTodo size={16} />}
            label={t("editor.overview.tool.taskList")}
            active={state?.taskList}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
          />
          <ToolButton
            icon={<TextQuote size={16} />}
            label={t("editor.overview.tool.blockquote")}
            active={state?.blockquote}
            disabled={busy}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          />
          <span className="w-1 h-16 mx-4 bg-line-subtle" aria-hidden="true" />
          <ToolButton
            icon={<Link2 size={16} />}
            label={t("editor.overview.tool.link")}
            active={state?.link}
            disabled={busy}
            onClick={() => setLinkOpen(true)}
          />
          <ToolButton
            icon={<ImagePlus size={16} />}
            label={t("editor.overview.tool.image")}
            disabled={busy || !isTauri()}
            onClick={() => void pickImage()}
          />
          <ToolButton
            icon={<Video size={16} />}
            label={t("editor.overview.tool.video")}
            disabled={busy}
            onClick={() => setVideoOpen(true)}
          />
          <ToolButton
            icon={<Table size={16} />}
            label={t("editor.overview.tool.table")}
            active={state?.table}
            disabled={busy || state?.table === true}
            onClick={() => editor?.chain().focus().insertTable(NEW_TABLE).run()}
          />
          {state?.table ? (
            // The rows and columns of the table the cursor is in: shown
            // there and nowhere else, so the toolbar stays short.
            <>
              <span className="w-1 h-16 mx-4 bg-line-subtle" aria-hidden="true" />
              <ToolButton
                icon={<BetweenHorizontalEnd size={16} />}
                label={t("editor.overview.tool.addRow")}
                disabled={busy}
                onClick={() => editor?.chain().focus().addRowAfter().run()}
              />
              <ToolButton
                icon={<BetweenVerticalEnd size={16} />}
                label={t("editor.overview.tool.addColumn")}
                disabled={busy}
                onClick={() => editor?.chain().focus().addColumnAfter().run()}
              />
              <ToolButton
                icon={<Rows3 size={16} className="text-fg-danger" />}
                label={t("editor.overview.tool.deleteRow")}
                disabled={busy}
                onClick={() => editor?.chain().focus().deleteRow().run()}
              />
              <ToolButton
                icon={<Columns3 size={16} className="text-fg-danger" />}
                label={t("editor.overview.tool.deleteColumn")}
                disabled={busy}
                onClick={() => editor?.chain().focus().deleteColumn().run()}
              />
              <ToolButton
                icon={<Trash2 size={16} className="text-fg-danger" />}
                label={t("editor.overview.tool.deleteTable")}
                disabled={busy}
                onClick={() => editor?.chain().focus().deleteTable().run()}
              />
            </>
          ) : null}
          <span className="flex-1" />
          <ToolButton
            icon={<Undo2 size={16} />}
            label={t("editor.overview.tool.undo")}
            disabled={busy || state?.canUndo !== true}
            onClick={() => editor?.chain().focus().undo().run()}
          />
          <ToolButton
            icon={<Redo2 size={16} />}
            label={t("editor.overview.tool.redo")}
            disabled={busy || state?.canRedo !== true}
            onClick={() => editor?.chain().focus().redo().run()}
          />
        </div>
        <EditorContent editor={editor} />
      </div>

      {problem !== null ? (
        <span role="alert" className="text-body-sm text-fg-danger">
          {problem}
        </span>
      ) : null}
      {failure !== null ? (
        <span role="alert" className="text-body-sm text-fg-danger">
          {t("editor.overview.imageFailed", { reason: failure })}
        </span>
      ) : null}

      {linkOpen ? (
        <AddressDialog
          title={t("editor.overview.linkTitle")}
          body={t("editor.overview.linkText")}
          label={t("editor.overview.linkAddress")}
          initial={currentLink()}
          problem={(address) => (isWebLink(address) ? null : t("editor.overview.invalid.link"))}
          removeLabel={state?.link ? t("editor.overview.removeLink") : undefined}
          onRemove={state?.link ? removeLink : undefined}
          onApply={applyLink}
          onClose={() => setLinkOpen(false)}
        />
      ) : null}

      {videoOpen ? (
        <AddressDialog
          title={t("editor.overview.videoTitle")}
          body={t("editor.overview.videoText")}
          label={t("editor.overview.videoAddress")}
          initial=""
          problem={(address) => (videoLink(address) !== null ? null : t("editor.overview.invalid.video"))}
          onApply={applyVideo}
          onClose={() => setVideoOpen(false)}
        />
      ) : null}
    </DraftContext.Provider>
  );
}

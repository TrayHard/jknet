import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Element, ElementContent } from "hast";
import { ExternalLink, ImageOff, Play } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

import { cn } from "../../lib/format";
import { blobSha256, blobUrl } from "../../lib/ipc";
import { useDraftImagePath, useOnlineUrl } from "../../lib/queries";
import { isTauri } from "../../lib/runtime";
import {
  VIDEO_HOST_NAMES,
  isWebLink,
  videoLink,
  youtubeEmbed,
  youtubeThumbnail,
  type VideoLink,
} from "../../lib/videoLinks";
import { Button, Dialog } from "../ui";
import { useEscapeFirst } from "./bundleFiles";

/**
 * Where the `blob:` pictures of a description are read from.
 *
 * In the catalogue a picture is a file of the store, served at
 * `<service>/v1/blobs/<sha256>`. In the editor the same address names a
 * file of the draft, which is shown through the asset protocol before it
 * is uploaded anywhere.
 */
export type ImageSource = { kind: "online" } | { kind: "draft"; draftId: string };

/** What the elements of the tree share: where pictures come from, and the way to enlarge one. */
interface MarkdownContextValue {
  images: ImageSource;
  zoom: (picture: { src: string; alt: string }) => void;
}

const MarkdownContext = createContext<MarkdownContextValue>({
  images: { kind: "online" },
  zoom: () => undefined,
});

/**
 * The sanitizer's rules: GitHub's, with pictures allowed to come from the
 * store (`blob:`) or over `https:` alone, and links held to the two web
 * schemes. A picture fetched over plain `http:` could be swapped on the
 * way, so its address is dropped and it draws as missing. Raw HTML never
 * reaches this step — it stays text — so the schema is the second net.
 */
const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https"],
    src: ["https", "blob"],
  },
};

/** A `blob:` picture address is kept as it is, for `Picture` to resolve; every other address goes through the default check. */
function keepBlobs(url: string, key: string): string {
  return key === "src" && blobSha256(url) !== null ? url : defaultUrlTransform(url);
}

/** The one link inside a paragraph that holds nothing else, or `null`. */
function soleLink(node: Element | undefined): string | null {
  if (!node || node.children.length !== 1) return null;
  const child: ElementContent = node.children[0];
  if (child.type !== "element" || child.tagName !== "a") return null;
  const href = child.properties.href;
  if (typeof href !== "string" || href === "") return null;
  // The text of the link is the address, or a title the author gave it: a
  // block either way. A link that wraps a picture is not a video.
  return child.children.every((grandchild) => grandchild.type === "text") ? href : null;
}

/** Opens a link in the system browser inside Tauri; a plain browser follows the anchor. */
function openLink(event: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
  if (!isTauri()) return;
  event.preventDefault();
  if (href === undefined || !isWebLink(href)) return;
  void openUrl(href).catch(() => undefined);
}

/** A paragraph, or the block of a video when the paragraph is one link to a video page. */
function Paragraph({ node, children, ...rest }: HTMLAttributes<HTMLParagraphElement> & ExtraProps) {
  const href = soleLink(node);
  const link = href === null ? null : videoLink(href);
  if (link !== null) return <VideoBlock link={link} />;
  return <p {...rest}>{children}</p>;
}

/** A link that leaves the launcher. */
function Anchor({ node: _node, href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer" onClick={(event) => openLink(event, href)}>
      {children}
    </a>
  );
}

/**
 * The address a picture is drawn from.
 *
 * A `blob:` address resolves through the source of the view: the store of
 * the service, or the folder of the draft through the asset protocol. Any
 * other address is drawn as written. `undefined` while the path of a draft
 * picture is being read, `null` when it cannot be.
 */
function usePictureUrl(src: string | undefined): string | null | undefined {
  const { images } = useContext(MarkdownContext);
  const onlineUrl = useOnlineUrl();
  const sha256 = src === undefined ? null : blobSha256(src);
  const path = useDraftImagePath(
    images.kind === "draft" && sha256 !== null ? images.draftId : null,
    images.kind === "draft" ? sha256 : null,
  );
  if (src === undefined || src === "") return null;
  if (sha256 === null) return src;
  if (images.kind === "online") return onlineUrl === "" ? null : blobUrl(onlineUrl, sha256);
  if (path.data !== undefined) return convertFileSrc(path.data);
  return path.error ? null : undefined;
}

/** A picture: shown no wider than the text, enlarged by a click. */
function Picture({ node: _node, src, alt, ...rest }: ImgHTMLAttributes<HTMLImageElement> & ExtraProps) {
  const { t } = useTranslation("bundles");
  const { zoom } = useContext(MarkdownContext);
  const [failed, setFailed] = useState(false);
  const url = usePictureUrl(typeof src === "string" ? src : undefined);
  const label = alt ?? "";

  if (url === null || failed) {
    return (
      <span className="prose-jknet-picture-missing" role="img" aria-label={label || t("description.pictureFailed")}>
        <ImageOff size={16} aria-hidden />
        <span>{label || t("description.pictureFailed")}</span>
      </span>
    );
  }
  if (url === undefined) {
    return <span className="prose-jknet-picture-pending" aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      className="prose-jknet-picture"
      title={t("description.openPicture")}
      onClick={() => zoom({ src: url, alt: label })}
    >
      <img {...rest} src={url} alt={label} loading="lazy" onError={() => setFailed(true)} />
    </button>
  );
}

/**
 * The block of a video link.
 *
 * YouTube: the still of the video with a play button, and the player of the
 * cookieless domain only after the click — the dialog opens fast and nothing
 * plays over the game until the player is asked for. Twitch and VK Video:
 * a card with the name of the host; the click opens the page in the browser,
 * because their players need the domain of the parent page.
 */
function VideoBlock({ link }: { link: VideoLink }) {
  const { t } = useTranslation("bundles");
  const [playing, setPlaying] = useState(false);
  const hostName = VIDEO_HOST_NAMES[link.host];

  if (link.host === "youtube" && link.id !== null) {
    return (
      <div className="prose-jknet-video">
        {playing ? (
          <iframe
            src={youtubeEmbed(link.id)}
            title={t("description.videoOn", { host: hostName })}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            className="prose-jknet-video-still"
            aria-label={t("description.play")}
            title={t("description.play")}
            onClick={() => setPlaying(true)}
          >
            <img src={youtubeThumbnail(link.id)} alt="" loading="lazy" />
            <span className="prose-jknet-video-play" aria-hidden="true">
              <Play size={24} fill="currentColor" />
            </span>
          </button>
        )}
      </div>
    );
  }

  return (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer"
      className="prose-jknet-video-card"
      title={t("description.watchOn", { host: hostName })}
      onClick={(event) => openLink(event, link.href)}
    >
      <span className="prose-jknet-video-card-icon" aria-hidden="true">
        <Play size={16} fill="currentColor" />
      </span>
      <span className="prose-jknet-video-card-text">
        <span className="prose-jknet-video-card-host">{t("description.watchOn", { host: hostName })}</span>
        <span className="prose-jknet-video-card-address">{link.href}</span>
      </span>
      <ExternalLink size={14} aria-hidden />
    </a>
  );
}

/** The plugins, made once: a new array per render would re-create the processor. */
const REMARK_PLUGINS: PluggableList = [remarkGfm];
const REHYPE_PLUGINS: PluggableList = [[rehypeSanitize, SCHEMA]];

/** A picture at full size, over the record it was in; Escape closes the picture alone. */
function ZoomDialog({ picture, onClose }: { picture: { src: string; alt: string }; onClose: () => void }) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  useEscapeFirst(onClose);
  return (
    <Dialog
      title={picture.alt || t("description.pictureTitle")}
      wide="preview"
      onClose={onClose}
      actions={<Button onClick={onClose}>{tCommon("actions.close")}</Button>}
    >
      <div className="flex items-center justify-center pt-16">
        <img src={picture.src} alt={picture.alt} className="max-w-full max-h-[calc(100dvh-220px)] object-contain rounded-md" />
      </div>
    </Dialog>
  );
}

/** The elements the view draws itself; the rest are the tags of the sanitized tree. */
const COMPONENTS: Components = {
  p: Paragraph,
  a: Anchor,
  img: Picture,
};

interface MarkdownViewProps {
  /** The description as the author wrote it. */
  markdown: string;
  /** Where `blob:` pictures are read from. The store of the service unless said otherwise. */
  images?: ImageSource;
  /** What to draw for an empty description; nothing by default. */
  empty?: ReactNode;
  className?: string;
}

/**
 * --- slice: bundles ---
 *
 * The description of a bundle, drawn from its Markdown.
 *
 * CommonMark with the GFM additions — tables, strikethrough, task lists —
 * through `react-markdown`; raw HTML inside the text is printed as text, and
 * the tree is sanitized after that as a second net. Three elements are the
 * view's own: a link leaves the launcher through the opener, a picture is
 * held to the width of the text and enlarged by a click, and a paragraph
 * that is one link to a video page becomes the block of that video. One
 * component for the record in the catalogue, the **Preview** section of the
 * editor and the review queue, so the author sees what the player will.
 */
export function MarkdownView({ markdown, images = { kind: "online" }, empty = null, className }: MarkdownViewProps) {
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const context = useMemo<MarkdownContextValue>(() => ({ images, zoom: setZoomed }), [images]);

  if (markdown.trim() === "") return <>{empty}</>;

  return (
    <MarkdownContext.Provider value={context}>
      <div className={cn("prose-jknet", className)}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          urlTransform={keepBlobs}
          components={COMPONENTS}
        >
          {markdown}
        </Markdown>
      </div>
      {zoomed ? <ZoomDialog picture={zoomed} onClose={() => setZoomed(null)} /> : null}
    </MarkdownContext.Provider>
  );
}

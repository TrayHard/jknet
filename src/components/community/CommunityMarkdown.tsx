import type { AnchorHTMLAttributes, ImgHTMLAttributes, MouseEvent } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

import { cn } from "../../lib/format";
import { isHttps } from "./format";
import { useCommunityPlatform } from "./platform";

/**
 * The sanitizer's rules: GitHub's, with links held to the two web schemes.
 * Raw HTML never gets this far — `react-markdown` keeps it as text — so the
 * schema is the second net, as in `MarkdownView` of the bundles.
 */
const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https"],
    src: ["https"],
  },
};

const PLUGINS: PluggableList = [remarkGfm];
const REHYPE: PluggableList = [[rehypeSanitize, SCHEMA]];

/**
 * A description or the rules of a community: Markdown the organizers wrote,
 * with `react-markdown`, `remark-gfm` and `rehype-sanitize` as the bundles'
 * `MarkdownView` draws theirs.
 *
 * A link opens outside, through the host: the system browser of the
 * launcher, a new tab of a browser. A picture is not fetched: the reader of
 * a page has not asked to reach whatever server an organizer linked, so it
 * shows as a link to itself under its caption.
 */
export function CommunityMarkdown({ text, className }: { text: string; className?: string }) {
  const { openExternal } = useCommunityPlatform();

  const components: Components = {
    a: ({ node: _node, href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) => (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noopener noreferrer ugc"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          if (href && /^https?:\/\//i.test(href)) openExternal(href);
        }}
      >
        {children}
      </a>
    ),
    img: ({ node: _node, src, alt }: ImgHTMLAttributes<HTMLImageElement> & ExtraProps) => {
      const url = typeof src === "string" ? src : "";
      if (!isHttps(url)) return <span>{alt}</span>;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer ugc"
          onClick={(event) => {
            event.preventDefault();
            openExternal(url);
          }}
        >
          {alt || url}
        </a>
      );
    },
  };

  return (
    <div className={cn("jkc-md", className)}>
      <Markdown remarkPlugins={PLUGINS} rehypePlugins={REHYPE} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

import { AlertTriangle, ImageOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import type { FilePreviewEntry, FilePreviewSource } from "../../lib/ipc";
import { stem } from "../../lib/previewKinds";
import { useFilePreviewImage, useFilePreviewText } from "../../lib/queries";
import { parseStringsFile } from "../../lib/stringsFile";
import { Button } from "../ui";
import { CodeView } from "./CodeView";
import { LibraryObjectIcon } from "./LibraryObjectIcon";

/**
 * --- slice: pk3 contents ---
 * The objects of an archive that are read rather than drawn: a text file
 * with line numbers, a string package as a table, a font with its atlas,
 * and the files the launcher only names — a video it cannot decode, a file
 * the game does not read.
 */

/** The heading of every view here: the label, the path, and a line of facts. */
function Heading({ entry, facts, warning }: { entry: FilePreviewEntry; facts: string[]; warning?: string | null }) {
  return <div className="flex flex-col gap-4 shrink-0">
    <p className="text-body-md-medium text-fg break-words">{entry.label}</p>
    <p className="text-mono-xs text-fg-muted break-all">{entry.name}</p>
    {facts.length > 0 ? <p className="text-body-sm text-fg-secondary">{facts.join(" · ")}</p> : null}
    {warning ? <p role="status" className="flex items-start gap-6 text-body-sm text-fg-warm"><AlertTriangle size={14} className="shrink-0 mt-2" aria-hidden="true" />{warning}</p> : null}
  </div>;
}

/** What a text query shows before its text: the wait, or the refusal with a retry. */
function TextState({ query }: { query: ReturnType<typeof useFilePreviewText> }) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const errorText = useErrorText();
  if (query.error) return <div role="alert" className="flex flex-col items-start gap-12 p-12">
    <p className="text-body-sm text-fg-danger">{errorText(query.error)}</p>
    <Button onClick={() => void query.refetch()}>{common("actions.tryAgain")}</Button>
  </div>;
  return <p role="status" className="p-12 text-body-sm text-fg-muted">{t("preview.loading")}</p>;
}

/** The primitives of an effect file: every block that opens at the top level. */
const EFFECT_PRIMITIVES = /^\s*(?:particle|line|tail|sound|cylinder|electricity|emitter|decal|orientedparticle|fxrunner|light|camerashake|flash)\b/gim;

/** How many blocks open at the top level: the shaders of a shader file, the entries of a data file. */
function topLevelBlocks(text: string): number {
  let depth = 0, count = 0, at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "/" && text[at + 1] === "/") { at = text.indexOf("\n", at); if (at < 0) break; continue; }
    if (char === "/" && text[at + 1] === "*") { const end = text.indexOf("*/", at + 2); at = end < 0 ? text.length : end + 2; continue; }
    if (char === '"') { const end = text.indexOf('"', at + 1); at = end < 0 ? text.length : end + 1; continue; }
    if (char === "{") { if (depth === 0) count += 1; depth += 1; }
    else if (char === "}") depth = Math.max(0, depth - 1);
    at += 1;
  }
  return count;
}

/** A shader, an effect, a menu, a config, a data file or a script source: the text with line numbers. */
export function TextView({ source, entry }: { source: FilePreviewSource; entry: FilePreviewEntry }) {
  const { t } = useTranslation("library");
  const format = useFormat();
  const query = useFilePreviewText(source, entry.name);
  const text = query.data?.text;
  const summary = useMemo(() => {
    if (text === undefined) return null;
    if (entry.kind === "menu") return t("preview.text.items", { count: (text.match(/\bitemDef\b/gi) ?? []).length });
    if (entry.kind === "effect") return t("preview.text.primitives", { count: (text.match(EFFECT_PRIMITIVES) ?? []).length });
    if (entry.kind === "shader") return t("preview.text.shaders", { count: topLevelBlocks(text) });
    return null;
  }, [text, entry.kind, t]);
  const facts = [
    query.data ? t("preview.text.lines", { count: query.data.text.split("\n").length }) : entry.text ? t("preview.text.lines", { count: entry.text.lines }) : null,
    query.data?.encoding ?? entry.text?.encoding ?? null,
    entry.size != null ? format.bytes(entry.size) : null,
    summary,
  ].filter((fact): fact is string => fact !== null && fact !== "");
  return <div className="h-full flex flex-col gap-12">
    <Heading entry={entry} facts={facts} warning={query.data?.truncated ? t("preview.text.truncated") : null} />
    {query.data ? <CodeView text={query.data.text} ariaLabel={entry.label} className="flex-1 min-h-0" /> : <TextState query={query} />}
  </div>;
}

/**
 * A `strings/<language>/<package>.str` file: the keys with the text of every
 * language the file names, or the file as it is. The table is read from the
 * text the core decoded by the code page of the folder.
 */
export function StringsView({ source, entry }: { source: FilePreviewSource; entry: FilePreviewEntry }) {
  const { t } = useTranslation("library");
  const format = useFormat();
  const query = useFilePreviewText(source, entry.name);
  const [view, setView] = useState<"table" | "text">("table");
  const parsed = useMemo(() => query.data ? parseStringsFile(query.data.text) : null, [query.data]);
  const folder = entry.strings?.language.toLowerCase() ?? "";
  // A folder of a translation: `english` holds the originals, and `strip` of Jedi Outcast is a format, not a language.
  const translation = parsed !== null && folder !== "" && folder !== "english" && folder !== "strip";
  // The game refuses a file that names a language other than its folder's (`stringed_ingame.cpp:706-718`),
  // and shows the English text of a file that has no `LANG_<FOLDER>` line at all (`:789-825`).
  const strangers = translation ? parsed.languages.filter(language => language !== "english" && language !== folder) : [];
  const mismatch = strangers.length > 0;
  const missing = translation && !mismatch && parsed.entries.length > 0 && !parsed.languages.includes(folder);
  const facts = [
    entry.strings ? t("preview.strings.package", { language: entry.strings.language, name: entry.strings.package }) : null,
    t("preview.strings.keys", { count: parsed?.entries.length ?? entry.strings?.keys ?? 0 }),
    query.data?.encoding ?? entry.text?.encoding ?? null,
    entry.size != null ? format.bytes(entry.size) : null,
  ].filter((fact): fact is string => fact !== null);
  const warning = query.data?.truncated ? t("preview.text.truncated")
    : mismatch ? t("preview.strings.languageMismatch", {
      folder: entry.strings?.language ?? folder,
      found: strangers.map(language => `LANG_${language.toUpperCase()}`).join(", "),
    })
    : missing ? t("preview.strings.languageMissing", {
      folder: entry.strings?.language ?? folder,
      language: folder.toUpperCase(),
    })
    : parsed !== null && !parsed.complete ? t("preview.strings.noEndMarker") : null;
  return <div className="h-full flex flex-col gap-12">
    <Heading entry={entry} facts={facts} warning={warning} />
    <div className="flex flex-wrap gap-8 shrink-0">
      <Button size="sm" variant={view === "table" ? "primary" : "ghost"} onClick={() => setView("table")}>{t("preview.strings.asTable")}</Button>
      <Button size="sm" variant={view === "text" ? "primary" : "ghost"} onClick={() => setView("text")}>{t("preview.strings.asText")}</Button>
    </div>
    {!query.data || !parsed ? <TextState query={query} />
      : view === "text" ? <CodeView text={query.data.text} ariaLabel={entry.label} className="flex-1 min-h-0" />
      : parsed.entries.length === 0 ? <p className="text-body-sm text-fg-muted">{t("preview.strings.empty")}</p>
      : <div className="flex-1 min-h-0 overflow-auto rounded-md border border-line">
        <table className="w-full border-collapse text-body-sm">
          <thead className="sticky top-0 bg-elevated text-label-xs text-fg-muted">
            <tr>
              <th scope="col" className="text-left px-8 py-6 border-b border-line">{t("preview.strings.key")}</th>
              {parsed.languages.map(language => <th key={language} scope="col" className="text-left px-8 py-6 border-b border-line normal-case tracking-normal text-mono-xs">{language}</th>)}
            </tr>
          </thead>
          <tbody>
            {parsed.entries.map((row, index) => <tr key={`${row.key}-${index}`} className="align-top border-b border-line-subtle last:border-b-0">
              <td className="px-8 py-4 text-mono-xs text-fg-secondary whitespace-nowrap" title={row.notes ?? undefined}>{row.key}</td>
              {parsed.languages.map(language => <td key={language} className="px-8 py-4 text-fg whitespace-pre-wrap break-words">{row.values[language] ?? ""}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>}
  </div>;
}

/** A `.fontdat` with its atlas: the picture of the glyphs, the point size and the line height. */
export function FontView({ source, entry }: { source: FilePreviewSource; entry: FilePreviewEntry }) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const format = useFormat();
  const errorText = useErrorText();
  const atlas = entry.font?.atlas ?? null;
  const image = useFilePreviewImage(source, atlas ?? "", undefined, atlas !== null);
  const name = stem(entry.name).toLowerCase();
  const facts = [
    entry.font ? t("preview.font.pointSize", { value: entry.font.pointSize }) : null,
    entry.font ? t("preview.font.height", { value: entry.font.height }) : null,
    image.data ? `${image.data.width}×${image.data.height}` : null,
    entry.size != null ? format.bytes(entry.size) : null,
  ].filter((fact): fact is string => fact !== null);
  return <div className="h-full flex flex-col gap-12">
    <Heading entry={entry} facts={facts} warning={name === "russian" || name === "polish" ? t("preview.font.overridesFallback", { name }) : null} />
    {atlas ? <p className="text-body-sm text-fg-secondary break-all">{t("preview.font.atlasPath")} <span className="text-mono-xs text-fg-muted">{atlas}</span></p>
      : <p className="text-body-sm text-fg-muted">{t("preview.font.noAtlas")}</p>}
    {atlas ? <div className="flex-1 min-h-0 flex items-start justify-center overflow-auto rounded-md border border-line bg-elevated p-12">
      {image.data ? <img src={image.data.dataUrl} alt={t("preview.font.atlas", { name: entry.label })} decoding="async" className="max-w-full object-contain" />
        : (image.error ? <div role="alert" className="flex flex-col items-start gap-12">
          <p className="text-body-sm text-fg-danger">{errorText(image.error)}</p>
          <Button onClick={() => void image.refetch()}>{common("actions.tryAgain")}</Button>
        </div> : (image.isPending ? <p role="status" className="text-body-sm text-fg-muted">{t("preview.loading")}</p>
          : <ImageOff size={24} className="text-fg-muted" aria-hidden="true" />))}
    </div> : null}
  </div>;
}

/** A file the launcher names and weighs but does not open: a RoQ video, or a file the game does not read. */
export function PlainView({ entry }: { entry: FilePreviewEntry }) {
  const { t } = useTranslation("library");
  const format = useFormat();
  return <div className="h-full flex flex-col items-center justify-center gap-12 px-24 text-center">
    <LibraryObjectIcon kind={entry.kind} size={48} className="text-fg-accent" />
    <p className="text-heading-md break-words">{entry.label}</p>
    <p className="text-mono-xs text-fg-muted break-all">{entry.name}</p>
    {entry.size != null ? <p className="text-body-sm text-fg-secondary">{format.bytes(entry.size)}</p> : null}
    {entry.kind === "video" ? <p className="text-body-sm text-fg-muted">{t("preview.video.noPlayback")}</p> : null}
  </div>;
}

import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { FALLBACK_LANGUAGE, isLanguage, type Language } from "../../i18n/languages";
import { fold } from "../../lib/chat/conversation";
import { cn } from "../../lib/format";
import { Input } from "../ui";
import { COMPONENT_GROUP, loadEmojiData, type EmojiData, type EmojiEntry } from "./emojiData";

export interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  /** Emoji the picker offers first. */
  recent?: string[];
}

/** How many emoji the search shows at most: past that the words are too short to help. */
const SEARCH_LIMIT = 120;

/**
 * --- slice: chat ---
 *
 * The emoji picker of the composer and of the reactions: a search field, the
 * groups of Unicode as tabs, and the grid.
 *
 * A chunk of its own, loaded the first time it opens, with the emoji names of
 * the language on screen: the search finds «огонь» in Russian and «Feuer» in
 * German. Skin tones are left to the default yellow, which keeps the grid
 * one emoji per cell.
 */
export default function EmojiPicker({ onPick, recent = [] }: EmojiPickerProps) {
  const { t, i18n } = useTranslation("chat");
  const language: Language = isLanguage(i18n.language) ? i18n.language : FALLBACK_LANGUAGE;
  const [data, setData] = useState<EmojiData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<number | "recent">(recent.length > 0 ? "recent" : 0);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setFailed(false);
    loadEmojiData(language)
      .then((loaded) => {
        if (live) setData(loaded);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [language]);

  useEffect(() => field.current?.focus(), []);

  const groups = useMemo(
    () =>
      (data?.groups ?? [])
        .filter((entry) => entry.order !== COMPONENT_GROUP)
        .sort((a, b) => a.order - b.order),
    [data],
  );

  const byGroup = useMemo(() => {
    const map = new Map<number, EmojiEntry[]>();
    for (const emoji of data?.emojis ?? []) {
      if (emoji.group === undefined || emoji.group === COMPONENT_GROUP) continue;
      const list = map.get(emoji.group) ?? [];
      list.push(emoji);
      map.set(emoji.group, list);
    }
    for (const list of map.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return map;
  }, [data]);

  const shown = useMemo(() => {
    const needle = fold(query.trim());
    if (needle !== "") {
      const out: EmojiEntry[] = [];
      for (const emoji of data?.emojis ?? []) {
        if (emoji.group === COMPONENT_GROUP) continue;
        const words = [emoji.label, ...(emoji.tags ?? [])];
        if (words.some((word) => fold(word).includes(needle))) out.push(emoji);
        if (out.length >= SEARCH_LIMIT) break;
      }
      return out.map((emoji) => emoji.unicode);
    }
    if (group === "recent") return recent;
    return (byGroup.get(group) ?? []).map((emoji) => emoji.unicode);
  }, [query, data, group, recent, byGroup]);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const emoji of data?.emojis ?? []) map.set(emoji.unicode, emoji.label);
    return map;
  }, [data]);

  return (
    <div className="flex w-[320px] flex-col gap-8 rounded-lg border border-line-strong bg-elevated p-8 shadow-popover">
      <Input
        ref={field}
        icon={<Search size={14} />}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("emoji.search")}
        aria-label={t("emoji.search")}
        className="h-32"
      />
      {query.trim() === "" ? (
        <div role="tablist" aria-label={t("emoji.groups")} className="flex flex-wrap gap-2">
          {recent.length > 0 ? (
            <GroupTab active={group === "recent"} label={t("emoji.recent")} onClick={() => setGroup("recent")} glyph="🕘" />
          ) : null}
          {groups.map((entry) => (
            <GroupTab
              key={entry.key}
              active={group === entry.order}
              label={entry.message}
              onClick={() => setGroup(entry.order)}
              glyph={byGroup.get(entry.order)?.[0]?.unicode ?? "·"}
            />
          ))}
        </div>
      ) : null}
      <div className="h-[220px] overflow-y-auto">
        {failed ? (
          <p className="p-8 text-body-sm text-fg-danger">{t("emoji.failed")}</p>
        ) : data === null ? (
          <p className="p-8 text-body-sm text-fg-muted">{t("emoji.loading")}</p>
        ) : shown.length === 0 ? (
          <p className="p-8 text-body-sm text-fg-muted">{t("emoji.none")}</p>
        ) : (
          <div className="grid grid-cols-8 gap-2">
            {shown.map((emoji) => (
              <button
                key={emoji}
                type="button"
                title={labels.get(emoji) ?? emoji}
                aria-label={labels.get(emoji) ?? emoji}
                onClick={() => onPick(emoji)}
                className="flex size-34 items-center justify-center rounded-md text-[20px] leading-none hover:bg-hover-overlay cursor-pointer select-none"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupTab({ active, label, glyph, onClick }: { active: boolean; label: string; glyph: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-28 items-center justify-center rounded-sm text-[16px] leading-none cursor-pointer select-none",
        active ? "bg-selected-overlay" : "opacity-70 hover:bg-hover-overlay hover:opacity-100",
      )}
    >
      {glyph}
    </button>
  );
}

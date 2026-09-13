import { useId, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "./ui";

/** A token field: Enter, comma, paste and blur commit editable tags. */
export function TagEditor({
  value,
  onChange,
  suggestions = [],
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
}) {
  const { t } = useTranslation("common"),
    id = useId();
  const [draft, setDraft] = useState("");
  const commit = (text = draft) => {
    const tags = text
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length) onChange([...new Set([...value, ...tags])]);
    setDraft("");
  };
  return (
    <div className="flex min-h-36 flex-wrap items-center gap-6 rounded-md border border-line bg-input px-8 py-6 focus-within:border-line-focus">
      {value.map((tag) => (
        <Badge
          key={tag}
          tone="accent"
          className="h-24 normal-case tracking-normal"
        >
          <span>{tag}</span>
          <button
            type="button"
            aria-label={t("media.removeTag", { tag })}
            onClick={() => onChange(value.filter((v) => v !== tag))}
          >
            <X size={12} />
          </button>
        </Badge>
      ))}
      <input
        aria-label={t("media.tags")}
        list={id}
        className="min-w-96 flex-1 w-96 bg-transparent outline-none text-body-sm text-fg placeholder:text-fg-muted"
        value={draft}
        placeholder={t("media.addTag")}
        onChange={(e) => {
          if (e.target.value.includes(",")) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft)
            onChange(value.slice(0, -1));
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[,\n]/.test(text)) {
            e.preventDefault();
            commit(draft + text);
          }
        }}
      />
      <datalist id={id}>
        {suggestions
          .filter((s) => !value.includes(s))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}

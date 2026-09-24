import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../../../lib/format";

/**
 * --- slice: bundles ---
 *
 * The controls of the editor's forms.
 *
 * Every field of the editor commits on blur: the value goes to the core as
 * one command, the draft comes back and the field shows it. There is no
 * **Save** button, so the field holds what the author is typing until the
 * focus leaves it and then either commits or, when the value is outside its
 * limit, shows why it did not.
 */

/** One labelled control of a form, with its hint and, when wrong, the reason. */
export function Field({
  label,
  hint,
  problem,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  problem?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor={htmlFor} className="text-label-xs text-fg-muted">
        {label}
      </label>
      {children}
      {problem ? (
        <span role="alert" className="text-body-sm text-fg-danger">
          {problem}
        </span>
      ) : hint ? (
        <span className="text-body-sm text-fg-muted">{hint}</span>
      ) : null}
    </div>
  );
}

/** A multi-line field in the shape of `Input`. */
export function TextArea({
  id,
  value,
  rows,
  maxLength,
  disabled = false,
  invalid = false,
  placeholder,
  onChange,
  onBlur,
}: {
  id?: string;
  value: string;
  rows: number;
  maxLength?: number;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      maxLength={maxLength}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      className={cn(
        "w-full px-12 py-8 rounded-md resize-y",
        "bg-input border focus:border-line-focus outline-none",
        invalid ? "border-line-danger" : "border-line",
        "text-body-md text-fg placeholder:text-fg-muted disabled:text-fg-disabled",
      )}
    />
  );
}

/**
 * A text value that follows the record until the author types, and commits
 * when the focus leaves.
 *
 * `check` answers the problem with the typed value, or `null`; a value with
 * a problem is not committed and the problem is shown under the field. A
 * value equal to the record is not committed either: a blur is not an edit.
 *
 * `settle` is what a blur does, for a section that has to write everything
 * down before it goes on — the language strip of the **Overview**, before
 * it shows another language or drops one — and cannot wait for a blur that
 * may not come. It commits a valid typed value the record does not hold,
 * shows the problem of one outside its limits, and answers with that
 * problem, or with `null`. A value already on its way it lets be: `commit`
 * answers with the promise of the write, and a refusal makes the value
 * unsent again, so that the next settle tries once more. A blur sends the
 * value again either way: it is the author's way to try a refused edit
 * again, and a commit that answers with nothing cannot tell a refusal from
 * an answer still to come.
 */
export function useCommitField(
  saved: string,
  commit: (value: string) => unknown,
  check: (value: string) => string | null = () => null,
): {
  value: string;
  problem: string | null;
  settle: () => string | null;
  onChange: (value: string) => void;
  onBlur: () => void;
} {
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // What the field committed and the record has not answered yet: it is on
  // its way, and a settle does not send it a second time.
  const [sent, setSent] = useState<string | null>(null);

  // The record changed under the field while nothing was being typed — a
  // command of another section answered — and the field follows it.
  useEffect(() => {
    setTyped(null);
    setProblem(null);
    setSent(null);
  }, [saved]);

  const value = typed ?? saved;
  // The problem of the typed value, shown; a value equal to the record let
  // go; anything else sent — unless it is on its way and `again` is off.
  const commitTyped = (again: boolean): string | null => {
    if (typed === null) return null;
    const found = check(typed);
    setProblem(found);
    if (found !== null) return found;
    if (typed === saved) {
      setTyped(null);
      return null;
    }
    if (!again && typed === sent) return null;
    setSent(typed);
    void Promise.resolve(commit(typed)).catch(() => {
      setSent((current) => (current === typed ? null : current));
    });
    return null;
  };
  return {
    value,
    problem,
    settle: () => commitTyped(false),
    onChange: (next) => {
      setTyped(next);
      if (problem !== null) setProblem(check(next));
    },
    onBlur: () => void commitTyped(true),
  };
}

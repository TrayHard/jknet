import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { addedAnybody, type AddOutcome } from "../../lib/chat/groups";
import type { ChatRefusalReason } from "../../lib/ipc";
import { useToasts } from "../ToastsProvider";
import { useChatNames } from "./useChatText";

/** How long the report of an add stays: long enough to read two lines. */
const REPORT_TOAST_MS = 8_000;

/** The key of a refusal's line; a reason this launcher does not know says «Not added». */
function refusalKey(reason: ChatRefusalReason | string): string {
  switch (reason) {
    case "full":
      return "group.report.full";
    case "too_many_groups":
      return "group.report.tooManyGroups";
    case "cooldown":
      return "group.report.cooldown";
    case "not_friend":
      return "group.report.notFriend";
    case "member":
      return "group.report.member";
    default:
      return "group.report.other";
  }
}

/**
 * --- slice: chat groups ---
 *
 * The words of an answer to **Create** or **Add**: who is in, who got an
 * invitation because they ask first, and who could not be added and why.
 * A dialog prints them under its list when nobody got in; otherwise the
 * dialog closes, the group shows the added members as system lines, and the
 * rest goes into a toast.
 */
export function useGroupReport() {
  const { t } = useTranslation("chat");
  // `refusalKey` picks the key at run time; every key it answers exists.
  const loose = t as unknown as (key: string, values?: Record<string, unknown>) => string;
  const names = useChatNames();
  const { show, dismiss } = useToasts();

  const list = useCallback((ids: string[]) => ids.map((id) => names.personName(id)).join(", "), [names]);

  /** One sentence per group of people; the added ones only when asked for. */
  const lines = useCallback(
    (outcome: AddOutcome, withAdded: boolean): string[] => {
      const out: string[] = [];
      if (withAdded && outcome.added.length > 0) out.push(t("group.report.added", { names: list(outcome.added) }));
      if (outcome.invited.length > 0) out.push(t("group.report.invited", { names: list(outcome.invited) }));
      for (const refusal of outcome.refused) {
        out.push(loose(refusalKey(refusal.reason), { names: list(refusal.userIds) }));
      }
      return out;
    },
    [t, loose, list],
  );

  /** A toast of the invitations and refusals of an answer that did change the group. */
  const toast = useCallback(
    (outcome: AddOutcome, title: string, key: string) => {
      if (!addedAnybody(outcome)) return;
      const text = lines(outcome, false);
      if (text.length === 0) return;
      const id = `chat-group-report:${key}`;
      show(id, {
        variant: outcome.refused.length > 0 ? "warning" : "info",
        title:
          outcome.refused.length > 0
            ? t("group.report.titleRefused", { title })
            : t("group.report.titleInvited", { title }),
        text: (
          <span className="flex flex-col gap-2">
            {text.map((line) => (
              <span key={line} className="[unicode-bidi:isolate]">
                {line}
              </span>
            ))}
          </span>
        ),
        onDismiss: () => dismiss(id),
      });
      window.setTimeout(() => dismiss(id), REPORT_TOAST_MS);
    },
    [lines, show, dismiss, t],
  );

  return { lines, toast };
}

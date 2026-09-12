import {
  Box,
  Boxes,
  Crown,
  Image,
  Info,
  LayoutDashboard,
  Map,
  Sparkles,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type {
  ConflictKind,
  ConflictReport,
  LibraryConflict,
  LibraryItem,
} from "../../lib/ipc";
import { Badge, Button, Dialog, type BadgeTone } from "../ui";

interface ConflictsDialogProps {
  report: ConflictReport;
  items: LibraryItem[];
  clientName: string;
  onClose: () => void;
  /** Disables one file so it stops taking part in the conflict. */
  onDisable: (id: string) => void;
  busy?: boolean;
}

interface KindInfo {
  icon: LucideIcon;
  tone: BadgeTone;
}

/**
 * Icon and tone per kind of content. The names live in the catalog, keyed by
 * the same id, so a kind is spelled one way whoever prints it.
 */
const KINDS: Record<ConflictKind, KindInfo> = {
  shader: { icon: Sparkles, tone: "purple" },
  model: { icon: Box, tone: "accent" },
  sound: { icon: Volume2, tone: "neutral" },
  texture: { icon: Image, tone: "warm" },
  map: { icon: Map, tone: "success" },
  ui: { icon: LayoutDashboard, tone: "neutral" },
  other: { icon: Boxes, tone: "neutral" },
};

/** Never throws: a kind the core adds later draws as Other. */
function kindInfo(kind: ConflictKind): KindInfo {
  return KINDS[kind] ?? KINDS.other;
}

/**
 * What the game will actually read when several files carry the same path.
 *
 * The dialog answers three questions and no more: what the shared path holds,
 * which files carry it and which one the game reads. The first answer comes
 * from the core as `kind` and the third from the order of `files`.
 *
 * --- slice: jkhub details ---
 * The rule behind the third answer — `paksort` in
 * `codemp/qcommon/files.cpp:3025` sorts the archives of a folder by name with
 * `dl_` last, and every archive is prepended to the search path, so the one
 * loaded last answers first — is the same two paragraphs whatever the
 * conflict is. It used to stand at the top of the list and cost a hundred
 * pixels of a window that has seven hundred; now it waits behind **Info**,
 * where the player who has read it once never opens it again.
 *
 * The losing files stay in the list instead of being folded away. Disabling
 * the winner hands the path to the file above it, and the player can only see
 * that if the whole chain is on screen.
 */
export function ConflictsDialog({
  report,
  items,
  clientName,
  onClose,
  onDisable,
  busy = false,
}: ConflictsDialogProps) {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");
  const [rule, setRule] = useState(false);
  const name = (id: string) => items.find((item) => item.id === id)?.fileName ?? id;

  return (
    <Dialog
      wide
      title={t("conflicts.title")}
      onClose={onClose}
      actions={<Button onClick={onClose}>{tCommon("actions.close")}</Button>}
    >
      {/* The summary and the way to the rule share one line. Passing the
          summary to `Dialog` as its `body` would put the button on a row of
          its own, and every row here is a row of conflicts not shown. */}
      <div className="flex items-start justify-between gap-12 pt-4">
        <p className="text-body-sm text-fg-secondary">
          {t("conflicts.body", {
            files: report.files.length,
            client: clientName,
            paths: report.total,
          })}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<Info size={14} />}
          aria-expanded={rule}
          aria-controls={RULE_ID}
          onClick={() => setRule((open) => !open)}
        >
          {t("conflicts.ruleToggle")}
        </Button>
      </div>

      {/* The rule scrolls with the list rather than sitting above it, so
          opening it costs list space and never makes the card taller than
          the window.

          The height is the window's, less everything around this block: the
          padding of the overlay and of the card, the title, the line above,
          this block's own top padding and the footer. The line that says the
          report was cut adds thirty more, and only when it is there, which is
          the whole of the difference between the two numbers. Both leave a
          dozen pixels spare, which is what a summary that wraps to a second
          line in a longer language needs.

          Measured, not guessed. At 1100 × 700, the smallest window the
          launcher allows, the card comes out 639 px tall inside a 652 px
          budget and the list gets 440 of them; at 1920 × 1080 the same list
          gets 820, which is the point — the old fixed 420 never grew. Four
          conflicts at 1080, or two at 700, fit whole and the block does not
          scroll at all. */}
      <div
        className={cn(
          "flex flex-col gap-16 pt-12 overflow-y-auto",
          report.truncated
            ? "max-h-[calc(100vh-260px)]"
            : "max-h-[calc(100vh-230px)]",
        )}
      >
        {rule ? (
          <div
            id={RULE_ID}
            className="flex flex-col gap-4 rounded-md border border-line bg-elevated p-12"
          >
            <span className="text-body-sm-medium text-fg">
              {t("conflicts.ruleTitle")}
            </span>
            <p className="text-body-sm text-fg-secondary">{t("conflicts.ruleOrder")}</p>
            <p className="text-body-sm text-fg-secondary">{t("conflicts.ruleDisable")}</p>
          </div>
        ) : null}

        <ul className="flex flex-col gap-8">
          {report.conflicts.map((conflict) => (
            <ConflictCard
              key={`${conflict.folder}/${conflict.path}`}
              conflict={conflict}
              name={name}
              busy={busy}
              onDisable={onDisable}
            />
          ))}
        </ul>
      </div>

      {report.truncated ? (
        <p className="text-body-sm text-fg-muted pt-12">
          {t("conflicts.truncated", {
            shown: report.conflicts.length,
            total: report.total,
          })}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Ties the **Info** button to the block it opens, for a screen reader. */
const RULE_ID = "conflicts-rule";

interface ConflictCardProps {
  conflict: LibraryConflict;
  /** File name of an item id, the id itself when the item is gone. */
  name: (id: string) => string;
  onDisable: (id: string) => void;
  busy: boolean;
}

/** One shared path: what it holds, who carries it, who wins, what to do. */
function ConflictCard({ conflict, name, onDisable, busy }: ConflictCardProps) {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");
  const kind = kindInfo(conflict.kind);
  const KindIcon = kind.icon;
  // The core hands over the load order and names the last file as the winner.
  // The one before it is what the game falls back to if the winner goes away.
  const winnerIndex = conflict.files.indexOf(conflict.winner);
  const next = winnerIndex > 0 ? conflict.files[winnerIndex - 1] : null;

  return (
    <li className="flex flex-col gap-6 rounded-md border border-line bg-input p-12">
      {/* --- slice: jkhub details ---
          What the path holds and where it lives, on one line with the path
          itself under it. The sentence that explained the kind moved onto the
          badge as a tooltip: it says the same thing about every shader in
          every conflict, and the badge is where the eye already is. */}
      <div className="flex items-start gap-8">
        <span title={t(`conflicts.kindHint.${conflict.kind}`)}>
          <Badge tone={kind.tone} icon={<KindIcon size={12} />}>
            {t(`conflicts.kind.${conflict.kind}`)}
          </Badge>
        </span>
        <span className="text-mono-sm text-fg break-all flex-1">
          {conflict.path}
        </span>
        <span
          className="text-mono-xs text-fg-muted shrink-0"
          title={t("conflicts.folderHint")}
        >
          {conflict.folder}
        </span>
      </div>

      <span className="text-label-xs text-fg-muted">{t("conflicts.order")}</span>

      <ul className="flex flex-col gap-4">
        {conflict.files.map((id, index) => {
          const winner = id === conflict.winner;
          return (
            <li key={id} className="flex items-center gap-8">
              <span className="text-mono-xs text-fg-muted w-16 shrink-0 text-right">
                {index + 1}
              </span>
              <span className="text-body-sm text-fg truncate flex-1" title={name(id)}>
                {name(id)}
              </span>
              {winner ? (
                <Badge tone="accent" icon={<Crown size={12} />}>
                  {t("conflicts.wins")}
                </Badge>
              ) : (
                <Badge tone="neutral">{t("conflicts.hidden")}</Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                title={
                  winner && next
                    ? t("conflicts.disableWinner", {
                        file: name(id),
                        next: name(next),
                      })
                    : t("conflicts.disableHidden", { file: name(id) })
                }
                onClick={() => onDisable(id)}
              >
                {tCommon("actions.disable")}
              </Button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

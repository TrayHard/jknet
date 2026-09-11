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
import { useTranslation } from "react-i18next";

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
 * The dialog answers four questions in this order: what the shared path holds,
 * which files carry it, which one the game reads and what changes if the
 * player disables any of them. The first answer comes from the core as
 * `kind`, the third from the order of `files`, and the rule behind both is the
 * static panel at the top: `paksort` in `codemp/qcommon/files.cpp:3025` sorts
 * the archives of a folder by name with `dl_` last, and every archive is
 * prepended to the search path, so the one loaded last answers first.
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
  const name = (id: string) => items.find((item) => item.id === id)?.fileName ?? id;

  return (
    <Dialog
      wide
      title={t("conflicts.title")}
      body={t("conflicts.body", {
        files: report.files.length,
        client: clientName,
        paths: report.total,
      })}
      onClose={onClose}
      actions={<Button onClick={onClose}>{tCommon("actions.close")}</Button>}
    >
      {/* The rule scrolls with the list rather than sitting above it: the
          dialog has to fit a 700 px window, and a pinned panel plus a list
          worth reading does not. */}
      <div className="flex flex-col gap-16 pt-16 max-h-[420px] overflow-y-auto">
        <div className="flex items-start gap-8 rounded-md border border-line bg-elevated p-12">
          <Info size={16} className="text-fg-accent shrink-0 mt-2" />
          <div className="flex flex-col gap-4">
            <span className="text-body-sm-medium text-fg">{t("conflicts.ruleTitle")}</span>
            <p className="text-body-sm text-fg-secondary">{t("conflicts.ruleOrder")}</p>
            <p className="text-body-sm text-fg-secondary">{t("conflicts.ruleDisable")}</p>
          </div>
        </div>

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
      <div className="flex items-start gap-8">
        <Badge tone={kind.tone} icon={<KindIcon size={12} />}>
          {t(`conflicts.kind.${conflict.kind}`)}
        </Badge>
        <span className="text-body-sm text-fg-muted flex-1">
          {t(`conflicts.kindHint.${conflict.kind}`)}
        </span>
        <span
          className="text-mono-xs text-fg-muted shrink-0"
          title={t("conflicts.folderHint")}
        >
          {conflict.folder}
        </span>
      </div>

      <span className="text-mono-sm text-fg break-all">{conflict.path}</span>
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

      {next ? (
        <p className="text-body-sm text-fg-muted">
          {t("conflicts.outcome", {
            winner: name(conflict.winner),
            next: name(next),
          })}
        </p>
      ) : null}
    </li>
  );
}

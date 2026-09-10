import { Crown } from "lucide-react";

import type { ConflictReport, LibraryItem } from "../../lib/ipc";
import { Badge, Button, Dialog } from "../ui";

interface ConflictsDialogProps {
  report: ConflictReport;
  items: LibraryItem[];
  clientName: string;
  onClose: () => void;
  /** Disables one file so it stops taking part in the conflict. */
  onDisable: (id: string) => void;
  busy?: boolean;
}

/**
 * What the engine will actually load when two archives carry the same path.
 *
 * The rule is `paksort` in `codemp/qcommon/files.cpp:3025`: the archive whose
 * name sorts last is loaded last and answers first. Disabling one file is the
 * only fix the launcher can offer, so it is the only action here.
 */
export function ConflictsDialog({
  report,
  items,
  clientName,
  onClose,
  onDisable,
  busy = false,
}: ConflictsDialogProps) {
  const name = (id: string) => items.find((item) => item.id === id)?.fileName ?? id;

  return (
    <Dialog
      wide
      title="Files that change the same content"
      body={`${report.files.length} archives of ${clientName} carry ${report.total} shared paths. The engine reads the last one it loads and ignores the rest.`}
      onClose={onClose}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <ul className="flex flex-col gap-8 pt-16 max-h-[420px] overflow-y-auto">
        {report.conflicts.map((conflict) => (
          <li
            key={`${conflict.folder}/${conflict.path}`}
            className="flex flex-col gap-6 rounded-md border border-line bg-input p-12"
          >
            <span className="text-mono-xs text-fg-secondary break-all">
              {conflict.path}
            </span>
            <ul className="flex flex-col gap-4">
              {conflict.files.map((id) => {
                const winner = id === conflict.winner;
                return (
                  <li key={id} className="flex items-center gap-8">
                    {winner ? (
                      <Badge tone="accent" icon={<Crown size={12} />}>
                        Wins
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Hidden</Badge>
                    )}
                    <span className="text-body-sm text-fg truncate flex-1" title={name(id)}>
                      {name(id)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onDisable(id)}
                    >
                      Disable
                    </Button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>

      {report.truncated ? (
        <p className="text-body-sm text-fg-muted pt-12">
          Only the first {report.conflicts.length} of {report.total} paths are
          listed. Disable one of the archives to see the rest.
        </p>
      ) : null}
    </Dialog>
  );
}

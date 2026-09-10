import { Check, X } from "lucide-react";

import type { FriendRequest, OnlineUser } from "../../lib/ipc";
import { Avatar, Button } from "../ui";

interface RequestListProps {
  title: string;
  requests: FriendRequest[];
  /** `from` for requests sent to me, `to` for the ones I sent. */
  side: "from" | "to";
  /** Shown only for incoming requests. */
  onAccept?: (id: string) => void;
  /** Declines an incoming request, or cancels one I sent. */
  onDismiss: (id: string) => void;
  dismissLabel: string;
  busyId?: string;
}

/**
 * The two request sections of the design: what is waiting for me and what I
 * am waiting for.
 *
 * One component for both because the row is the same and only the buttons
 * differ; a second copy would be where the two drift apart.
 */
export function RequestList({
  title,
  requests,
  side,
  onAccept,
  onDismiss,
  dismissLabel,
  busyId,
}: RequestListProps) {
  if (requests.length === 0) return null;

  return (
    <section className="flex flex-col gap-4 pt-16">
      <span className="text-label-xs text-fg-muted px-12 pb-4">
        {title} · {requests.length}
      </span>
      {requests.map((request) => {
        const person: OnlineUser = side === "from" ? request.from : request.to;
        const busy = busyId === request.id;
        return (
          <div
            key={request.id}
            className="flex items-center gap-12 h-48 px-12 rounded-md hover:bg-hover-overlay"
          >
            <Avatar name={person.displayName} src={person.avatarUrl} />
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="text-body-md-medium text-fg truncate">
                {person.displayName}
              </span>
              <span className="text-mono-xs text-fg-muted truncate">
                {person.provider}:{person.providerName}
              </span>
            </span>
            {onAccept ? (
              <Button
                size="sm"
                variant="primary"
                icon={<Check size={14} />}
                disabled={busy}
                onClick={() => onAccept(request.id)}
              >
                Accept
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={14} />}
              disabled={busy}
              onClick={() => onDismiss(request.id)}
            >
              {dismissLabel}
            </Button>
          </div>
        );
      })}
    </section>
  );
}

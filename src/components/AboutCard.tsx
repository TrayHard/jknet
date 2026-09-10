import { AlertTriangle, Check, Download, RefreshCw } from "lucide-react";

import { useAppUpdateContext } from "./AppUpdateProvider";
import { Button } from "./ui";

/**
 * The About card at the bottom of Settings: which build is running and
 * whether a newer one exists.
 *
 * The card shares the state of `AppUpdateProvider`, so **Check for updates**
 * and the toast in the corner never disagree about what was found. Unlike the
 * check at startup, this one shows its failure: the player pressed a button
 * and is owed an answer.
 */
export function AboutCard() {
  const update = useAppUpdateContext();

  const version = update?.currentVersion ?? null;
  const newVersion = update?.newVersion ?? null;
  const supported = update?.supported ?? false;

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">About</h2>
      <div className="flex items-start gap-16">
        <div className="flex-1 min-w-0">
          <p className="text-body-sm text-fg-secondary pb-8">
            JKNet updates itself from GitHub Releases. Every package is signed,
            and an unsigned one is refused.
          </p>
          <p className="text-mono-sm text-fg">
            Version {version ?? (supported ? "…" : "unknown")}
          </p>
          <UpdateLine />
        </div>
        {newVersion !== null ? (
          <Button
            variant="primary"
            icon={<Download size={16} />}
            disabled={update?.busy ?? true}
            onClick={update?.install}
          >
            Install and restart
          </Button>
        ) : (
          <Button
            icon={
              <RefreshCw
                size={16}
                className={update?.stage === "checking" ? "animate-spin" : undefined}
              />
            }
            disabled={!supported || (update?.busy ?? true)}
            onClick={update?.check}
          >
            Check for updates
          </Button>
        )}
      </div>
    </section>
  );
}

/** The one line under the version: what the last check said. */
function UpdateLine() {
  const update = useAppUpdateContext();
  if (!update) return null;

  if (!update.supported) {
    return (
      <p className="text-body-sm text-fg-muted pt-8">
        Updates work in the installed launcher, not in a browser tab.
      </p>
    );
  }

  if (update.stage === "error" && update.error !== null) {
    return (
      <p className="flex items-start gap-6 text-body-sm text-fg-danger pt-8">
        <AlertTriangle size={14} className="shrink-0 mt-2" />
        <span>{update.error}</span>
      </p>
    );
  }

  if (update.newVersion !== null) {
    return (
      <p className="text-body-sm text-fg-accent pt-8">
        JKNet {update.newVersion} is available.
      </p>
    );
  }

  if (update.stage === "checking") {
    return (
      <p className="text-body-sm text-fg-muted pt-8">Checking for updates…</p>
    );
  }

  // Before the first answer comes back the card says nothing. "You are up to
  // date" is a claim, and no check has been made yet that could support it.
  if (update.checkedAt === null) return null;

  return (
    <p className="flex items-center gap-6 text-body-sm text-fg-muted pt-8">
      <Check size={14} className="text-fg-success shrink-0" />
      <span>This is the latest version.</span>
    </p>
  );
}

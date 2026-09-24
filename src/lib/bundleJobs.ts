import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import {
  bundleEvents,
  type BundleInstallProgress,
  type BundlePublishProgress,
  type Client,
  type PublishResult,
} from "./ipc";
import { isTauri } from "./runtime";

/**
 * --- slice: bundles ---
 *
 * What every install and every publish of a bundle is doing right now.
 *
 * A store outside React, for the same reason `jkhubDownloads.ts` is one: the
 * work is started from a dialog or the editor and outlives it. A player
 * presses **Install** on a 1.4 GB bundle of three components, closes the
 * dialog, reads the server browser and opens the bundle again — and the bar
 * has to be where it was, with the same component and file name under it.
 * State inside the dialog would be gone with the dialog, and the `bundles:*`
 * events would be arriving at nobody.
 *
 * The writers are the three mutations in `queries.ts` — every install and
 * every publish goes through them — and the two Tauri events, which this
 * module subscribes to itself the first time anyone reads or writes it. The
 * readers are the bundle dialog, the **Publish** section of the editor and
 * the client card, which holds its buttons while a job is writing the client.
 */

/** How far one job has got: the call is in flight, answered, or failed. */
export type BundleJobPhase = "running" | "done" | "failed";

/**
 * The key of an install: one install per version or per draft at a time,
 * which is also the lock the core takes.
 */
export function installJobKey(bundleId: string, versionId: string): string {
  return `bundle:${bundleId}:${versionId}`;
}

/** The key of a test install out of a draft. */
export function draftJobKey(draftId: string): string {
  return `draft:${draftId}`;
}

/** The key an event belongs to, or `null` for an event that names nothing. */
function keyOf(progress: BundleInstallProgress): string | null {
  if (progress.draftId) return draftJobKey(progress.draftId);
  if (progress.bundleId && progress.versionId) return installJobKey(progress.bundleId, progress.versionId);
  return null;
}

/** One install of a version or a draft, keyed by `installJobKey` or `draftJobKey`. */
export interface BundleInstallJob {
  key: string;
  bundleId: string | null;
  versionId: string | null;
  draftId: string | null;
  /** The name the player gave, for the bar while the clients have no record yet. */
  baseName: string;
  /** The components the player ticked, in the order the core installs them. */
  componentIds: string[];
  /**
   * The clients a retry carries on in, by component: the ones the player
   * named on the press, plus every client the events have named since. A
   * component missing here gets a new client on the next try.
   */
  existingClientIds: Record<string, string>;
  /** The component being written, from the last event. */
  componentId: string | null;
  /** The client being written, from the last event. */
  clientId: string | null;
  /** Every client this job has touched: the core holds all of them until the end. */
  clientIds: string[];
  phase: BundleJobPhase;
  /** The last event of the core, or `null` before the first one. */
  progress: BundleInstallProgress | null;
  /** The clients, once the core answered. */
  clients: Client[];
  /**
   * The failure exactly as the call threw it. Untranslated on purpose: the
   * dialog that shows it has `useErrorText`, and this store has no i18n.
   */
  error: unknown;
  /** Ticks up on every retry of the same key. */
  attempt: number;
}

/** One publish of a draft, keyed by the draft: the core refuses a second one. */
export interface BundlePublishJob {
  draftId: string;
  /**
   * The bundle the version goes into: the one the draft is bound to, or the
   * one the core created, as soon as a `creating` event names it. `null`
   * until then. The core writes it into the draft as well, so a retry adds
   * a version to that bundle instead of creating a second one.
   */
  bundleId: string | null;
  phase: BundleJobPhase;
  progress: BundlePublishProgress | null;
  result: PublishResult | null;
  error: unknown;
  attempt: number;
}

export interface BundleJobs {
  installs: readonly BundleInstallJob[];
  publishes: readonly BundlePublishJob[];
}

type Listener = () => void;

let jobs: BundleJobs = { installs: [], publishes: [] };
const listeners = new Set<Listener>();
/**
 * The keys of the install calls of this window that have not answered yet.
 *
 * What tells a `done` event of an install this window is waiting on — the
 * answer with the clients is about to follow — from one of an install no
 * call of this window is waiting on, which that event ends.
 */
const inFlight = new Set<string>();

function publish(next: BundleJobs) {
  jobs = next;
  for (const listener of listeners) listener();
}

function replaceInstall(
  key: string,
  change: (previous: BundleInstallJob | undefined) => BundleInstallJob | null,
) {
  const previous = jobs.installs.find((job) => job.key === key);
  const without = jobs.installs.filter((job) => job.key !== key);
  const next = change(previous);
  publish({ ...jobs, installs: next === null ? without : [...without, next] });
}

function replacePublish(
  draftId: string,
  change: (previous: BundlePublishJob | undefined) => BundlePublishJob | null,
) {
  const previous = jobs.publishes.find((job) => job.draftId === draftId);
  const without = jobs.publishes.filter((job) => job.draftId !== draftId);
  const next = change(previous);
  publish({ ...jobs, publishes: next === null ? without : [...without, next] });
}

/** The record of an install with one more event folded in. */
function withProgress(
  previous: BundleInstallJob,
  progress: BundleInstallProgress,
): BundleInstallJob {
  const clientIds =
    progress.clientId && !previous.clientIds.includes(progress.clientId)
      ? [...previous.clientIds, progress.clientId]
      : previous.clientIds;
  const existingClientIds =
    progress.componentId && progress.clientId
      ? { ...previous.existingClientIds, [progress.componentId]: progress.clientId }
      : previous.existingClientIds;
  return {
    ...previous,
    componentId: progress.componentId ?? previous.componentId,
    clientId: progress.clientId ?? previous.clientId,
    clientIds,
    existingClientIds,
    progress,
    // The call is what ends the job; the `done` event of the core comes a
    // moment before the answer and does not end it here (the listener drops
    // a job no call is waiting on instead). An `error` event may arrive
    // when the call has already failed, and then it only adds the file
    // name to the record.
    phase:
      previous.phase === "done"
        ? previous.phase
        : progress.phase === "error"
          ? "failed"
          : previous.phase,
  };
}

/**
 * Attaches the two event listeners, once per window.
 *
 * Never detached: the events describe work the core is doing whether or not
 * a dialog is open, and a listener that came and went with the dialog would
 * miss the events that arrived in between — including the one that says
 * the install is over. Outside Tauri there is nothing to listen to.
 */
let listening: Promise<void> | null = null;

function ensureListening(): void {
  if (listening !== null || !isTauri()) return;
  listening = Promise.all([
    listen<BundleInstallProgress>(bundleEvents.installProgress, (event) => {
      const progress = event.payload;
      const key = keyOf(progress);
      if (key === null) return;
      replaceInstall(key, (previous) => {
        // The end of an install no call of this window is waiting on: the
        // core carried on after a reload. Nothing will answer with the
        // clients, so the record goes with the event. Left running, it
        // would hold the clients busy on their cards and hand their ids to
        // the next press as the clients to carry on in.
        if (progress.phase === "done" && !inFlight.has(key) && previous?.phase !== "done") {
          return null;
        }
        return withProgress(
          previous ?? {
            // A job this window never started: the core is carrying on
            // after a reload. The bar is still worth drawing, and a retry
            // needs the client ids.
            key,
            bundleId: progress.bundleId,
            versionId: progress.versionId,
            draftId: progress.draftId,
            baseName: "",
            componentIds: [],
            existingClientIds: {},
            componentId: null,
            clientId: null,
            clientIds: [],
            phase: "running",
            progress: null,
            clients: [],
            error: null,
            attempt: 1,
          },
          progress,
        );
      });
    }),
    listen<BundlePublishProgress>(bundleEvents.publishProgress, (event) => {
      const progress = event.payload;
      replacePublish(progress.draftId, (previous) =>
        previous === undefined
          ? {
              draftId: progress.draftId,
              bundleId: progress.bundleId ?? null,
              phase: progress.phase === "error" ? "failed" : "running",
              progress,
              result: null,
              error: null,
              attempt: 1,
            }
          : {
              ...previous,
              // The id is kept once known: the events before `creating`
              // carry none, and the `error` event may carry none either.
              bundleId: progress.bundleId ?? previous.bundleId,
              progress,
              phase:
                previous.phase === "done"
                  ? previous.phase
                  : progress.phase === "error"
                    ? "failed"
                    : previous.phase,
            },
      );
    }),
  ]).then(() => undefined);
}

/** What a press of **Install** or **Test locally** tells the store. */
export interface InstallStart {
  key: string;
  bundleId: string | null;
  versionId: string | null;
  draftId: string | null;
  baseName: string;
  componentIds: string[];
  existingClientIds: Record<string, string>;
}

export const bundleJobs = {
  /**
   * An install has been asked for. Replaces whatever that key said before.
   *
   * A press after a failed try carries on in the clients of that try: the
   * ones the events named, plus any the press names itself. A press after
   * a finished install starts afresh, with the clients the press names and
   * no other. The core takes a client of the same bundle, version and
   * component as the one to carry on in whether or not its install is
   * still pending, so a finished client handed on here would be written
   * over — the player pressed **Install again** for a second copy, and a
   * retry of that press must not land in the first.
   */
  startInstall(start: InstallStart) {
    ensureListening();
    replaceInstall(start.key, (previous) => {
      const unfinished = previous !== undefined && previous.phase !== "done" ? previous : undefined;
      return {
        key: start.key,
        bundleId: start.bundleId,
        versionId: start.versionId,
        draftId: start.draftId,
        baseName: start.baseName,
        componentIds: start.componentIds,
        existingClientIds: { ...(unfinished?.existingClientIds ?? {}), ...start.existingClientIds },
        componentId: null,
        clientId: null,
        clientIds: [
          ...new Set([...(unfinished?.clientIds ?? []), ...Object.values(start.existingClientIds)]),
        ],
        phase: "running",
        progress: null,
        clients: [],
        error: null,
        attempt: (unfinished?.attempt ?? 0) + 1,
      };
    });
    inFlight.add(start.key);
  },
  /** The core answered with the clients. */
  finishInstall(key: string, clients: Client[]) {
    inFlight.delete(key);
    replaceInstall(key, (previous) =>
      previous === undefined
        ? null
        : {
            ...previous,
            phase: "done",
            clients,
            clientIds: [...new Set([...previous.clientIds, ...clients.map((client) => client.id)])],
            error: null,
          },
    );
  },
  /** The call failed. The last event, if any, names the file and the component. */
  failInstall(key: string, error: unknown) {
    inFlight.delete(key);
    replaceInstall(key, (previous) =>
      previous === undefined ? null : { ...previous, phase: "failed", error },
    );
  },
  /** The player is done with the record. */
  forgetInstall(key: string) {
    replaceInstall(key, () => null);
  },

  /** A publish has been asked for. */
  startPublish(draftId: string) {
    ensureListening();
    replacePublish(draftId, (previous) => ({
      draftId,
      // A retry keeps the bundle the previous try got as far as creating;
      // the core reads the same id out of the draft.
      bundleId: previous?.bundleId ?? null,
      phase: "running",
      progress: null,
      result: null,
      error: null,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
  },
  finishPublish(draftId: string, result: PublishResult) {
    replacePublish(draftId, (previous) =>
      previous === undefined
        ? null
        : { ...previous, phase: "done", result, bundleId: result.bundle.id, error: null },
    );
  },
  failPublish(draftId: string, error: unknown) {
    replacePublish(draftId, (previous) =>
      previous === undefined ? null : { ...previous, phase: "failed", error },
    );
  },
  forgetPublish(draftId: string) {
    replacePublish(draftId, () => null);
  },
};

function subscribe(listener: Listener): () => void {
  // A reader is a window that will draw the bar, so this is the moment the
  // events start being collected — before any job of this window has begun,
  // in case the core is already busy with one.
  ensureListening();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): BundleJobs {
  return jobs;
}

/** Every install and publish the launcher has been asked for, oldest first. */
export function useBundleJobs(): BundleJobs {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The install under one key, or `undefined` when none was asked for. */
export function useBundleInstallJob(key: string | null): BundleInstallJob | undefined {
  const { installs } = useBundleJobs();
  return key === null ? undefined : installs.find((job) => job.key === key);
}

/** The publish of one draft, or `undefined` when none was asked for. */
export function useBundlePublishJob(draftId: string | null): BundlePublishJob | undefined {
  const { publishes } = useBundleJobs();
  return draftId === null ? undefined : publishes.find((job) => job.draftId === draftId);
}

/**
 * The install that is writing one client right now, if any.
 *
 * The core holds every client of an install until the last component is
 * done, so a client the job touched earlier is as busy as the one under the
 * bar: the card reads this to hold its buttons.
 */
export function useBundleInstallOfClient(clientId: string): BundleInstallJob | undefined {
  const { installs } = useBundleJobs();
  return installs.find((job) => job.phase === "running" && job.clientIds.includes(clientId));
}

/**
 * The launcher's half of a community page: the client to play with, the
 * recommended files it has, installing them and joining a server.
 *
 * Two cards of the page read the same state — **Play** and **Recommended
 * files** — so the client chosen in one is the client of the other, and an
 * install started in either shows in both. The state lives in
 * {@link LauncherPlayProvider} around the community screens; the shared
 * components know nothing of clients, and draw these through `renderPlay`
 * and `renderFiles` of the platform.
 *
 * Installing is the queue of before: every file of the list in order, each
 * checked for the game, the core comparing every archive member so that a
 * removed file comes back and a half-installed pack is repaired. Joining
 * waits until every file succeeded. **Stop after this file** ends the queue
 * between two files; what was installed stays.
 */

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, LoaderCircle, Play } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Panel, PanelHead } from "../components/community/bits";
import { GAME_NAMES } from "../components/community/format";
import { useCommunityPlatform, type PlayContext } from "../components/community/platform";
import { BundleRow, jkhubPage } from "../components/community/SideCards";
import type { Community, CommunityServer, Game } from "../components/community/types";
import { Button, Select } from "../components/ui";
import { useErrorText } from "../i18n/errors";
import { cn } from "../lib/format";
import { jkhubIpc, type Client } from "../lib/ipc";
import { libraryKeys, useAddServerHistory, useClients, useEngines, useLaunchClient, useLibrary, useRunningGame } from "../lib/queries";

/** An install or a join in flight, for the community it belongs to. */
interface Job {
  communityId: string;
  installing: boolean;
  joining: boolean;
  /** The file being installed now. */
  current: string;
  done: number[];
  total: number;
}

interface PlayState {
  /** The client chosen per game this session. */
  chosen: Partial<Record<Game, string>>;
  choose: (game: Game, clientId: string) => void;
  job: Job | null;
  error: { communityId: string; text: string } | null;
  notice: { communityId: string; text: string } | null;
  // --- slice: community events --- an event installs its requirements through the same queue.
  run: (community: Pick<Community, "id" | "recommendations">, clientId: string, game: Game, server: CommunityServer | null, install: boolean, join: boolean) => void;
  stop: () => void;
}

const PlayContextValue = createContext<PlayState | null>(null);

export function usePlayState(): PlayState {
  const state = useContext(PlayContextValue);
  if (state === null) throw new Error("The launcher's play controls need a LauncherPlayProvider");
  return state;
}

export function LauncherPlayProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("community");
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const launch = useLaunchClient();
  const history = useAddServerHistory();
  const [chosen, setChosen] = useState<Partial<Record<Game, string>>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<PlayState["error"]>(null);
  const [notice, setNotice] = useState<PlayState["notice"]>(null);
  const locked = useRef(false);
  const cancel = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancel.current = true;
    };
  }, []);

  const choose = useCallback((game: Game, clientId: string) => {
    setChosen((current) => ({ ...current, [game]: clientId }));
    setError(null);
    setNotice(null);
  }, []);

  const run = useCallback(
    (community: Pick<Community, "id" | "recommendations">, clientId: string, game: Game, server: CommunityServer | null, install: boolean, join: boolean) => {
      if (locked.current || clientId === "") return;
      locked.current = true;
      cancel.current = false;
      setError(null);
      setNotice(null);
      const files = install ? community.recommendations : [];
      setJob({ communityId: community.id, installing: install, joining: join, current: "", done: [], total: files.length });
      void (async () => {
        let currentFile = "";
        try {
          for (const file of files) {
            if (cancel.current) break;
            currentFile = file.title;
            if (alive.current) setJob((current) => current && { ...current, current: file.title });
            const detail = await jkhubIpc.file(file.jkhubId);
            if (detail.game !== game && detail.game !== "both") throw new Error(t("launcher.wrongGame"));
            if (cancel.current) break;
            const result = await jkhubIpc.install(file.jkhubId, clientId, false, true);
            if (result.kind !== "installed") throw new Error(result.kind === "conflicts" ? t("launcher.conflicts") : t("launcher.unsupported"));
            if (alive.current) setJob((current) => current && { ...current, done: [...current.done, file.jkhubId] });
          }
          if (install) void queryClient.invalidateQueries({ queryKey: libraryKeys.items(clientId) });
          if (cancel.current) {
            if (alive.current) setNotice({ communityId: community.id, text: t("launcher.stopped") });
            return;
          }
          if (install && files.length > 0 && alive.current) setNotice({ communityId: community.id, text: t("launcher.done") });
          if (join && server && alive.current) {
            currentFile = "";
            setJob((current) => current && { ...current, installing: false, current: "" });
            await launch.mutateAsync({ clientId, connect: server.address });
            history.mutate({ address: server.address, clientId, game: server.game });
          }
        } catch (failure) {
          if (alive.current) {
            const text = failure instanceof Error && !("code" in failure) ? failure.message : errorText(failure);
            setError({ communityId: community.id, text: currentFile ? `${currentFile}: ${text}` : text });
          }
        } finally {
          locked.current = false;
          if (alive.current) setJob(null);
        }
      })();
    },
    [errorText, history, launch, queryClient, t],
  );

  const stop = useCallback(() => {
    cancel.current = true;
  }, []);

  const value = useMemo(() => ({ chosen, choose, job, error, notice, run, stop }), [chosen, choose, job, error, notice, run, stop]);
  return <PlayContextValue.Provider value={value}>{children}</PlayContextValue.Provider>;
}

/** The clients of a game with an engine in them, and the one chosen. */
export function useClientChoice(game: Game): { choices: Client[]; clientId: string; engineName: (client: Client) => string } {
  const state = usePlayState();
  const clients = useClients();
  const engines = useEngines();
  const choices = (clients.data ?? []).filter((client) => client.game === game && client.engineInstalledAt);
  const wanted = state.chosen[game];
  const clientId = choices.some((client) => client.id === wanted) ? (wanted as string) : choices[0]?.id ?? "";
  const engineName = (client: Client) => engines.data?.find((engine) => engine.id === client.engineId)?.name ?? client.engineId;
  return { choices, clientId, engineName };
}

/** The JKHub files of a list the client already has, by the provenance the JKHub tab wrote. */
export function useInstalledFiles(clientId: string): { known: boolean; installed: Set<number> } {
  const library = useLibrary(clientId === "" ? null : clientId);
  const installed = useMemo(() => {
    const ids = new Set<number>();
    for (const item of library.data ?? []) {
      if (item.provenance?.fileId) ids.add(item.provenance.fileId);
    }
    return ids;
  }, [library.data]);
  return { known: library.data !== undefined, installed };
}

export function ClientSelect({ game, clientId, choices, engineName, disabled }: {
  game: Game;
  clientId: string;
  choices: Client[];
  engineName: (client: Client) => string;
  disabled: boolean;
}) {
  const { t } = useTranslation("community");
  const state = usePlayState();
  return (
    <Select
      className="w-full"
      value={clientId}
      onChange={(value) => state.choose(game, value)}
      ariaLabel={t("launcher.client")}
      disabled={disabled}
      options={choices.map((client) => ({ value: client.id, label: client.name, hint: engineName(client) }))}
    />
  );
}

export function Tone({ tone, children }: { tone: "warm" | "success" | "danger" | "info"; children: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-10 rounded-md border px-12 py-8 text-body-sm text-fg [overflow-wrap:anywhere]",
        tone === "warm" && "border-line-warm bg-warm-subtle",
        tone === "success" && "border-success bg-success-subtle",
        tone === "danger" && "border-line-danger bg-danger-subtle",
        tone === "info" && "border-line bg-input",
      )}
    >
      <Icon
        size={16}
        aria-hidden="true"
        className={cn(
          "mt-1 shrink-0",
          tone === "warm" && "text-fg-warm",
          tone === "success" && "text-fg-success",
          tone === "danger" && "text-fg-danger",
          tone === "info" && "text-fg-muted",
        )}
      />
      <span>{children}</span>
    </p>
  );
}

/** **Play** of the launcher: the client, what it lacks, **Install recommended and join** and **Connect**. */
export function LauncherPlay({ community, server }: PlayContext) {
  const { t } = useTranslation("community");
  const errorText = useErrorText();
  const state = usePlayState();
  const running = useRunningGame();
  const game: Game = server?.game ?? community.games[0] ?? "ja";
  const { choices, clientId, engineName } = useClientChoice(game);
  const { known, installed } = useInstalledFiles(clientId);
  const client = choices.find((choice) => choice.id === clientId);
  const job = state.job?.communityId === community.id ? state.job : null;
  const otherJob = state.job !== null && job === null;
  const missing = known ? community.recommendations.filter((file) => !installed.has(file.jkhubId)) : [];
  const blocked = running.data != null || running.isPending || running.isError;
  const disabled = state.job !== null || clientId === "" || server === null || blocked;
  const error = state.error?.communityId === community.id ? state.error.text : null;
  const notice = state.notice?.communityId === community.id ? state.notice.text : null;

  if (choices.length === 0) {
    return <Tone tone="info">{t("launcher.noClient", { game: GAME_NAMES[game] })}</Tone>;
  }

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-col gap-6">
        <span className="text-body-sm-medium text-fg-secondary">{t("launcher.client")}</span>
        <ClientSelect game={game} clientId={clientId} choices={choices} engineName={engineName} disabled={state.job !== null} />
      </div>
      {running.data ? <Tone tone="info">{t("launcher.running")}</Tone> : null}
      {running.isError ? <Tone tone="danger">{errorText(running.error)}</Tone> : null}
      {community.recommendations.length > 0 && known ? (
        missing.length > 0 ? (
          <Tone tone="warm">{t("launcher.missing", { count: missing.length, client: client?.name ?? "" })}</Tone>
        ) : (
          <Tone tone="success">{t("launcher.allInstalled")}</Tone>
        )
      ) : null}
      <div className="flex flex-col gap-8">
        {missing.length > 0 ? (
          <Button
            variant="primary"
            size="lg"
            block
            wrap
            icon={job?.installing ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />}
            disabled={disabled || otherJob}
            onClick={() => state.run(community, clientId, game, server, true, true)}
          >
            {job?.installing && job.current !== ""
              ? t("launcher.installing", { file: job.current })
              : job?.joining && !job.installing
                ? t("launcher.starting")
                : t("launcher.installJoin")}
          </Button>
        ) : null}
        <Button
          variant={missing.length > 0 ? "secondary" : "primary"}
          size={missing.length > 0 ? "md" : "lg"}
          block
          wrap
          icon={<Play size={16} />}
          disabled={disabled || otherJob}
          onClick={() => state.run(community, clientId, game, server, false, true)}
        >
          {job?.joining && !job.installing && missing.length === 0 ? t("launcher.starting") : t("launcher.connect")}
        </Button>
      </div>
      {job?.installing ? (
        <div className="flex flex-wrap items-center gap-8">
          <p role="status" className="min-w-0 flex-1 text-body-sm text-fg-secondary">
            {t("launcher.progress", { done: job.done.length, total: job.total })}
          </p>
          <Button size="sm" variant="ghost" wrap onClick={state.stop}>
            {t("launcher.stop")}
          </Button>
        </div>
      ) : null}
      {error ? <Tone tone="danger">{error}</Tone> : null}
      {notice && !job ? <Tone tone="success">{notice}</Tone> : null}
    </div>
  );
}

/** **Recommended files** of the launcher: the same client, what it has of each file, **Install all**. */
export function LauncherFiles({ community }: { community: Community }) {
  const { t } = useTranslation("community");
  const state = usePlayState();
  const platform = useCommunityPlatform();
  const running = useRunningGame();
  const game: Game = community.games[0] ?? "ja";
  const { choices, clientId, engineName } = useClientChoice(game);
  const { known, installed } = useInstalledFiles(clientId);
  const job = state.job?.communityId === community.id ? state.job : null;
  if (community.recommendations.length === 0 && community.bundle === null) return null;
  const missing = known ? community.recommendations.filter((file) => !installed.has(file.jkhubId)) : community.recommendations;
  const blocked = running.data != null || running.isPending || running.isError;

  return (
    <Panel labelledBy="community-files">
      <PanelHead id="community-files" title={t("files.title")} end={<span className="text-body-sm text-fg-secondary">{t("files.note")}</span>} />
      {choices.length > 0 && community.recommendations.length > 0 ? (
        <div className="flex items-center gap-12">
          <span className="shrink-0 text-body-sm-medium text-fg-secondary">{t("launcher.client")}</span>
          <div className="min-w-0 flex-1">
            <ClientSelect game={game} clientId={clientId} choices={choices} engineName={engineName} disabled={state.job !== null} />
          </div>
        </div>
      ) : null}
      <ul className="flex flex-col gap-8">
        {community.recommendations.map((file) => {
          const has = known && installed.has(file.jkhubId);
          const busy = job?.installing === true && !has && !job.done.includes(file.jkhubId);
          const ok = has || (job?.done.includes(file.jkhubId) ?? false);
          return (
            <li
              key={file.jkhubId}
              data-testid="community-file"
              className="flex min-h-48 min-w-0 items-center gap-10 rounded-md border border-line-subtle bg-input py-6 pr-8 pl-12"
            >
              <span className={cn("flex shrink-0", ok ? "text-fg-success" : busy ? "text-fg-accent" : "text-fg-warm")} aria-hidden="true">
                {ok ? <CheckCircle2 size={18} /> : busy ? <LoaderCircle size={18} className="animate-spin" /> : <Download size={18} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-sm-medium text-fg" title={file.title}>
                  {file.title}
                </span>
                <span className="text-body-sm text-fg-secondary">
                  {t("files.source", { id: file.jkhubId })} ·{" "}
                  <span className={ok ? "text-fg-success" : "text-fg-warm"}>
                    {ok ? t("files.installed") : busy ? t("files.installing") : t("files.missing")}
                  </span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => platform.openExternal(jkhubPage(file.jkhubId))}
                className="inline-flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg"
                aria-label={`${t("files.view")}: ${file.title}`}
                title={t("files.view")}
              >
                <ExternalLink size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      {community.bundle ? (
        <ul>
          <BundleRow bundle={community.bundle} />
        </ul>
      ) : null}
      {community.recommendations.length > 0 && choices.length > 0 ? (
        <Button
          block
          wrap
          icon={job?.installing ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />}
          disabled={state.job !== null || clientId === "" || blocked || (known && missing.length === 0)}
          onClick={() => state.run(community, clientId, game, null, true, false)}
        >
          {job?.installing ? t("launcher.installingShort") : known && missing.length === 0 ? t("launcher.allThere") : t("launcher.installAll")}
        </Button>
      ) : null}
    </Panel>
  );
}

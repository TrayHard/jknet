/**
 * The launcher's half of the page of an event: the client to take part
 * with, the JKHub files of the requirements it has and lacks, **Prepare
 * client** and **Join**.
 *
 * The install queue is the community page's (`communityPlay.tsx`): every
 * file in order, each checked for the game, joining only after every file
 * went in. **Join** opens 30 minutes before the start and stays open until
 * the end; it installs what is missing first, then starts the client on the
 * server of the event.
 */

import { CheckCircle2, CircleAlert, Download, ExternalLink, LoaderCircle, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { jkhubPage } from "../components/community/SideCards";
import type { CommunityServer } from "../components/community/types";
import { BundleLine } from "../components/events/EventView";
import { useEventFormat } from "../components/events/format";
import { joinOpensAt, joinState } from "../components/events/logic";
import type { RequirementsContext } from "../components/events/platform";
import { useCommunityPlatform } from "../components/community/platform";
import { GAME_NAMES } from "../components/community/format";
import { Button } from "../components/ui";
import { useErrorText } from "../i18n/errors";
import { cn } from "../lib/format";
import { useRunningGame } from "../lib/queries";
import { ClientSelect, Tone, useClientChoice, useInstalledFiles, usePlayState } from "./communityPlay";

export function LauncherRequirements({ event, now, instructions }: RequirementsContext) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const format = useEventFormat();
  const errorText = useErrorText();
  const state = usePlayState();
  const running = useRunningGame();
  const game = event.game;
  const { choices, clientId, engineName } = useClientChoice(game);
  const { known, installed } = useInstalledFiles(clientId);
  const client = choices.find((choice) => choice.id === clientId);
  const files = event.requirements.files;
  const job = state.job?.communityId === event.id ? state.job : null;
  const otherJob = state.job !== null && job === null;
  const missing = known ? files.filter((file) => !installed.has(file.jkhubId)) : [];
  const ready = known && missing.length === 0;
  const blocked = running.data != null || running.isPending || running.isError;
  const join = joinState(event, now);
  const error = state.error?.communityId === event.id ? state.error.text : null;
  const notice = state.notice?.communityId === event.id ? state.notice.text : null;
  const server: CommunityServer | null =
    event.address === null
      ? null
      : { id: `event-${event.id}`, game, address: event.address, label: event.server?.label ?? "", position: 0, verified: true, verifiedAt: null };

  const install = (subset: typeof files) =>
    state.run({ id: event.id, recommendations: subset }, clientId, game, null, true, false);
  const joinNow = () => state.run({ id: event.id, recommendations: missing }, clientId, game, server, missing.length > 0, true);

  const joinHint =
    join === "cancelled"
      ? { tone: "text-fg-danger", text: t("requirements.joinCancelled") }
      : join === "ended"
        ? { tone: "text-fg-secondary", text: t("requirements.joinEnded") }
        : server === null
          ? { tone: "text-fg-secondary", text: t("requirements.joinOffline") }
          : join === "early"
            ? { tone: "text-fg-secondary", text: t("requirements.joinEarly", { time: format.time(joinOpensAt(event)) }) }
            : {
                tone: "text-fg-accent",
                text: missing.length > 0 ? `${t("requirements.joinOpen")} · ${t("requirements.joinMissing")}` : t("requirements.joinOpen"),
              };

  if (choices.length === 0) {
    return (
      <div className="flex flex-col gap-12">
        <Tone tone="info">{t("requirements.noClient", { game: GAME_NAMES[game] })}</Tone>
        {event.requirements.bundle ? (
          <ul>
            <BundleLine bundle={event.requirements.bundle} />
          </ul>
        ) : null}
        {instructions}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      <div className="flex items-center gap-12">
        <span className="shrink-0 text-body-sm-medium text-fg-secondary">{t("requirements.client")}</span>
        <div className="min-w-0 flex-1">
          <ClientSelect game={game} clientId={clientId} choices={choices} engineName={engineName} disabled={state.job !== null} />
        </div>
      </div>

      {files.length > 0 || event.requirements.bundle ? (
        <ul className="flex flex-col gap-8">
          {files.map((file) => {
            const has = known && installed.has(file.jkhubId);
            const busy = job?.installing === true && !has && job.current === file.title;
            const done = has || (job?.done.includes(file.jkhubId) ?? false);
            return (
              <li key={file.jkhubId} className="flex min-h-48 min-w-0 items-center gap-10 rounded-md border border-line-subtle bg-input py-6 pr-8 pl-12">
                <span className={cn("flex shrink-0", done ? "text-fg-success" : busy ? "text-fg-accent" : "text-fg-warm")} aria-hidden="true">
                  {done ? <CheckCircle2 size={16} /> : busy ? <LoaderCircle size={16} className="animate-spin" /> : <CircleAlert size={16} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body-sm-medium text-fg" title={file.title}>
                    {file.title}
                  </span>
                  <span className="text-body-sm text-fg-secondary">
                    {t("requirements.file", { id: file.jkhubId })} ·{" "}
                    <span className={done ? "text-fg-success" : busy ? "text-fg-accent" : "text-fg-warm"}>
                      {done ? t("requirements.installed") : busy ? t("requirements.installing") : t("requirements.missing")}
                    </span>
                  </span>
                </span>
                {!done && known ? (
                  <Button size="sm" wrap disabled={state.job !== null || blocked} onClick={() => install([file])}>
                    {t("requirements.install")}
                  </Button>
                ) : (
                  <button
                    type="button"
                    onClick={() => platform.openExternal(jkhubPage(file.jkhubId))}
                    aria-label={t("requirements.viewOf", { title: file.title })}
                    title={t("requirements.view")}
                    className="inline-flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg"
                  >
                    <ExternalLink size={14} />
                  </button>
                )}
              </li>
            );
          })}
          {event.requirements.bundle ? <BundleLine bundle={event.requirements.bundle} /> : null}
        </ul>
      ) : (
        <p className="text-body-sm text-fg-secondary">{t("requirements.none")}</p>
      )}

      {instructions}

      {running.data ? <Tone tone="info">{t("requirements.running")}</Tone> : null}
      {running.isError ? <Tone tone="danger">{errorText(running.error)}</Tone> : null}

      <div className="flex flex-col gap-8">
        {files.length > 0 ? (
          <>
            <Button
              variant={join === "open" && server !== null ? "secondary" : "primary"}
              block
              wrap
              icon={job?.installing ? <LoaderCircle size={16} className="animate-spin" /> : ready ? <CheckCircle2 size={16} /> : <Download size={16} />}
              disabled={ready || state.job !== null || clientId === "" || blocked || otherJob}
              onClick={() => install(missing.length > 0 ? missing : files)}
            >
              {job?.installing && job.current !== ""
                ? t("requirements.preparing", { file: job.current })
                : ready
                  ? t("requirements.ready")
                  : t("requirements.prepare")}
            </Button>
            <p className={cn("text-center text-body-sm", ready ? "text-fg-success" : "text-fg-secondary")}>
              {ready
                ? t("requirements.readyHelp", { client: client?.name ?? "" })
                : known
                  ? t("requirements.prepareHelp", { client: client?.name ?? "", files: missing.map((file) => file.title).join(", ") })
                  : null}
            </p>
          </>
        ) : null}
        <Button
          variant={join === "open" && server !== null ? "primary" : "secondary"}
          size="lg"
          block
          wrap
          icon={job?.joining ? <LoaderCircle size={18} className="animate-spin" /> : <Play size={18} />}
          disabled={join !== "open" || server === null || state.job !== null || clientId === "" || blocked || otherJob}
          onClick={joinNow}
        >
          {job?.joining ? t("requirements.joining") : t("requirements.join")}
        </Button>
        <p className={cn("text-center text-body-sm", joinHint.tone)}>{joinHint.text}</p>
        {job?.installing ? (
          <div className="flex flex-wrap items-center gap-8">
            <p role="status" className="min-w-0 flex-1 text-body-sm text-fg-secondary">
              {t("requirements.progress", { done: job.done.length, total: job.total })}
            </p>
            <Button size="sm" variant="ghost" wrap onClick={state.stop}>
              {t("requirements.stop")}
            </Button>
          </div>
        ) : null}
      </div>
      {error ? <Tone tone="danger">{error}</Tone> : null}
      {notice && !job ? <Tone tone="success">{notice}</Tone> : null}
    </div>
  );
}

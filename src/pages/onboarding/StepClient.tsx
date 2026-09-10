import { Check, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { useGameEventsContext } from "../../components/GameEventsProvider";
import { Badge, Button, Input, RadioCard } from "../../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import type { Engine, EngineInstallProgress } from "../../lib/ipc";
import {
  useClients,
  useCreateClient,
  useEngines,
  useEngineVersions,
  useInstallEngine,
  useSettings,
  useUpdateSettings,
} from "../../lib/queries";
import {
  firstClientGame,
  folderSlug,
  orderClients,
  type ClientChoice,
} from "./steps";
import { StepPanel } from "./StepPanel";

interface StepClientProps {
  onBack: () => void;
  onContinue: () => void;
}

/**
 * Step 2: one client, ready to play.
 *
 * Continue does the whole job — create, make default, download, unpack — and
 * reports it here. Splitting it into a form and a separate download button
 * would leave a new player with a client that cannot start and no hint that a
 * button on another screen is what finishes it.
 */
export function StepClient({ onBack, onContinue }: StepClientProps) {
  const { t } = useTranslation("onboarding");
  const { t: tCommon } = useTranslation("common");
  const { t: tClients } = useTranslation("clients");
  const errorText = useErrorText();
  const format = useFormat();
  const settings = useSettings();
  const clients = useClients();
  const engines = useEngines();
  const createClient = useCreateClient();
  const updateSettings = useUpdateSettings();
  const installEngine = useInstallEngine();
  const { installs, clearInstall } = useGameEventsContext();

  const [choice, setChoice] = useState<ClientChoice | null>(null);
  // --- slice: i18n --- the first client's name is a suggestion the player
  // reads and edits, so it comes from the catalog rather than from the code.
  const [name, setName] = useState(() => t("client.nameDefault"));
  /** Set once the client exists, so Retry never creates a second one. */
  const [clientId, setClientId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True once the step has been left, so a late answer changes nothing. */
  const left = useRef(false);

  // --- slice: game core ---
  // The first client belongs to the first game the player set up, which is
  // Jedi Academy when both are configured. The switcher slice may let the
  // player choose here; one game at a time is enough for a first run.
  const game = firstClientGame(settings.data);
  const engineList = (engines.data ?? []).filter((engine) => engine.game === game);
  const existing = orderClients(clients.data ?? [], settings.data?.defaultClientId);
  const versions = useEngineVersions(engineList.map((engine) => engine.id));

  // Preselect once both lists are in: the client the player already has, or
  // the engine JKNet recommends. Waiting for both keeps a slow client list
  // from losing to the engine registry, which never touches the disk.
  useEffect(() => {
    if (choice !== null || clients.data === undefined || engines.data === undefined) {
      return;
    }
    const first = orderClients(clients.data, settings.data?.defaultClientId)[0];
    if (first) {
      setChoice({ kind: "existing", clientId: first.id });
      return;
    }
    const recommended =
      engineList.find((engine) => engine.status.kind === "recommended") ?? engineList[0];
    if (recommended) setChoice({ kind: "engine", engineId: recommended.id });
  }, [choice, clients.data, engines.data, engineList, settings.data]);

  const progress: EngineInstallProgress | undefined = clientId
    ? installs[clientId]
    : undefined;
  const queryError = settings.error ?? clients.error ?? engines.error ?? null;
  const failure = error ?? (queryError ? errorText(queryError) : null);

  const chosenEngine =
    choice?.kind === "engine"
      ? (engineList.find((engine) => engine.id === choice.engineId) ?? null)
      : null;
  const canStart =
    choice !== null &&
    (choice.kind === "existing" || (name.trim().length > 0 && chosenEngine !== null));

  /** Moves on once and only once, whatever answers late. */
  const leave = () => {
    if (left.current) return;
    left.current = true;
    onContinue();
  };

  /**
   * Creates the client, makes it the default one and fetches its engine.
   *
   * Every part is skipped when it is already done, which is what makes Retry
   * safe after a download failed halfway: the client stays, the patch is
   * harmless, and only the install runs again.
   */
  const start = async () => {
    if (!choice || !canStart) return;
    setError(null);
    setWorking(true);
    try {
      let target = clientId;
      if (target === null) {
        target =
          choice.kind === "existing"
            ? choice.clientId
            : (
                await createClient.mutateAsync({
                  name: name.trim(),
                  engineId: choice.engineId,
                  game,
                })
              ).id;
        setClientId(target);
      }

      // The game of the client that is about to become the default one, which
      // is not always the game of this step. The engine cards offer one game,
      // but the cards above them offer every client the player already has,
      // and one of those may belong to the other game.
      const clientGame =
        choice.kind === "existing"
          ? (clients.data?.find((one) => one.id === choice.clientId)?.game ?? game)
          : game;

      // One field, one patch: the document on disk keeps everything else.
      // --- slice: game switch ---
      // The map is what every screen reads; the 0.2 field follows it only for
      // Jedi Academy, because that is the only game it ever named. The first
      // run also sets `activeGame`, so the launcher opens on the game the
      // player has just set up rather than on Jedi Academy by default: a
      // player who owns Jedi Outcast alone would otherwise land on empty Jedi
      // Academy screens.
      await updateSettings.mutateAsync({
        activeGame: clientGame,
        defaultClientIds: { [clientGame]: target },
        ...(clientGame === "ja" ? { defaultClientId: target } : {}),
      });

      // A client created a moment ago is not in the list yet, and its engine
      // folder is certainly empty, so a lookup that misses means "install".
      const known = clients.data?.find((one) => one.id === target);
      if (known?.engineVersion) {
        leave();
        return;
      }

      clearInstall(target);
      await installEngine.mutateAsync({ clientId: target });
      leave();
    } catch (e) {
      if (!left.current) setError(errorText(e));
    } finally {
      if (!left.current) setWorking(false);
    }
  };

  const installFailed = error !== null && clientId !== null;
  const downloading = working && clientId !== null;

  return (
    <StepPanel
      step={2}
      heading={t("client.heading")}
      text={t("client.text")}
      error={failure}
      onBack={working ? undefined : onBack}
      footer={
        installFailed ? (
          <>
            <Button variant="ghost" onClick={leave}>
              {t("client.skipDownload")}
            </Button>
            <Button
              variant="primary"
              size="lg"
              icon={<Download size={16} />}
              onClick={() => void start()}
            >
              {tCommon("actions.retry")}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="lg"
            disabled={!canStart || working}
            onClick={() => void start()}
          >
            {downloading
              ? tCommon("states.installing")
              : working
                ? tCommon("states.creating")
                : tCommon("actions.continue")}
          </Button>
        )
      }
    >
      {downloading ? (
        <InstallPanel progress={progress} onSkip={leave} />
      ) : installFailed ? (
        <FailedPanel clientId={clientId} />
      ) : (
        <>
          <div
            className="flex flex-col gap-8"
            role="radiogroup"
            aria-label={t("client.group")}
          >
            {existing.map((client) => (
              <RadioCard
                key={client.id}
                name="onboarding-client"
                selected={choice?.kind === "existing" && choice.clientId === client.id}
                onSelect={() => setChoice({ kind: "existing", clientId: client.id })}
                title={t("client.useExisting", { client: client.name })}
                aside={
                  client.engineVersion ? (
                    <Badge tone="success" icon={<Check size={12} />}>
                      {t("client.engineReady")}
                    </Badge>
                  ) : (
                    <Badge tone="warm">{t("client.noEngine")}</Badge>
                  )
                }
              >
                <span className="block text-body-sm text-fg-muted">
                  <Trans
                    t={t}
                    i18nKey="client.existingMeta"
                    values={{
                      engine:
                        engineName(engineList, client.engineId) +
                        (client.engineVersion ? ` ${client.engineVersion}` : ""),
                      folder: client.id,
                    }}
                    components={[<span className="text-mono-xs" />]}
                  />
                </span>
              </RadioCard>
            ))}

            {engineList.map((engine) => {
              const version = versions.data?.[engine.id];
              return (
                <RadioCard
                  key={engine.id}
                  name="onboarding-client"
                  selected={choice?.kind === "engine" && choice.engineId === engine.id}
                  onSelect={() => setChoice({ kind: "engine", engineId: engine.id })}
                  disabled={!engine.installable}
                  title={engine.name}
                  aside={
                    <>
                      {engine.status.kind === "recommended" ? (
                        <Badge tone="accent">{tClients("engines.recommended")}</Badge>
                      ) : null}
                      {engine.status.kind === "legacy" ? (
                        <Badge tone="warm">{tClients("engines.legacy")}</Badge>
                      ) : null}
                      <span className="text-mono-xs text-fg-muted">
                        {version?.tag ?? t("client.latest")}
                        {version ? ` · ${format.bytes(version.assetSize)}` : ""}
                      </span>
                    </>
                  }
                >
                  <span className="block text-body-sm text-fg-muted">
                    {engine.installable
                      ? engine.description
                      : (engine.notInstallableReason ??
                        t("client.manualInstall"))}
                  </span>
                </RadioCard>
              );
            })}
          </div>

          {choice?.kind === "engine" ? (
            <div className="pt-24">
              <label
                className="block text-label-xs text-fg-muted pb-8"
                htmlFor="onboarding-client-name"
              >
                {t("client.nameLabel")}
              </label>
              <Input
                id="onboarding-client-name"
                value={name}
                maxLength={48}
                placeholder={t("client.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-body-sm text-fg-muted pt-8">
                <Trans
                  t={t}
                  i18nKey="client.nameHint"
                  values={{ folder: folderSlug(name) }}
                  components={[<span className="text-mono-sm" />]}
                />
              </p>
            </div>
          ) : null}
        </>
      )}
    </StepPanel>
  );
}

/**
 * The download, while it runs.
 *
 * The bar goes by the event rather than by the answer of the command: the
 * command answers once, at the end, and a minute of nothing in between reads
 * as a frozen launcher.
 */
function InstallPanel({
  progress,
  onSkip,
}: {
  progress: EngineInstallProgress | undefined;
  onSkip: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const format = useFormat();
  const ratio =
    progress && progress.total > 0
      ? Math.min(1, progress.downloaded / progress.total)
      : null;
  // The core writes this line and it arrives rendered; the stand-in before the
  // first event is the launcher's own.
  const message = progress?.message ?? t("client.askingGithub");

  return (
    <div className="rounded-lg border border-line bg-surface p-16">
      <div className="flex items-center justify-between gap-8">
        <span className="text-body-md-medium text-fg truncate">{message}</span>
        {progress ? (
          <span className="text-mono-xs text-fg-muted shrink-0">
            {ratio === null
              ? format.bytes(progress.downloaded)
              : `${format.bytes(progress.downloaded)} / ${format.bytes(progress.total)}`}
          </span>
        ) : null}
      </div>
      <div
        className="h-6 rounded-full bg-elevated overflow-hidden mt-12"
        role="progressbar"
        aria-label={message}
        aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: ratio === null ? "100%" : `${ratio * 100}%` }}
        />
      </div>
      <p className="text-body-sm text-fg-muted pt-12">{t("client.cacheNote")}</p>
      <Button variant="ghost" size="sm" className="mt-8 -ml-12" onClick={onSkip}>
        {t("client.continueWithoutWaiting")}
      </Button>
    </div>
  );
}

/** What is left standing after a failed download, so Retry is not a guess. */
function FailedPanel({ clientId }: { clientId: string }) {
  const { t } = useTranslation("onboarding");

  return (
    <div className="rounded-lg border border-line bg-surface p-16">
      <p className="text-body-md-medium text-fg">{t("client.failedTitle")}</p>
      <p className="text-body-sm text-fg-secondary pt-8">
        <Trans
          t={t}
          i18nKey="client.failedText"
          values={{ folder: clientId }}
          components={[<span className="text-mono-sm" />]}
        />
      </p>
    </div>
  );
}

/** Name of the engine a client runs, or its id when the registry is silent. */
function engineName(engines: Engine[], engineId: string): string {
  return engines.find((engine) => engine.id === engineId)?.name ?? engineId;
}

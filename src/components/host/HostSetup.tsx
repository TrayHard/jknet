import { ChevronDown, LogIn, Play, RefreshCw, Server, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useGametypeLabels } from "../../i18n/useGameLabels";
import { useErrorText } from "../../i18n/errors";
import { hostConfigCompatible, hostModId } from "../../lib/hostConfig";
import { cn } from "../../lib/format";
import {
  HOST_PASSWORD_PATTERN,
  newHostPassword,
  type HostClientOption,
  type HostNetwork,
  type HostOptions,
} from "../../lib/ipc";
import { useEngines, useServerConfigs, useServerConfigCheck } from "../../lib/queries";
import { EngineLogo } from "../EngineLogo";
import { Button, Input, Select, Toggle, type SelectOption } from "../ui";
import { RadioRing } from "./Choice";
import type { HostForm } from "./hostModel";
import { MapPicker } from "./MapPicker";
import { Notice } from "./Notice";
import { HostConfigBar } from "./HostConfigBar";

const MAX_PLAYERS = [2, 4, 6, 8, 10, 12, 16];
const TIME_LIMITS = [0, 10, 15, 20, 30];
const SCORE_LIMITS = [0, 5, 10, 20, 30, 50];
const BOTS = [0, 2, 4, 6, 8];
const NETWORKS: HostNetwork[] = ["internet_lan", "lan", "internet"];

interface HostSetupProps {
  options: HostOptions;
  form: HostForm;
  /**
   * Changes the form. An updater rather than a value: two changes in one
   * render — the network mode falling back to the local network while the map
   * list moves the map — each apply to the latest form instead of one
   * overwriting the other.
   */
  onChange: (update: (form: HostForm) => HostForm) => void;
  /** Signed in to JKNet Online: the relay and the invites are there. */
  signedIn: boolean;
  /** A game of this launcher runs: **Start and play** would start a second one. */
  gameRunning: boolean;
  /** A start is on its way to the core. */
  starting: boolean;
  /** The refusal of the last start, translated. */
  error: string | null;
  onStart: (joinAfterStart: boolean) => void;
  onSignIn: () => void;
}

/** The label above a control, in the uppercase of the design. */
function FieldLabel({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span id={id} className="text-label-xs text-fg-muted truncate">
      {children}
    </span>
  );
}

/**
 * The **Setup** state: the form of a private server.
 *
 * Every default comes from the core (`host_get_options`): the client, the map
 * and the network mode that fit this player, the last settings of this game
 * and a fresh password. The screen only keeps what the player changes. The
 * layout follows the Figma frame at 1280 px and folds its rows into one column
 * when the window is narrow enough to squeeze them.
 */
export function HostSetup({
  options,
  form,
  onChange,
  signedIn,
  gameRunning,
  starting,
  error,
  onStart,
  onSignIn,
}: HostSetupProps) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  const labels = useGametypeLabels();
  const engines = useEngines().data;
  const errorText = useErrorText();
  const configs = useServerConfigs();
  const documents = (configs.data ?? []).filter((document) => document.game === options.game);
  const document = documents.find((entry) => entry.id === form.settings.serverConfigId);
  const configCheck = useServerConfigCheck(document);
  const [selectingConfig, setSelectingConfig] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const settings = form.settings;
  const set = useCallback(
    (patch: Partial<HostForm["settings"]>) =>
      onChange((current) => ({ ...current, settings: { ...current.settings, ...patch } })),
    [onChange],
  );
  const onMap = useCallback((map: string) => set({ map }), [set]);

  const engineName = useCallback(
    (engineId: string) => engines?.find((engine) => engine.id === engineId)?.name ?? engineId,
    [engines],
  );

  const client: HostClientOption | undefined = options.clients.find(
    (entry) => entry.id === settings.clientId,
  );
  const mbii = hostModId(client) === "mbii";
  const gameModes = options.gametypes.filter((entry) => !mbii || [3, 4, 7].includes(entry.index)).map((entry) =>
    mbii ? { ...entry, scoreCvar: "fraglimit", defaultScore: 20 } : entry,
  );
  const gametype = gameModes.find((entry) => entry.index === settings.gametype);
  const relayAvailable = options.relay.available;
  const configProblem = configs.error ? errorText(configs.error)
    : settings.serverConfigId && !configs.isPending && !document ? t("setup.config.missing")
      : document && !hostConfigCompatible(document, client) ? t("setup.config.incompatible")
        : configCheck.error ? errorText(configCheck.error)
          : configCheck.data?.issues.length ? t("setup.config.invalid", { count: configCheck.data.issues.length }) : null;

  useEffect(() => {
    if (mbii && ![3, 4, 7].includes(settings.gametype)) set({ gametype: 7, scoreLimit: 20, bots: 0 });
  }, [mbii, settings.gametype, set]);
  useEffect(() => {
    if (mbii && settings.bots !== 0) set({ bots: 0 });
  }, [mbii, settings.bots, set]);

  // A network mode that needs the relay cannot stay chosen once the relay is
  // off the table — a sign-out on another screen, say.
  useEffect(() => {
    if (!relayAvailable && settings.network !== "lan") set({ network: "lan" });
  }, [relayAvailable, settings.network, set]);

  const clientOptions = useMemo<SelectOption[]>(
    () =>
      options.clients.map((entry) => ({
        value: entry.id,
        label: t("setup.client.option", { client: entry.name, engine: engineName(entry.engineId) }),
        disabled: !entry.canHost,
        hint:
          entry.reason === "no_dedicated_server"
            ? t("setup.client.noDedicatedServer")
            : entry.reason === "engine_missing"
              ? t("setup.client.engineMissing")
              : undefined,
        icon: <EngineLogo engineId={entry.engineId} name={engineName(entry.engineId)} size={16} />,
      })),
    [options.clients, engineName, t],
  );

  const gametypeOptions = useMemo<SelectOption[]>(
    () =>
      options.gametypes.filter((entry) => !mbii || [3, 4, 7].includes(entry.index)).map((entry) => ({
        value: String(entry.index),
        label: mbii && entry.index === 7 ? t("setup.config.mbiiMode") : labels.label(options.game, entry.index, entry.label),
      })),
    [options.gametypes, options.game, labels.label, mbii, t],
  );

  const scoreValues = useMemo(() => {
    const values = new Set(SCORE_LIMITS);
    if (gametype) values.add(gametype.defaultScore);
    values.add(settings.scoreLimit);
    return [...values].sort((a, b) => a - b);
  }, [gametype, settings.scoreLimit]);

  const passwordValid = !form.requirePassword || HOST_PASSWORD_PATTERN.test(form.password);
  const canStart =
    client !== undefined &&
    client.canHost &&
    settings.map !== "" &&
    passwordValid &&
    configProblem === null &&
    (!settings.serverConfigId || configCheck.isSuccess) &&
    !selectingConfig &&
    !starting;

  const clientBlocked =
    client !== undefined && !client.canHost
      ? client.reason === "engine_missing"
        ? t("setup.client.blockedEngineMissing", { engine: engineName(client.engineId) })
        : t("setup.client.blockedNoDedicated", { engine: engineName(client.engineId) })
      : null;

  // The note stands until the first start with the local network, signed in
  // or not: the Windows prompt comes either way.
  const showFirewall =
    options.showFirewallNote && settings.network !== "internet" && client !== undefined;

  useEffect(() => {
    if (clientBlocked || !passwordValid) setAdvancedOpen(true);
  }, [clientBlocked, passwordValid]);

  const scoreLabel = mbii
    ? t("setup.config.roundLimit")
    : gametype?.scoreCvar === "capturelimit"
      ? t("setup.scoreLimit.capture")
      : t("setup.scoreLimit.frag");
  const modeName = gametype
    ? mbii && gametype.index === 7
      ? t("setup.config.mbiiMode")
      : labels.label(options.game, gametype.index, gametype.label)
    : "";

  return (
    <div className="@container flex flex-col gap-12">
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex flex-col gap-14 p-16">
          <div className="flex flex-col gap-2">
            <h2 className="text-heading-sm text-fg">{t("setup.sections.match")}</h2>
            <p className="text-body-sm text-fg-muted">{t("setup.sections.matchHint")}</p>
          </div>
          <HostConfigBar game={options.game} documents={documents} client={client} form={form}
            onChange={onChange} onSelecting={setSelectingConfig} problem={configProblem} loading={configs.isLoading} scoreCvar={gametype?.scoreCvar ?? null} />
          <div className="grid grid-cols-1 gap-12 @min-[560px]:grid-cols-[minmax(220px,2fr)_minmax(132px,1fr)_minmax(112px,0.65fr)]">
            <div className="flex flex-col gap-6 min-w-0">
              <FieldLabel>{t("setup.map.label")}</FieldLabel>
              <MapPicker
                game={options.game}
                gametypes={options.gametypes}
                clientId={settings.clientId === "" ? null : settings.clientId}
                value={settings.map}
                onChange={onMap}
                preferred={options.defaults.map}
                className="w-full"
                preserveSelection={!!settings.serverConfigId}
                share
              />
            </div>
            <SelectField label={t("setup.gametype.label")}>
              <Select
                value={String(settings.gametype)}
                onChange={(value) => {
                  const index = Number(value);
                  const next = gameModes.find((entry) => entry.index === index);
                  set({ gametype: index, scoreLimit: next?.defaultScore ?? settings.scoreLimit });
                }}
                options={gametypeOptions}
                ariaLabel={t("setup.gametype.label")}
                className="w-full h-52"
              />
            </SelectField>
            <SelectField label={t("setup.maxPlayers.label")}>
              <Select
                value={String(settings.maxPlayers)}
                onChange={(value) => set({ maxPlayers: Number(value) })}
                options={[...new Set([...MAX_PLAYERS, settings.maxPlayers])].sort((a, b) => a - b).map((count) => ({ value: String(count), label: String(count) }))}
                ariaLabel={t("setup.maxPlayers.label")}
                className="w-full h-52"
              />
            </SelectField>
          </div>
        </div>

        <div className="border-t border-line-subtle">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center gap-12 px-16 py-12 text-left cursor-pointer select-none hover:bg-hover-overlay"
          >
            <Settings2 size={16} aria-hidden className="shrink-0 text-fg-muted" />
            <span className="flex-1 min-w-0 flex flex-col gap-2">
              <span className="text-body-md-medium text-fg">{t("setup.sections.advanced")}</span>
              <span className="truncate text-body-sm text-fg-muted">
                {t("setup.sections.advancedSummary", {
                  client: client?.name ?? t("setup.client.label"),
                  score: gametype?.scoreCvar ? `${scoreLabel}: ${settings.scoreLimit || t("setup.noLimit")}` : t("setup.noLimit"),
                  time: settings.timeLimit ? tCommon("units.minutes", { value: settings.timeLimit }) : t("setup.noLimit"),
                  network: t(`setup.network.${settings.network}.title`),
                  password: t(form.requirePassword ? "setup.sections.passwordOn" : "setup.sections.passwordOff"),
                  access: t(`policy.${settings.joinPolicy}`),
                })}
              </span>
            </span>
            <ChevronDown size={16} aria-hidden className={cn("shrink-0 text-fg-muted transition-transform", advancedOpen && "rotate-180")} />
          </button>

          {advancedOpen ? (
            <div className="flex flex-col gap-18 border-t border-line-subtle px-16 py-16">
              <SetupGroup title={t("setup.sections.client")}>
                <div className="flex flex-col gap-6 min-w-0">
                  <Select
                    value={settings.clientId}
                    onChange={(clientId) => set({ clientId, serverConfigId: null })}
                    options={clientOptions}
                    ariaLabel={t("setup.client.label")}
                    placeholder={t("setup.client.label")}
                    className="w-full"
                  />
                  <p className="text-body-sm text-fg-muted">{t("setup.client.hint")}</p>
                  {clientBlocked ? <p className="text-body-sm text-fg-danger">{clientBlocked}</p> : null}
                </div>
              </SetupGroup>

              <SetupGroup title={t("setup.sections.rules")}>
                <div className="grid grid-cols-2 gap-12 @min-[560px]:grid-cols-3">
                  <SelectField label={t("setup.timeLimit.label")}>
                    <Select
                      value={String(settings.timeLimit)}
                      onChange={(value) => set({ timeLimit: Number(value) })}
                      options={[...new Set([...TIME_LIMITS, settings.timeLimit])].sort((a, b) => a - b).map((minutes) => ({
                        value: String(minutes),
                        label: minutes === 0 ? t("setup.noLimit") : tCommon("units.minutes", { value: minutes }),
                      }))}
                      ariaLabel={t("setup.timeLimit.label")}
                      className="w-full"
                    />
                  </SelectField>
                  {gametype?.scoreCvar ? (
                    <SelectField label={scoreLabel}>
                      <Select
                        value={String(settings.scoreLimit)}
                        onChange={(value) => set({ scoreLimit: Number(value) })}
                        options={scoreValues.map((score) => ({ value: String(score), label: score === 0 ? t("setup.noLimit") : String(score) }))}
                        ariaLabel={scoreLabel}
                        className="w-full"
                      />
                    </SelectField>
                  ) : null}
                  {!mbii ? (
                    <SelectField label={t("setup.bots.label")}>
                      <Select
                        value={String(settings.bots)}
                        onChange={(value) => set({ bots: Number(value) })}
                        options={[...new Set([...BOTS, settings.bots])].sort((a, b) => a - b).map((count) => ({
                          value: String(count),
                          label: count === 0 ? t("setup.bots.off") : t("setup.bots.fill", { count }),
                        }))}
                        ariaLabel={t("setup.bots.label")}
                        className="w-full"
                      />
                    </SelectField>
                  ) : null}
                </div>
              </SetupGroup>

              <SetupGroup title={t("setup.sections.server")}>
                <div className="grid grid-cols-1 gap-12 @min-[900px]:grid-cols-2">
                  <div className="flex flex-col gap-6 min-w-0">
                    <FieldLabel>{t("setup.serverName.label")}</FieldLabel>
                    <Input value={settings.serverName} maxLength={32} spellCheck={false}
                      aria-label={t("setup.serverName.label")} placeholder={options.defaults.serverName}
                      onChange={(event) => set({ serverName: event.target.value })} />
                  </div>
                  <div className="flex flex-col gap-6 min-w-0">
                    <FieldLabel>{t("setup.password.label")}</FieldLabel>
                    <div className="flex min-h-36 items-center gap-8">
                      <Toggle checked={form.requirePassword}
                        onChange={(requirePassword) => onChange((current) => ({ ...current, requirePassword }))}
                        label={t("setup.password.require")} />
                      <span className="text-body-sm text-fg-secondary whitespace-nowrap">{t("setup.password.require")}</span>
                      <Input value={form.password} maxLength={24} spellCheck={false} autoComplete="off"
                        disabled={!form.requirePassword} invalid={!passwordValid} aria-label={t("setup.password.label")}
                        onChange={(event) => onChange((current) => ({ ...current, password: event.target.value }))}
                        className="flex-1 min-w-0 [&_input]:font-mono [&_input]:text-[13px]" />
                      <Button icon={<RefreshCw size={16} />} disabled={!form.requirePassword}
                        onClick={() => onChange((current) => ({ ...current, password: newHostPassword() }))}>
                        {t("setup.password.new")}
                      </Button>
                    </div>
                    {!passwordValid ? <p className="text-body-sm text-fg-danger">{t("setup.password.invalid")}</p> : null}
                  </div>
                </div>
              </SetupGroup>

              <SetupGroup title={t("setup.network.label")}>
                <div
                  role="radiogroup"
                  aria-label={t("setup.network.label")}
                  className="grid grid-cols-1 gap-2 rounded-md border border-line bg-input p-4 @min-[600px]:grid-cols-3"
                >
                  {NETWORKS.map((network) => (
                    <label
                      key={network}
                      className={cn(
                        "flex min-w-0 items-center gap-8 rounded-sm px-10 py-8 select-none transition-colors",
                        network !== "lan" && !relayAvailable
                          ? "cursor-not-allowed opacity-50"
                          : "cursor-pointer hover:bg-hover-overlay",
                        settings.network === network && "bg-selected-overlay text-fg-accent",
                      )}
                    >
                      <input
                        type="radio"
                        name="host-network"
                        checked={settings.network === network}
                        disabled={network !== "lan" && !relayAvailable}
                        onChange={() => set({ network })}
                        className="sr-only"
                      />
                      <RadioRing checked={settings.network === network} />
                      <span className="min-w-0 text-body-sm-medium text-fg">{t(`setup.network.${network}.title`)}</span>
                    </label>
                  ))}
                </div>
                <p className="text-body-sm text-fg-muted">{t(`setup.network.${settings.network}.text`)}</p>
              </SetupGroup>
            </div>
          ) : null}
        </div>
      </section>

      {!signedIn && options.relay.reason === "signed_out" ? (
        <Notice tone="info" action={<Button size="sm" icon={<LogIn size={14} />} onClick={onSignIn}>{t("setup.signIn.action")}</Button>}>
          {t("setup.signIn.text")}
        </Notice>
      ) : null}
      {showFirewall && client ? <Notice tone="warm">{t("setup.firewall", { engine: engineName(client.engineId) })}</Notice> : null}

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-12 rounded-lg border border-line bg-elevated p-12 shadow-popover">
        <div className="flex-1 min-w-200 flex flex-col gap-2">
          <span className="text-mono-sm text-fg truncate">{settings.map}</span>
          <span className="text-body-sm text-fg-muted truncate">
            {t("setup.sections.launchSummary", { mode: modeName, count: settings.maxPlayers, client: client?.name ?? "" })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-8">
          <Button size="lg" icon={<Server size={20} />} disabled={!canStart} onClick={() => onStart(false)}>
            {t("setup.startServer")}
          </Button>
          <Button variant="primary" size="lg" icon={<Play size={20} />} disabled={!canStart || gameRunning}
            title={gameRunning ? t("setup.stopGameFirst") : undefined} onClick={() => onStart(true)}>
            {starting ? tCommon("states.starting") : t("setup.startAndPlay")}
          </Button>
        </div>
      </div>
      {gameRunning ? (
        <p className="text-body-sm text-fg-muted">{t("setup.stopGameFirst")}</p>
      ) : null}
      {error ? <p className="text-body-sm text-fg-danger">{error}</p> : null}
    </div>
  );
}

/** One of the five selects of the match row: 112 px at least, sharing the rest. */
function SelectField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 min-w-0">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

function SetupGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-10">
      <h3 className="text-label-xs text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

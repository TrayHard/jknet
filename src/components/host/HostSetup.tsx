import { LogIn, Play, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useGametypeLabels } from "../../i18n/useGameLabels";
import { cn } from "../../lib/format";
import {
  HOST_PASSWORD_PATTERN,
  newHostPassword,
  type HostClientOption,
  type HostNetwork,
  type HostOptions,
} from "../../lib/ipc";
import { useEngines } from "../../lib/queries";
import { EngineLogo } from "../EngineLogo";
import { Button, Input, RadioCard, Select, Toggle, type SelectOption } from "../ui";
import type { HostForm } from "./hostModel";
import { MapPicker } from "./MapPicker";
import { Notice } from "./Notice";

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
  const gametype = options.gametypes.find((entry) => entry.index === settings.gametype);
  const relayAvailable = options.relay.available;

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
      options.gametypes.map((entry) => ({
        value: String(entry.index),
        label: labels.label(options.game, entry.index, entry.label),
      })),
    [options.gametypes, options.game, labels.label],
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

  return (
    <div className="@container flex flex-col gap-12">
      {/* Client and map. */}
      <div className="grid grid-cols-1 gap-12 @min-[560px]:grid-cols-2 @min-[560px]:gap-16">
        <div className="flex flex-col gap-6 min-w-0">
          <FieldLabel>{t("setup.client.label")}</FieldLabel>
          <Select
            value={settings.clientId}
            onChange={(clientId) => set({ clientId })}
            options={clientOptions}
            ariaLabel={t("setup.client.label")}
            placeholder={t("setup.client.label")}
            className="w-full"
          />
          <p className={cn("text-body-sm", clientBlocked ? "text-fg-danger" : "text-fg-muted")}>
            {clientBlocked ?? t("setup.client.hint")}
          </p>
        </div>
        <div className="flex flex-col gap-6 min-w-0">
          <FieldLabel>{t("setup.map.label")}</FieldLabel>
          <MapPicker
            clientId={settings.clientId === "" ? null : settings.clientId}
            gametype={settings.gametype}
            value={settings.map}
            onChange={onMap}
            preferred={options.defaults.map}
            className="w-full"
            shareGame={options.game}
          />
        </div>
      </div>

      {/* The match: five selects, the bots hint under the last one. */}
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-12">
          <SelectField label={t("setup.gametype.label")}>
            <Select
              value={String(settings.gametype)}
              onChange={(value) => {
                const index = Number(value);
                const next = options.gametypes.find((entry) => entry.index === index);
                set({ gametype: index, scoreLimit: next?.defaultScore ?? settings.scoreLimit });
              }}
              options={gametypeOptions}
              ariaLabel={t("setup.gametype.label")}
              className="w-full"
            />
          </SelectField>
          <SelectField label={t("setup.maxPlayers.label")}>
            <Select
              value={String(settings.maxPlayers)}
              onChange={(value) => set({ maxPlayers: Number(value) })}
              options={MAX_PLAYERS.map((count) => ({ value: String(count), label: String(count) }))}
              ariaLabel={t("setup.maxPlayers.label")}
              className="w-full"
            />
          </SelectField>
          <SelectField label={t("setup.timeLimit.label")}>
            <Select
              value={String(settings.timeLimit)}
              onChange={(value) => set({ timeLimit: Number(value) })}
              options={TIME_LIMITS.map((minutes) => ({
                value: String(minutes),
                label: minutes === 0 ? t("setup.noLimit") : tCommon("units.minutes", { value: minutes }),
              }))}
              ariaLabel={t("setup.timeLimit.label")}
              className="w-full"
            />
          </SelectField>
          {gametype?.scoreCvar ? (
            <SelectField
              label={
                gametype.scoreCvar === "capturelimit"
                  ? t("setup.scoreLimit.capture")
                  : t("setup.scoreLimit.frag")
              }
            >
              <Select
                value={String(settings.scoreLimit)}
                onChange={(value) => set({ scoreLimit: Number(value) })}
                options={scoreValues.map((score) => ({
                  value: String(score),
                  label: score === 0 ? t("setup.noLimit") : String(score),
                }))}
                ariaLabel={
                  gametype.scoreCvar === "capturelimit"
                    ? t("setup.scoreLimit.capture")
                    : t("setup.scoreLimit.frag")
                }
                className="w-full"
              />
            </SelectField>
          ) : null}
          <SelectField label={t("setup.bots.label")}>
            <Select
              value={String(settings.bots)}
              onChange={(value) => set({ bots: Number(value) })}
              options={BOTS.map((count) => ({
                value: String(count),
                label: count === 0 ? t("setup.bots.off") : t("setup.bots.fill", { count }),
              }))}
              ariaLabel={t("setup.bots.label")}
              className="w-full"
            />
          </SelectField>
        </div>
        <p className="text-body-sm text-fg-muted text-right">{t("setup.bots.hint")}</p>
      </div>

      {/* Name and password. */}
      <div className="grid grid-cols-1 gap-12 @min-[560px]:grid-cols-2 @min-[560px]:gap-16">
        <div className="flex flex-col gap-6 min-w-0">
          <div className="flex items-center h-24">
            <FieldLabel>{t("setup.serverName.label")}</FieldLabel>
          </div>
          <Input
            value={settings.serverName}
            maxLength={32}
            spellCheck={false}
            aria-label={t("setup.serverName.label")}
            placeholder={options.defaults.serverName}
            onChange={(event) => set({ serverName: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-6 min-w-0">
          <div className="flex items-center gap-8 h-24">
            <span className="flex-1 min-w-0 flex">
              <FieldLabel>{t("setup.password.label")}</FieldLabel>
            </span>
            <Toggle
              checked={form.requirePassword}
              onChange={(requirePassword) => onChange((current) => ({ ...current, requirePassword }))}
              label={t("setup.password.require")}
            />
            <span className="text-body-sm text-fg-secondary whitespace-nowrap">
              {t("setup.password.require")}
            </span>
          </div>
          <div className="flex items-center gap-8">
            <Input
              value={form.password}
              maxLength={24}
              spellCheck={false}
              autoComplete="off"
              disabled={!form.requirePassword}
              invalid={!passwordValid}
              aria-label={t("setup.password.label")}
              onChange={(event) => {
                const password = event.target.value;
                onChange((current) => ({ ...current, password }));
              }}
              className="flex-1 min-w-0 [&_input]:font-mono [&_input]:text-[13px]"
            />
            <Button
              icon={<RefreshCw size={16} />}
              disabled={!form.requirePassword}
              onClick={() => {
                const password = newHostPassword();
                onChange((current) => ({ ...current, password }));
              }}
            >
              {t("setup.password.new")}
            </Button>
          </div>
          <p className={cn("text-body-sm", passwordValid ? "text-fg-muted" : "text-fg-danger")}>
            {passwordValid ? t("setup.password.hint") : t("setup.password.invalid")}
          </p>
        </div>
      </div>

      {/* Who can connect. */}
      <div className="flex flex-col gap-6">
        <FieldLabel>{t("setup.network.label")}</FieldLabel>
        <div className="grid grid-cols-1 gap-8 @min-[600px]:grid-cols-3">
          {NETWORKS.map((network) => (
            <RadioCard
              key={network}
              name="host-network"
              selected={settings.network === network}
              onSelect={() => set({ network })}
              disabled={network !== "lan" && !relayAvailable}
              title={t(`setup.network.${network}.title`)}
              className="justify-start"
            >
              <span className="block text-body-sm text-fg-secondary">
                {t(`setup.network.${network}.text`)}
              </span>
            </RadioCard>
          ))}
        </div>
      </div>

      {!signedIn && options.relay.reason === "signed_out" ? (
        <Notice
          tone="info"
          action={
            <Button size="sm" icon={<LogIn size={14} />} onClick={onSignIn}>
              {t("setup.signIn.action")}
            </Button>
          }
        >
          {t("setup.signIn.text")}
        </Notice>
      ) : null}
      {showFirewall && client ? (
        <Notice tone="warm">{t("setup.firewall", { engine: engineName(client.engineId) })}</Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-8">
        <Button
          variant="primary"
          size="lg"
          icon={<Play size={20} />}
          disabled={!canStart || gameRunning}
          title={gameRunning ? t("setup.stopGameFirst") : undefined}
          onClick={() => onStart(true)}
        >
          {starting ? tCommon("states.starting") : t("setup.startAndPlay")}
        </Button>
        <Button
          size="lg"
          icon={<Server size={20} />}
          disabled={!canStart}
          onClick={() => onStart(false)}
        >
          {t("setup.startServer")}
        </Button>
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
    <div className="flex flex-col gap-6 flex-1 basis-0 min-w-112">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

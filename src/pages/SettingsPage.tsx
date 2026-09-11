import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Compass,
  FolderOpen,
  Languages,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import { AboutCard } from "../components/AboutCard";
// --- slice: library cleanup ---
import { JkhubCatalogCard } from "../components/JkhubCatalogCard";
import { MapPicturesCard } from "../components/MapPicturesCard";
// --- slice: account ---
import { AccountCard, ACCOUNT_SECTION_ID } from "../components/account/AccountCard";
import { Page, PageHeader } from "../components/PageHeader";
import { Button, EmptyState, Input, Select } from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import {
  LANGUAGES,
  isLanguageSetting,
  resolveLanguage,
  translationStateOf,
} from "../i18n";
import { useSystemLocale } from "../i18n/useSystemLocale";
import { ipc, type GameInfo } from "../lib/ipc";
// --- slice: game switch ---
import { findDefaultClient } from "../lib/game";
import {
  useClients,
  useDataPaths,
  useGames,
  useSettings,
  useUpdateSettings,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { ONBOARDING_ROUTE } from "./onboarding/OnboardingGate";

/**
 * Settings: the data folder and the launch arguments.
 *
 * The rest of the design — Downloads, Appearance, Account — arrives with the
 * features it controls. These two are here because they are the settings a
 * player needs before anything else works, and because a support answer often
 * starts with "open that folder and send me the log".
 */
export function SettingsPage() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const dataPaths = useDataPaths();
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  // --- slice: account ---
  // The sidebar's user block links to `#/settings?section=account`, so the
  // card the player asked for is the one they land on.
  const [search] = useSearchParams();
  const section = search.get("section");
  useEffect(() => {
    if (section !== "account") return;
    document
      .getElementById(ACCOUNT_SECTION_ID)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [section]);

  const dataRoot = dataPaths.data?.dataRoot ?? null;
  const failure =
    error ??
    (dataPaths.error
      ? errorText(dataPaths.error)
      : settings.error
        ? errorText(settings.error)
        : null);

  /** Hands the folder to the file manager. Scoped to `$LOCALDATA/JKNet` in
   * `capabilities/default.json`, so a data folder moved elsewhere reports
   * a forbidden path instead of opening. */
  const openDataFolder = () => {
    if (!dataRoot || !isTauri()) return;
    setError(null);
    openPath(dataRoot).catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      {/* --- slice: i18n --- first card of the screen: a player who cannot
          read the rest of it has to be able to find this one. */}
      <LanguageCard onError={setError} />

      <section className="flex items-start gap-16 rounded-lg border border-line bg-surface p-16 mb-24">
        <div className="flex-1 min-w-0">
          <h2 className="text-heading-sm text-fg pb-4">{t("dataFolder.title")}</h2>
          <p className="text-body-sm text-fg-secondary pb-8">
            {t("dataFolder.text")}
          </p>
          <p className="text-mono-sm text-fg-accent break-all">
            {dataRoot ??
              (dataPaths.isLoading
                ? tCommon("states.reading")
                : tCommon("values.unknown"))}
          </p>
        </div>
        <Button
          icon={<FolderOpen size={16} />}
          disabled={!dataRoot || !isTauri()}
          onClick={openDataFolder}
        >
          {t("dataFolder.open")}
        </Button>
      </section>

      {/* --- slice: game core --- */}
      <GameFilesCard onError={setError} />

      <ExtraLaunchArgs onError={setError} />

      {/* --- slice: maps --- */}
      <MapPicturesCard />

      {/* --- slice: library cleanup --- */}
      <JkhubCatalogCard />

      {/* --- slice: account --- */}
      <AccountCard />

      <EmptyState
        icon={<SlidersHorizontal size={24} />}
        title={t("rest.title")}
        text={t("rest.text")}
        className="mb-24"
      />

      {/* --- slice: installer --- */}
      <AboutCard />
    </Page>
  );
}

// --- slice: i18n ---
/**
 * The Language card: which language the launcher speaks.
 *
 * Every option is written in its own language. A player looking for Polish
 * reads «Polski», not «Polish» in a language they cannot read — which is also
 * why the card is the first one on the screen and why its options are never
 * translated.
 *
 * «System language» names the language it would pick, so the row answers «and
 * what is that» without a second click. Switching applies at once: the patch
 * answers with the settings document, `LanguageSync` sees the new value and
 * loads the catalog.
 */
function LanguageCard({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation("settings");
  const errorText = useErrorText();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const systemLocale = useSystemLocale();

  const stored = settings.data?.language ?? "system";
  const fromSystem = resolveLanguage("system", systemLocale);
  const systemName =
    LANGUAGES.find((entry) => entry.id === fromSystem)?.nativeName ?? fromSystem;

  const options = [
    { value: "system", label: t("language.systemWith", { language: systemName }) },
    ...LANGUAGES.map((entry) => ({ value: entry.id, label: entry.nativeName })),
  ];

  const active = resolveLanguage(stored, systemLocale);
  // The hint comes out of `src/locales/<language>/_status.json`, never out of a
  // list of language ids here: a folder that names a reviewer stops warning
  // about itself in the same edit that records them, and a folder somebody adds
  // tomorrow gets the right sentence without this file being found and changed.
  const state = translationStateOf(active);
  const hint =
    state === "draft"
      ? t("language.draft")
      : state === "untranslated"
        ? t("language.needsTranslation")
        : null;

  const save = (value: string) => {
    if (!isLanguageSetting(value) || value === stored) return;
    updateSettings.mutate(
      { language: value },
      { onError: (e) => onError(errorText(e)) },
    );
  };

  return (
    <section className="flex items-start gap-16 rounded-lg border border-line bg-surface p-16 mb-24">
      <span className="flex items-center justify-center size-36 rounded-md bg-elevated text-fg-secondary shrink-0">
        <Languages size={20} />
      </span>
      <div className="flex-1 min-w-0">
        <h2 className="text-heading-sm text-fg pb-4">{t("language.title")}</h2>
        <p className="text-body-sm text-fg-secondary">{t("language.text")}</p>
        {hint === null ? null : (
          <p className="text-body-sm text-fg-warm pt-8">{hint}</p>
        )}
      </div>
      <Select
        ariaLabel={t("language.label")}
        options={options}
        value={stored}
        disabled={settings.data === undefined || updateSettings.isPending}
        onChange={save}
        // Wide enough for «Язык системы (English)», which is the longest
        // option any language produces: the system entry names the language
        // it would pick, in that language.
        className="w-240 shrink-0"
      />
    </section>
  );
}

// --- slice: game core ---
/**
 * The Game files card: one row per game.
 *
 * Two games, two folders, and a player who owns one of them has an empty row
 * for the other one. The row that is empty carries a **Locate** button; the
 * one that is filled carries **Change**, and both save the game they belong to
 * alone, so setting up Jedi Outcast cannot clear a Jedi Academy folder.
 */
function GameFilesCard({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const settings = useSettings();
  const games = useGames();
  const updateSettings = useUpdateSettings();
  // --- slice: game switch ---
  // The row also answers «what starts when I press Play in this game», which
  // is the second half of setting a game up and the question the Home screen
  // of an unfamiliar game raises.
  const clients = useClients();

  /** Asks for a folder, checks it against this game and saves it. */
  const locate = async (game: GameInfo) => {
    if (!isTauri()) {
      onError(tCommon("runtime.missing"));
      return;
    }
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: t("gameFiles.pickTitle", { game: game.displayName }),
      });
      if (typeof picked !== "string") return;
      const candidate = await ipc.validateGameData(game.id, picked);
      if (!candidate.valid) {
        const missing = candidate.assets
          .filter((asset) => asset.required && !asset.present)
          .map((asset) => asset.name)
          .join(", ");
        onError(
          t("gameFiles.invalid", {
            game: game.displayName,
            path: candidate.path,
            missing,
          }),
        );
        return;
      }
      // One game per patch: the other row keeps whatever it holds.
      updateSettings.mutate(
        { gameDataPaths: { [game.id]: candidate.path } },
        { onError: (e) => onError(errorText(e)) },
      );
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">{t("gameFiles.title")}</h2>
      <p className="text-body-sm text-fg-secondary pb-8">{t("gameFiles.text")}</p>

      <ul className="flex flex-col gap-8 pt-8">
        {(games.data ?? []).map((game) => {
          const path = settings.data?.gameDataPaths[game.id] ?? null;
          // --- slice: game switch ---
          const defaultClient = findDefaultClient(
            clients.data,
            settings.data,
            game.id,
          );
          return (
            <li
              key={game.id}
              className="flex items-center gap-16 rounded-md border border-line bg-input p-12"
            >
              <span className="flex-1 min-w-0 flex flex-col">
                <span className="text-body-md-medium text-fg">
                  {t("gameFiles.row", { game: game.displayName })}
                </span>
                <span className="text-mono-sm text-fg-accent break-all">
                  {path ?? tCommon("values.notSet")}
                </span>
                <span className="text-body-sm text-fg-muted pt-2">
                  {defaultClient
                    ? t("gameFiles.playStarts", { client: defaultClient.name })
                    : t("gameFiles.noDefault")}
                </span>
              </span>
              <Button
                icon={<FolderOpen size={16} />}
                disabled={updateSettings.isPending}
                onClick={() => void locate(game)}
              >
                {path ? t("gameFiles.change") : t("gameFiles.locate")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The Launch card: tokens appended to the command line of every client.
 *
 * The field saves on blur, and Enter blurs it, so one edit is one write. The
 * patch carries this field alone: the document on disk may hold values the
 * launcher has not read back, and sending the whole thing would erase them.
 */
function ExtraLaunchArgs({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  const stored = settings.data?.extraLaunchArgs ?? "";
  const [value, setValue] = useState(stored);

  // Follow the stored value: it arrives one render after the screen mounts,
  // and a save elsewhere in the launcher changes it too.
  useEffect(() => setValue(stored), [stored]);

  const save = () => {
    const next = value.trim();
    if (settings.data === undefined || next === stored) return;
    updateSettings.mutate(
      { extraLaunchArgs: next },
      { onError: (e) => onError(errorText(e)) },
    );
  };

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">{t("launch.title")}</h2>
      <label
        className="block text-label-xs text-fg-muted pt-12 pb-8"
        htmlFor="extra-launch-args"
      >
        {t("launch.label")}
      </label>
      <Input
        id="extra-launch-args"
        value={value}
        placeholder={t("launch.placeholder")}
        disabled={settings.data === undefined}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        // Enter takes the focus away, which runs the same save as a click
        // outside does. One edit stays one write.
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <p className="text-body-sm text-fg-secondary pt-8">
        <Trans
          t={t}
          i18nKey="launch.hint"
          components={[<span className="text-mono-sm" />]}
        />
      </p>
      {/* --- slice: client launch args ---
          A key of its own rather than a longer `launch.hint`: the six machine
          drafts are filled from English by `npm run i18n:seed`, which adds a
          key and never rewrites a value that is already translated. */}
      <p className="text-body-sm text-fg-secondary pt-4">
        <Trans
          t={t}
          i18nKey="launch.order"
          components={[<span className="text-mono-sm" />]}
        />
      </p>
      {updateSettings.isPending ? (
        <p className="text-body-sm text-fg-muted pt-4">{tCommon("states.saving")}</p>
      ) : null}

      <RerunOnboarding onError={onError} />
    </section>
  );
}

/**
 * Takes the player back through the three first-run steps.
 *
 * Clearing the flag is enough: the steps themselves are derived from what is
 * configured, so a setup that is already done opens on the account step rather
 * than asking again for a game folder that has not moved. Nothing is deleted.
 */
function RerunOnboarding({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation("settings");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const updateSettings = useUpdateSettings();

  const rerun = () => {
    updateSettings.mutate(
      { onboardingCompleted: false },
      {
        onSuccess: () => void navigate(ONBOARDING_ROUTE),
        onError: (e) => onError(errorText(e)),
      },
    );
  };

  return (
    <div className="flex items-start justify-between gap-16 border-t border-line-subtle mt-16 pt-16">
      <span className="flex flex-col">
        <span className="text-body-md-medium text-fg">
          {t("onboarding.title")}
        </span>
        <span className="text-body-sm text-fg-muted">{t("onboarding.text")}</span>
      </span>
      <Button
        variant="ghost"
        icon={<Compass size={16} />}
        disabled={updateSettings.isPending}
        onClick={rerun}
      >
        {t("onboarding.action")}
      </Button>
    </div>
  );
}

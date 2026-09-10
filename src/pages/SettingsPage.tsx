import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Compass,
  FolderOpen,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { AboutCard } from "../components/AboutCard";
import { MapPicturesCard } from "../components/MapPicturesCard";
// --- slice: account ---
import { AccountCard, ACCOUNT_SECTION_ID } from "../components/account/AccountCard";
import { Page, PageHeader } from "../components/PageHeader";
import { Button, EmptyState, Input } from "../components/ui";
import { errorMessage, ipc, type GameInfo } from "../lib/ipc";
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
      ? errorMessage(dataPaths.error)
      : settings.error
        ? errorMessage(settings.error)
        : null);

  /** Hands the folder to the file manager. Scoped to `$LOCALDATA/JKNet` in
   * `capabilities/default.json`, so a data folder moved elsewhere reports
   * a forbidden path instead of opening. */
  const openDataFolder = () => {
    if (!dataRoot || !isTauri()) return;
    setError(null);
    openPath(dataRoot).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <Page>
      <PageHeader
        title="Settings"
        subtitle="Launch, downloads, appearance and account."
      />

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      <section className="flex items-start gap-16 rounded-lg border border-line bg-surface p-16 mb-24">
        <div className="flex-1 min-w-0">
          <h2 className="text-heading-sm text-fg pb-4">Data folder</h2>
          <p className="text-body-sm text-fg-secondary pb-8">
            Clients, library and logs live here.
          </p>
          <p className="text-mono-sm text-fg-accent break-all">
            {dataRoot ?? (dataPaths.isLoading ? "Reading…" : "Unknown")}
          </p>
        </div>
        <Button
          icon={<FolderOpen size={16} />}
          disabled={!dataRoot || !isTauri()}
          onClick={openDataFolder}
        >
          Open JKNet folder
        </Button>
      </section>

      {/* --- slice: game core --- */}
      <GameFilesCard onError={setError} />

      <ExtraLaunchArgs onError={setError} />

      {/* --- slice: maps --- */}
      <MapPicturesCard />

      {/* --- slice: account --- */}
      <AccountCard />

      <EmptyState
        icon={<SlidersHorizontal size={24} />}
        title="The rest of the settings is not wired up yet"
        text="The Downloads and Appearance sections arrive together with the features they control."
        className="mb-24"
      />

      {/* --- slice: installer --- */}
      <AboutCard />
    </Page>
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
      onError("Tauri runtime is not available");
      return;
    }
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: `Select the ${game.displayName} GameData folder`,
      });
      if (typeof picked !== "string") return;
      const candidate = await ipc.validateGameData(game.id, picked);
      if (!candidate.valid) {
        const missing = candidate.assets
          .filter((asset) => asset.required && !asset.present)
          .map((asset) => asset.name)
          .join(", ");
        onError(`No ${game.displayName} files in ${candidate.path}. Missing: ${missing}.`);
        return;
      }
      // One game per patch: the other row keeps whatever it holds.
      updateSettings.mutate(
        { gameDataPaths: { [game.id]: candidate.path } },
        { onError: (e) => onError(errorMessage(e)) },
      );
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">Game files</h2>
      <p className="text-body-sm text-fg-secondary pb-8">
        JKNet reads the archives in these folders and writes nothing into them.
        One game is enough; set up the other whenever you like.
      </p>

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
                  {game.displayName} files
                </span>
                <span className="text-mono-sm text-fg-accent break-all">
                  {path ?? "Not set"}
                </span>
                <span className="text-body-sm text-fg-muted pt-2">
                  {defaultClient
                    ? `Play starts ${defaultClient.name}`
                    : "No default client yet"}
                </span>
              </span>
              <Button
                icon={<FolderOpen size={16} />}
                disabled={updateSettings.isPending}
                onClick={() => void locate(game)}
              >
                {path ? "Change" : "Locate"}
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
      { onError: (e) => onError(errorMessage(e)) },
    );
  };

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">Launch</h2>
      <label
        className="block text-label-xs text-fg-muted pt-12 pb-8"
        htmlFor="extra-launch-args"
      >
        Extra launch arguments
      </label>
      <Input
        id="extra-launch-args"
        value={value}
        placeholder="+set r_fullscreen 0 +set r_mode 4"
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
        Appended to every client, exactly as in a shortcut. Example:{" "}
        <span className="text-mono-sm">+set r_fullscreen 0 +set r_mode 4</span>.
        Double quotes keep a value with a space together.
      </p>
      {updateSettings.isPending ? (
        <p className="text-body-sm text-fg-muted pt-4">Saving…</p>
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
  const navigate = useNavigate();
  const updateSettings = useUpdateSettings();

  const rerun = () => {
    updateSettings.mutate(
      { onboardingCompleted: false },
      {
        onSuccess: () => void navigate(ONBOARDING_ROUTE),
        onError: (e) => onError(errorMessage(e)),
      },
    );
  };

  return (
    <div className="flex items-start justify-between gap-16 border-t border-line-subtle mt-16 pt-16">
      <span className="flex flex-col">
        <span className="text-body-md-medium text-fg">First-time setup</span>
        <span className="text-body-sm text-fg-muted">
          Walks through game files, a client and an account again. Nothing you
          have set up is removed.
        </span>
      </span>
      <Button
        variant="ghost"
        icon={<Compass size={16} />}
        disabled={updateSettings.isPending}
        onClick={rerun}
      >
        Run first-time setup again
      </Button>
    </div>
  );
}

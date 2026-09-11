import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useParams } from "react-router";

import { ClientEngineRow } from "../components/client/ClientEngineRow";
import { CommandPreview } from "../components/client/CommandPreview";
import {
  CvarField,
  CvarSelect,
  CvarSlider,
  SettingRow,
} from "../components/client/CvarControls";
import {
  useCvarEditor,
  type WindowCvar,
} from "../components/client/useCvarEditor";
import { TitleBar } from "../components/TitleBar";
import type { SelectOption } from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { cn } from "../lib/format";
import type { Client } from "../lib/ipc";
import { useClient, useEngines, useUpdateClient } from "../lib/queries";
import { isTauri } from "../lib/runtime";

/**
 * The window that edits one client, at `#/client/<id>`.
 *
 * It is a window and not a dialog because of how much of a client there is to
 * see: the build and its version, the mod folder, the video mode, the volumes,
 * the player name, the frame and network limits, the raw argument line and the
 * command line all of that adds up to. A dialog that size covers the screen it
 * belongs to; a window leaves the launcher usable behind it.
 *
 * Every control above **Extra arguments** edits one cvar inside the same
 * `launchArgs` string, through `write_launch_cvar` in the core. That is the
 * whole trick of this screen: the convenient half and the hand-written half
 * are two views of one field, and neither loses what the other wrote.
 *
 * Outside Tauri the route renders in the tab, so the layout can be reviewed
 * with `npm run dev`. The commands fail there and the cards print why.
 */
export function ClientWindowPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const { client, isLoading, error } = useClient(id);

  // The core sets the title when it opens the window; it follows a rename made
  // here or in the main window, which arrives through `clients:changed`.
  const name = client?.name;
  useEffect(() => {
    if (!isTauri() || name === undefined) return;
    void getCurrentWindow()
      .setTitle(name)
      .catch((e: unknown) => console.warn("cannot set the window title", e));
  }, [name]);

  return (
    <div className="flex flex-col h-full bg-app text-fg">
      <TitleBar
        title={name ?? t("clientWindow.loading")}
        subtitle={id}
        maximizable={false}
      />
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-16 p-16">
          {error ? <Notice text={errorText(error)} /> : null}
          {client ? (
            <ClientCards client={client} />
          ) : isLoading ? (
            <p className="text-body-sm text-fg-muted">
              {t("clientWindow.loading")}
            </p>
          ) : error ? null : (
            <Notice text={t("clientWindow.notFound")} />
          )}
        </div>
      </main>
    </div>
  );
}

/** The stack of cards, once there is a client to fill them with. */
function ClientCards({ client }: { client: Client }) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const engines = useEngines();
  const engine = engines.data?.find((item) => item.id === client.engineId);
  const cvars = useCvarEditor(client.id);
  const updateClient = useUpdateClient();
  const [failure, setFailure] = useState<string | null>(null);

  /** Saves a field of the record itself, as opposed to a cvar on the line. */
  const save = (changes: { name?: string; fsGame?: string; launchArgs?: string }) => {
    setFailure(null);
    updateClient.mutate(
      { clientId: client.id, ...changes },
      { onError: (e) => setFailure(errorText(e)) },
    );
  };

  /** The button that puts a control back to «the client does not set this». */
  const clearOf = (
    name: WindowCvar,
    label: string,
  ): { onClear?: () => void; clearLabel?: string } =>
    cvars.read(name) === null
      ? {}
      : {
          onClear: () => cvars.write(name, null),
          clearLabel: t("clientWindow.clear", { setting: label }),
        };

  const mode = cvars.read("r_mode");
  const custom = mode === CUSTOM_MODE;
  const defaultFolder = engine?.defaultFsGame ?? BASE_FOLDER;
  const failures = [failure, cvars.error].filter(
    (line): line is string => line !== null,
  );

  return (
    <>
      <p className="text-body-sm text-fg-muted">{t("clientWindow.intro")}</p>
      {failures.map((line) => (
        <Notice key={line} text={line} />
      ))}

      <Card heading={t("clientWindow.client.heading")}>
        <SettingRow
          label={t("clientWindow.client.name")}
          htmlFor="client-window-name"
          hint={
            <Trans
              t={t}
              i18nKey="clientWindow.client.idHint"
              values={{ id: client.id }}
              components={[<span className="text-mono-sm" />]}
            />
          }
        >
          <CvarField
            id="client-window-name"
            value={client.name}
            maxLength={48}
            revertOnEmpty
            placeholder={t("clientWindow.client.namePlaceholder")}
            onCommit={(value) => {
              if (value !== null) save({ name: value });
            }}
          />
        </SettingRow>

        <SettingRow label={t("clientWindow.client.engine")}>
          <ClientEngineRow client={client} engine={engine} />
        </SettingRow>

        <SettingRow
          label={t("clientWindow.client.modFolder")}
          htmlFor="client-window-fs-game"
          hint={t("clientWindow.client.modFolderHint", {
            folder: defaultFolder,
            engine: engine?.name ?? t("clientWindow.client.engineFallback"),
          })}
        >
          <CvarField
            id="client-window-fs-game"
            value={client.fsGame}
            maxLength={64}
            placeholder={defaultFolder}
            onCommit={(value) => save({ fsGame: value ?? "" })}
          />
        </SettingRow>
      </Card>

      <Card heading={t("clientWindow.video.heading")}>
        <SettingRow
          label={t("clientWindow.video.mode")}
          {...clearOf("r_mode", t("clientWindow.video.mode"))}
        >
          <CvarSelect
            value={mode}
            options={withUnknown(
              [
                { value: CUSTOM_MODE, label: t("clientWindow.video.modeCustom") },
                ...VIDEO_MODES.map(([width, height], index) => ({
                  value: String(index),
                  label: `${width}×${height}`,
                })),
              ],
              mode,
            )}
            ariaLabel={t("clientWindow.video.mode")}
            placeholder={t("clientWindow.notSet")}
            onChange={(value) => cvars.write("r_mode", value)}
          />
        </SettingRow>

        <SettingRow
          label={t("clientWindow.video.width")}
          htmlFor="client-window-width"
          hint={custom ? undefined : t("clientWindow.video.sizeHint")}
        >
          <CvarField
            id="client-window-width"
            numeric
            disabled={!custom}
            value={cvars.read("r_customwidth")}
            onCommit={(value) => cvars.write("r_customwidth", value)}
          />
        </SettingRow>

        <SettingRow
          label={t("clientWindow.video.height")}
          htmlFor="client-window-height"
        >
          <CvarField
            id="client-window-height"
            numeric
            disabled={!custom}
            value={cvars.read("r_customheight")}
            onCommit={(value) => cvars.write("r_customheight", value)}
          />
        </SettingRow>

        <SettingRow
          label={t("clientWindow.video.fullscreen")}
          {...clearOf("r_fullscreen", t("clientWindow.video.fullscreen"))}
        >
          <CvarSelect
            value={cvars.read("r_fullscreen")}
            options={withUnknown(
              [
                { value: "1", label: t("clientWindow.video.fullscreenOn") },
                { value: "0", label: t("clientWindow.video.fullscreenOff") },
              ],
              cvars.read("r_fullscreen"),
            )}
            ariaLabel={t("clientWindow.video.fullscreen")}
            placeholder={t("clientWindow.notSet")}
            onChange={(value) => cvars.write("r_fullscreen", value)}
          />
        </SettingRow>
      </Card>

      <Card heading={t("clientWindow.audio.heading")}>
        <SettingRow
          label={t("clientWindow.audio.sound")}
          htmlFor="client-window-volume"
          {...clearOf("s_volume", t("clientWindow.audio.sound"))}
        >
          <CvarSlider
            id="client-window-volume"
            value={cvars.read("s_volume")}
            ariaLabel={t("clientWindow.audio.sound")}
            onCommit={(value) => cvars.write("s_volume", value)}
          />
        </SettingRow>

        <SettingRow
          label={t("clientWindow.audio.music")}
          htmlFor="client-window-music"
          {...clearOf("s_musicvolume", t("clientWindow.audio.music"))}
        >
          <CvarSlider
            id="client-window-music"
            value={cvars.read("s_musicvolume")}
            ariaLabel={t("clientWindow.audio.music")}
            onCommit={(value) => cvars.write("s_musicvolume", value)}
          />
        </SettingRow>
      </Card>

      <Card heading={t("clientWindow.player.heading")}>
        <SettingRow
          label={t("clientWindow.player.name")}
          htmlFor="client-window-player"
          hint={t("clientWindow.player.hint")}
        >
          <CvarField
            id="client-window-player"
            value={cvars.read("name")}
            maxLength={31}
            placeholder={t("clientWindow.player.namePlaceholder")}
            onCommit={(value) => cvars.write("name", value)}
          />
        </SettingRow>
      </Card>

      <Card heading={t("clientWindow.performance.heading")}>
        <SettingRow
          label={t("clientWindow.performance.maxFps")}
          htmlFor="client-window-maxfps"
        >
          <CvarField
            id="client-window-maxfps"
            numeric
            value={cvars.read("com_maxfps")}
            onCommit={(value) => cvars.write("com_maxfps", value)}
          />
        </SettingRow>

        <SettingRow
          label={t("clientWindow.performance.rate")}
          htmlFor="client-window-rate"
        >
          <CvarField
            id="client-window-rate"
            numeric
            value={cvars.read("rate")}
            onCommit={(value) => cvars.write("rate", value)}
          />
        </SettingRow>

        <SettingRow
          label={t("clientWindow.performance.snaps")}
          htmlFor="client-window-snaps"
          hint={t("clientWindow.performance.hint")}
        >
          <CvarField
            id="client-window-snaps"
            numeric
            value={cvars.read("snaps")}
            onCommit={(value) => cvars.write("snaps", value)}
          />
        </SettingRow>
      </Card>

      <Card heading={t("clientWindow.extra.heading")}>
        <LaunchArgsField
          value={client.launchArgs}
          onCommit={(value) => save({ launchArgs: value })}
        />
      </Card>

      <Card heading={t("clientWindow.preview.heading")}>
        <CommandPreview clientId={client.id} />
      </Card>
    </>
  );
}

/**
 * The whole command line of the client, as a field.
 *
 * The controls above write into this same string, so the field has to show
 * what they made of it — and must not throw away a line the player is halfway
 * through typing. It commits on blur and re-reads only while it is not the
 * focused element.
 */
function LaunchArgsField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const { t } = useTranslation("clients");
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setDraft(value);
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === value) return;
    onCommit(trimmed);
  };

  return (
    <div className="flex flex-col gap-8">
      <textarea
        id="client-window-launch-args"
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder={t("clientWindow.extra.placeholder")}
        aria-label={t("clientWindow.extra.label")}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        className={cn(
          "w-full px-12 py-8 rounded-md resize-y",
          "bg-input border border-line focus:border-line-focus outline-none",
          "text-mono-sm text-fg placeholder:text-fg-muted",
        )}
      />
      <p className="text-body-sm text-fg-muted">{t("clientWindow.extra.hint")}</p>
    </div>
  );
}

/** One card of the window. */
function Card({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-16">
      <h2 className="text-label-xs text-fg-muted pb-8">{heading}</h2>
      {children}
    </section>
  );
}

/** A refusal of the core, or a client that is not there any more. */
function Notice({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12"
    >
      <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
      <span className="text-body-sm text-fg">{text}</span>
    </div>
  );
}

/**
 * The resolutions of `r_mode`, by their number.
 *
 * Straight out of the engine's own table, `r_vidModes` in
 * `shared/sdl/sdl_window.cpp` of OpenJK `1a6a6434`: the index is the number
 * the cvar takes, so the list cannot drift from what the engine will do with
 * it. Mode 11 is the wide one and mode 12 the surround one; both are their
 * size here, because the size is what a player is choosing.
 */
const VIDEO_MODES: ReadonlyArray<readonly [number, number]> = [
  [320, 240],
  [400, 300],
  [512, 384],
  [640, 480],
  [800, 600],
  [960, 720],
  [1024, 768],
  [1152, 864],
  [1280, 1024],
  [1600, 1200],
  [2048, 1536],
  [856, 480],
  [2400, 600],
];

/** `r_mode -1` is the one that reads `r_customwidth` and `r_customheight`. */
const CUSTOM_MODE = "-1";

/** Mod folder every engine but jaMME starts in. */
const BASE_FOLDER = "base";

/**
 * Keeps a value the list does not know as an option of its own.
 *
 * A line written by hand may carry `r_mode 20` or an `r_fullscreen` this
 * launcher has no word for. Dropping it from the list would show the control
 * as empty over a cvar that is set, and the next change would silently be a
 * second one.
 */
function withUnknown(options: SelectOption[], value: string | null): SelectOption[] {
  if (value === null || options.some((option) => option.value === value)) {
    return options;
  }
  return [...options, { value, label: value }];
}

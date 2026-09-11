import { AlertTriangle, Play } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useLaunchWarningText } from "../../i18n/launchWarnings";
import { cn, commandLine, splitArgs } from "../../lib/format";
import { clientsOfGame, findConnectClient } from "../../lib/game";
import {
  NO_SECOND_HILT,
  type Client,
  type InlineProfile,
  type ServerInfo,
} from "../../lib/ipc";
import {
  useAddServerHistory,
  useAppearanceEvents,
  useClients,
  useGameInfo,
  useLaunchClient,
  useLaunchPreview,
  useProfiles,
  useSaberHilts,
  useSettings,
} from "../../lib/queries";
import {
  MAX_NICKNAME_BYTES,
  NicknameField,
  nicknameBytes,
} from "../client/NicknameField";
import { HiltSelect } from "../client/ProfileForm";
import { SkinPicker } from "../client/SkinPicker";
import { Button, Combobox, Dialog, RadioCard, Select } from "../ui";

/** Which half of the dialog says who the player is. */
type Mode = "profile" | "manual";

/** How far the command line trails the keystrokes that change it. */
const PREVIEW_DELAY_MS = 250;

/** The value of the profile list that means «start with no profile at all». */
const NO_PROFILE = "";

/** A profile of one run that manages nothing: seven fields, all empty. */
function blankInline(): InlineProfile {
  return {
    nickname: null,
    model: null,
    saber1: null,
    saber2: null,
    color1: null,
    color2: null,
    charColor: null,
  };
}

/**
 * What the dialog reopens on, for as long as the launcher is running.
 *
 * Deliberately a module variable and not `settings.json`. A player who joins
 * three servers in a row under one made-up name should type it once, and a
 * player who comes back tomorrow should get their default profile rather than
 * yesterday's experiment. Saved nicknames are the thing that *does* survive a
 * restart, and they already do.
 *
 * Three fields and not the whole draft, on purpose. A nickname and an argument
 * line belong to the player; a skin and a hilt are names of files inside the
 * archives of one client, and carrying those from one client to the next would
 * send the game after a model it has no archive for.
 */
const lastSession: { mode: Mode; nickname: string | null; args: string } = {
  mode: "profile",
  nickname: null,
  args: "",
};

/**
 * The **Connect…** dialog: which client goes to this server, and as whom.
 *
 * One component for both screens that list servers. The quick **Connect**
 * button answers the same question without asking it — the client of the
 * history entry, that client's default profile — and this is where a player
 * who wants a different answer gives one. What it sets lives exactly one
 * launch: nothing is written to `profiles.json` and nothing to `settings.json`
 * except the row in the history, which is what quick **Connect** reads next
 * time.
 *
 * The two halves are exclusive on purpose. A player either *is* one of their
 * saved profiles or is someone made up for this evening, and a form that let
 * both speak would have to decide which of two nicknames wins — a decision the
 * player would have to learn rather than see.
 */
export function ConnectDialog({
  server,
  onClose,
}: {
  server: ServerInfo;
  onClose: () => void;
}) {
  const { t } = useTranslation("servers");
  const errorText = useErrorText();
  const warningText = useLaunchWarningText();

  const clients = useClients();
  const settings = useSettings();
  const launchClient = useLaunchClient();
  const addHistory = useAddServerHistory();
  // A pk3 installed in another window carries skins and hilts this dialog
  // should offer.
  useAppearanceEvents();

  // The row belongs to one game, so the list is that game's. The client the
  // quick button would start is the one the dialog opens on: the dialog is
  // where a player changes that answer, not where they rebuild it.
  const choices = clientsOfGame(clients.data, server.game);
  const suggested = findConnectClient(
    clients.data,
    settings.data,
    server.game,
    server.address,
  );
  // `null` is «the player has not chosen», not «no client»: the list of clients
  // can still be in flight on the first render, and a choice seeded from it
  // once would leave the dialog holding an answer from before the data arrived.
  const [picked, setPicked] = useState<string | null>(null);
  const client: Client | undefined =
    choices.find((entry) => entry.id === picked) ?? suggested ?? choices[0];

  const profiles = useProfiles(client?.id ?? "", client !== undefined);
  const hasHilts = useGameInfo(server.game)?.hasSaberHilts ?? true;
  const hilts = useSaberHilts(client?.id ?? "", client !== undefined && hasHilts);

  const [mode, setMode] = useState<Mode>(lastSession.mode);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [manual, setManual] = useState<InlineProfile>({
    ...blankInline(),
    nickname: lastSession.nickname,
  });
  const [args, setArgs] = useState(lastSession.args);
  const [error, setError] = useState<string | null>(null);

  /**
   * The profile the list stands on.
   *
   * Until the player picks one it is the client's default, which is what the
   * quick **Connect** starts. Held as `null` rather than copied into state
   * when the book arrives: the client can change under this dialog, and state
   * seeded once would go on naming a profile of the client before it.
   */
  const chosenProfile = profileId ?? profiles.data?.defaultProfileId ?? NO_PROFILE;

  const edit = (changes: Partial<InlineProfile>) =>
    setManual((current) => ({ ...current, ...changes }));

  const installed = client !== undefined && client.engineVersion !== null;
  const tooLongNickname =
    mode === "manual" && nicknameBytes(manual.nickname ?? "") > MAX_NICKNAME_BYTES;
  const ready = installed && !tooLongNickname && !launchClient.isPending;

  // What this launch carries beyond the client itself. `inlineProfile` is also
  // how «no profile» is said: the core reads an id as «this one» and its
  // absence as «the default one», so the only way to ask for neither is a
  // profile that manages nothing.
  const inlineProfile =
    mode === "manual"
      ? cleaned(manual, hasHilts)
      : chosenProfile === NO_PROFILE
        ? blankInline()
        : undefined;
  const extraArgs = splitArgs(args);

  // The preview is a round trip, and the nickname and the argument line change
  // a character at a time. A quarter of a second behind the keystrokes is
  // still «while you type» to a reader and is one call instead of twenty.
  const run = useSettled(
    { inlineProfile, extraArgs, connect: server.address },
    PREVIEW_DELAY_MS,
  );
  const preview = useLaunchPreview(
    client?.id ?? "",
    mode === "profile" && chosenProfile !== NO_PROFILE ? chosenProfile : undefined,
    run,
    client !== undefined,
  );

  const connect = () => {
    if (client === undefined || !ready) return;
    setError(null);
    lastSession.mode = mode;
    lastSession.nickname = manual.nickname;
    lastSession.args = args;

    // History first and on its own, in the order both screens already use: the
    // player asked to go here, so the row belongs in History even if the launch
    // fails. It carries the client this dialog chose, which is what the next
    // quick **Connect** on the row will start.
    addHistory.mutate({ address: server.address, clientId: client.id });
    launchClient.mutate(
      {
        clientId: client.id,
        connect: server.address,
        extraArgs,
        profileId:
          mode === "profile" && chosenProfile !== NO_PROFILE
            ? chosenProfile
            : undefined,
        inlineProfile,
      },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(errorText(e)),
      },
    );
  };

  return (
    <Dialog
      wide
      title={server.hostnameClean.trim() === "" ? server.address : server.hostnameClean}
      body={server.address}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("connect.cancel")}
          </Button>
          <Button
            variant="primary"
            icon={<Play size={16} />}
            disabled={!ready}
            onClick={connect}
          >
            {launchClient.isPending
              ? t("connect.starting")
              : t("connect.connect")}
          </Button>
        </>
      }
    >
      {/* The dialog is taller than a short window, and the footer is the one
          part that must never scroll out of reach. */}
      <div className="flex flex-col gap-16 pt-16 max-h-[58vh] overflow-y-auto pr-4">
        <Field label={t("connect.client")}>
          {choices.length === 0 ? (
            <p className="text-body-sm text-fg-muted">{t("connect.noClients")}</p>
          ) : (
            <Select
              value={client?.id ?? ""}
              ariaLabel={t("connect.client")}
              options={choices.map((entry) => ({
                value: entry.id,
                label: entry.name,
              }))}
              onChange={(next) => {
                setPicked(next);
                // Three of the four belong to the client that is going away: a
                // profile id of another client is not a profile, and a skin or
                // a hilt it has no archive for is a name the game cannot find.
                // The nickname is the player's own and stays.
                setProfileId(null);
                setManual((current) => ({
                  ...blankInline(),
                  nickname: current.nickname,
                }));
              }}
            />
          )}
          {client !== undefined && !installed ? (
            <p role="alert" className="text-body-sm text-fg-danger">
              {t("connect.noEngine", { client: client.name })}
            </p>
          ) : null}
        </Field>

        <div className="flex flex-col gap-6">
          <span className="text-label-xs text-fg-muted">
            {t("connect.identity")}
          </span>
          <div
            role="radiogroup"
            aria-label={t("connect.identity")}
            className="grid grid-cols-2 gap-8"
          >
            <RadioCard
              name="connect-mode"
              selected={mode === "profile"}
              onSelect={() => setMode("profile")}
              title={t("connect.useProfile")}
            >
              <span className="text-body-sm text-fg-muted">
                {t("connect.useProfileText")}
              </span>
            </RadioCard>
            <RadioCard
              name="connect-mode"
              selected={mode === "manual"}
              onSelect={() => setMode("manual")}
              title={t("connect.useManual")}
            >
              <span className="text-body-sm text-fg-muted">
                {t("connect.useManualText")}
              </span>
            </RadioCard>
          </div>
        </div>

        {mode === "profile" ? (
          <Field label={t("connect.profile")}>
            <Combobox
              value={chosenProfile}
              ariaLabel={t("connect.profile")}
              searchLabel={t("connect.profileSearch")}
              emptyText={t("connect.profileNoMatch")}
              placeholder={t("connect.profileNone")}
              disabled={client === undefined}
              options={[
                { value: NO_PROFILE, label: t("connect.profileNone") },
                ...(profiles.data?.profiles ?? []).map((profile) => ({
                  value: profile.id,
                  label: profile.name,
                  // Searched as well as drawn: two profiles of one client are
                  // told apart by the nickname they carry far more often than
                  // by the name the player gave the set.
                  hint: profile.nickname ?? undefined,
                })),
              ]}
              onChange={setProfileId}
            />
            {(profiles.data?.profiles ?? []).length === 0 ? (
              <p className="text-body-sm text-fg-muted">
                {t("connect.profilesEmpty")}
              </p>
            ) : null}
          </Field>
        ) : (
          <>
            <Field label={t("connect.nickname")} htmlFor="connect-nickname">
              <NicknameField
                id="connect-nickname"
                value={manual.nickname ?? ""}
                onChange={(value) =>
                  edit({ nickname: value === "" ? null : value })
                }
              />
            </Field>

            <Field label={t("connect.skin")}>
              {client === undefined ? null : (
                <SkinPicker
                  size="sm"
                  clientId={client.id}
                  value={manual.model}
                  onChange={(value) => edit({ model: value })}
                />
              )}
            </Field>

            {/* Jedi Outcast ships no `ext_data/sabers/`, so there is no hilt to
                name and the core writes neither cvar. Hidden rather than left
                empty: an empty list looks like a launcher that failed to read
                something. */}
            {hasHilts ? (
              <div className="grid grid-cols-2 gap-8">
                <Field label={t("connect.saber1")}>
                  <HiltSelect
                    value={manual.saber1}
                    hilts={hilts.data ?? []}
                    label={t("connect.saber1")}
                    size="sm"
                    onChange={(value) => edit({ saber1: value })}
                  />
                </Field>
                <Field label={t("connect.saber2")}>
                  <HiltSelect
                    value={manual.saber2}
                    hilts={hilts.data ?? []}
                    label={t("connect.saber2")}
                    size="sm"
                    extra={[
                      {
                        value: NO_SECOND_HILT,
                        label: t("connect.saber2None"),
                      },
                    ]}
                    onChange={(value) => edit({ saber2: value })}
                  />
                </Field>
              </div>
            ) : null}
          </>
        )}

        <Field label={t("connect.args")} htmlFor="connect-args">
          <input
            id="connect-args"
            value={args}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("connect.argsPlaceholder")}
            onChange={(event) => setArgs(event.target.value)}
            className={cn(
              "h-36 w-full px-12 rounded-md",
              "bg-input border border-line focus:border-line-focus outline-none",
              "text-mono-sm text-fg placeholder:text-fg-muted",
            )}
          />
          <p className="text-body-sm text-fg-muted">{t("connect.argsHint")}</p>
        </Field>

        <Field label={t("connect.preview")}>
          {preview.error ? (
            <p role="alert" className="text-body-sm text-fg-danger break-words">
              {errorText(preview.error)}
            </p>
          ) : (
            <pre className="rounded-md border border-line bg-input p-12 text-mono-xs text-fg-secondary whitespace-pre-wrap break-all">
              {preview.data === undefined
                ? t("connect.previewLoading")
                : commandLine(preview.data.args)}
            </pre>
          )}
          {preview.data?.warning ? (
            <div className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle p-12">
              <AlertTriangle size={16} className="text-fg-warm shrink-0 mt-2" />
              <span className="text-body-sm text-fg">
                {warningText(preview.data.warning)}
              </span>
            </div>
          ) : null}
        </Field>

        {error !== null ? (
          <p role="alert" className="text-body-sm text-fg-danger break-words">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The value once it has stopped changing for `delay` milliseconds.
 *
 * Compared by its JSON, because the caller rebuilds the object on every render
 * and identity would say «changed» every time. That is the same comparison the
 * query key makes of it, so the two cannot disagree about what a new value is.
 */
function useSettled<T>(value: T, delay: number): T {
  const text = JSON.stringify(value);
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
    // The JSON is the dependency: `value` itself is a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, delay]);

  return settled;
}

/**
 * One labelled row of the dialog.
 *
 * A `<label>` only when it names a field the player can click into. Over a
 * grid of skins or a command line there is nothing to focus, and a label
 * pointing at nothing is a promise the screen reader repeats and the pointer
 * does not keep.
 */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const captionClass = "text-label-xs text-fg-muted w-fit";
  return (
    <div className="flex flex-col gap-6">
      {htmlFor === undefined ? (
        <span className={captionClass}>{label}</span>
      ) : (
        <label htmlFor={htmlFor} className={captionClass}>
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

/**
 * The manual fields as the core should read them.
 *
 * A nickname of spaces alone is nothing the player chose, and the core would
 * trim it to an empty string and refuse; the hilts of a game that has none
 * never leave, which is what `launch_tokens` does on the other side anyway.
 * Everything else goes exactly as typed — the core is the gate, and a second
 * one here would be a second set of rules.
 */
function cleaned(profile: InlineProfile, hasHilts: boolean): InlineProfile {
  const nickname = profile.nickname?.trim() ?? "";
  return {
    ...profile,
    nickname: nickname === "" ? null : profile.nickname,
    saber1: hasHilts ? profile.saber1 : null,
    saber2: hasHilts ? profile.saber2 : null,
  };
}

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ExternalLink, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { EngineLogo } from "../components/EngineLogo";
import { NewClientDialog } from "../components/NewClientDialog";
import { Page } from "../components/PageHeader";
import { Badge, Button } from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useEngineNote } from "../i18n/useEngineNote";
import { useFormat } from "../i18n/useFormat";
import { useGameNames } from "../lib/game";
import type { Engine } from "../lib/ipc";
import { useEngineReleases, useEngines } from "../lib/queries";
import { isTauri } from "../lib/runtime";

/**
 * Everything about one build, at `#/engines/<id>`.
 *
 * A route of the main window and not a window of its own: the player arrives
 * here from a client card or from a tile of the New client dialog, reads, and
 * goes back — which is the sidebar's job, not a second window's.
 *
 * The page has no **Check updates** button on purpose. An update check belongs
 * to a client, because it compares a published build with the one unpacked in
 * that client's folder; here there is no client and nothing installed. What
 * the page can say about versions is what GitHub publishes, which is
 * `list_engine_releases`.
 */
export function EnginePage() {
  const { id = "" } = useParams();
  const { t } = useTranslation("clients");
  const engines = useEngines();
  const engine = engines.data?.find((entry) => entry.id === id);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Another engine under the same component: the dialog was opened about the
  // build the player was reading, and that is no longer the build on screen.
  useEffect(() => setDialogOpen(false), [id]);

  if (engines.isLoading) return <Page>{null}</Page>;

  return (
    <Page>
      <p className="pb-16">
        <Link
          to="/clients"
          className="inline-flex items-center gap-6 text-body-sm text-fg-muted hover:text-fg-accent"
        >
          <ArrowLeft size={14} />
          {t("enginePage.back")}
        </Link>
      </p>

      {engine === undefined ? (
        <p className="text-body-md text-fg-secondary">{t("enginePage.notFound")}</p>
      ) : (
        <>
          <EngineHead engine={engine} onNewClient={() => setDialogOpen(true)} />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-16 pt-24">
            <Facts engine={engine} />
            <div className="flex flex-col gap-16">
              <Links engine={engine} />
              <Versions engine={engine} />
            </div>
          </div>
        </>
      )}

      {dialogOpen && engine ? (
        <NewClientDialog
          game={engine.game}
          engineId={engine.id}
          onClose={() => setDialogOpen(false)}
          // The dialog closes itself on a failure and the card it would have
          // made is not here to carry the message, so it goes to the console.
          onError={(message) => console.warn(message)}
        />
      ) : null}
    </Page>
  );
}

/** The name, the mark, the badges and the one sentence of the registry. */
function EngineHead({
  engine,
  onNewClient,
}: {
  engine: Engine;
  onNewClient: () => void;
}) {
  const { t } = useTranslation("clients");
  const { label } = useGameNames();
  const note = useEngineNote()(engine.status);

  return (
    <div className="flex items-start gap-16">
      <EngineLogo engineId={engine.id} name={engine.name} size={64} />
      <div className="flex-1 min-w-0 flex flex-col gap-8">
        <div className="flex items-center gap-8 flex-wrap">
          <h1 className="text-display-lg text-fg">{engine.name}</h1>
          <Badge tone="neutral">{label(engine.game)}</Badge>
          {engine.status.kind === "recommended" ? (
            <Badge tone="accent">{t("engines.recommended")}</Badge>
          ) : engine.status.kind === "legacy" ? (
            <Badge tone="warm">{t("engines.legacy")}</Badge>
          ) : (
            <Badge tone="neutral">{t("enginePage.supported")}</Badge>
          )}
        </div>
        {/* The name and the sentence come from the registry and describe a
            project: data, not copy, and not translated. */}
        <p className="text-body-md text-fg-secondary">{engine.description}</p>
        {note !== null ? (
          <p className="text-body-sm text-fg-warm">{note.text}</p>
        ) : null}
        {engine.installable ? null : (
          <p className="text-body-sm text-fg-muted">
            {engine.notInstallableReason ?? t("card.manualInstall")}
          </p>
        )}
      </div>
      <Button
        variant="primary"
        icon={<Plus size={16} />}
        className="shrink-0"
        onClick={onNewClient}
      >
        {t("enginePage.newClient")}
      </Button>
    </div>
  );
}

/**
 * What the build does, from its own README, plus the two facts JKNet knows.
 *
 * The sentences are catalog keys and not registry strings, because unlike the
 * one-line description they are copy: a player reads them to choose, and they
 * have to arrive in the language on screen. The table below is what keeps them
 * checkable — a key built out of `engine.id` at runtime would reach the player
 * as `enginePage.facts.whatever` the day the registry grows a sixth build.
 */
function Facts({ engine }: { engine: Engine }) {
  const { t } = useTranslation("clients");
  const keys = factKeysOf(engine.id);

  return (
    <section className="rounded-lg border border-line bg-surface p-16">
      <h2 className="text-label-xs text-fg-muted pb-8">
        {t("enginePage.featuresHeading")}
      </h2>
      <ul className="flex flex-col gap-8">
        {keys.map((key) => (
          <li key={key} className="text-body-sm text-fg-secondary">
            {t(key)}
          </li>
        ))}
        <li className="text-body-sm text-fg-muted">
          {t("enginePage.factsExecutable", { file: engine.executable })}
        </li>
        {engine.defaultFsGame !== null ? (
          <li className="text-body-sm text-fg-muted">
            {t("enginePage.factsModFolder", { folder: engine.defaultFsGame })}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** The repository, the release page and the project's own site. */
function Links({ engine }: { engine: Engine }) {
  const { t } = useTranslation("clients");

  return (
    <section className="rounded-lg border border-line bg-surface p-16">
      <h2 className="text-label-xs text-fg-muted pb-8">
        {t("enginePage.linksHeading")}
      </h2>
      <ul className="flex flex-col gap-8">
        <ExternalRow label={t("enginePage.repository")} url={engine.repoUrl} />
        <ExternalRow label={t("enginePage.releases")} url={engine.releasesUrl} />
        {engine.homepage !== null ? (
          <ExternalRow label={t("enginePage.homepage")} url={engine.homepage} />
        ) : null}
      </ul>
    </section>
  );
}

/**
 * One link, opened in the system browser.
 *
 * A `<button>` and not an `<a href>`: an anchor inside a Tauri window would
 * navigate the webview away from the launcher, and there is no way back from
 * a GitHub page rendered where the interface used to be.
 */
function ExternalRow({ label, url }: { label: string; url: string }) {
  return (
    <li className="flex items-baseline justify-between gap-12">
      <span className="text-body-sm text-fg-secondary shrink-0">{label}</span>
      <button
        type="button"
        title={url}
        // A failed open is swallowed: the row is a pointer, and a toast about
        // the browser would be about the wrong thing.
        onClick={() => {
          if (isTauri()) void openUrl(url).catch(() => undefined);
        }}
        className="flex items-center gap-6 min-w-0 text-mono-xs text-fg-accent cursor-pointer hover:underline"
      >
        <span className="truncate">{url}</span>
        <ExternalLink size={12} className="shrink-0" />
      </button>
    </li>
  );
}

/** What GitHub publishes, newest first, as the core already reads it. */
function Versions({ engine }: { engine: Engine }) {
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const releases = useEngineReleases(engine.id);

  return (
    <section className="rounded-lg border border-line bg-surface p-16">
      <h2 className="text-label-xs text-fg-muted pb-8">
        {t("enginePage.versionsHeading")}
      </h2>
      <p className="text-body-sm text-fg-secondary pb-12">
        {t("enginePage.versionsText")}
      </p>
      {releases.isLoading ? (
        <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
      ) : releases.error ? (
        <p className="text-body-sm text-fg-danger">{errorText(releases.error)}</p>
      ) : (releases.data ?? []).length === 0 ? (
        <p className="text-body-sm text-fg-muted">{t("enginePage.versionsEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-8">
          {(releases.data ?? []).map((release) => (
            <li key={release.tag} className="flex items-center gap-8 flex-wrap">
              <span className="text-mono-sm text-fg">{release.tag}</span>
              {release.prerelease ? (
                <Badge tone="warm">{t("enginePage.prerelease")}</Badge>
              ) : null}
              <span className="text-body-sm text-fg-muted">
                {release.publishedAt === ""
                  ? format.bytes(release.assetSize)
                  : `${format.date(release.publishedAt)} · ${format.bytes(release.assetSize)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The README facts of every build, as catalog keys.
 *
 * Read from the READMEs of the five projects on 2026-09-11. A build with no
 * row here still gets a page: the two facts JKNet knows by itself — the
 * executable and the mod folder — come out of the registry.
 */
const FACT_KEYS = {
  openjk: [
    "enginePage.facts.openjk.compatible",
    "enginePage.facts.openjk.noFeatures",
    "enginePage.facts.openjk.platforms",
    "enginePage.facts.openjk.stable",
    "enginePage.facts.openjk.outcast",
  ],
  eternaljk: [
    "enginePage.facts.eternaljk.japro",
    "enginePage.facts.eternaljk.release",
    "enginePage.facts.eternaljk.sound",
    "enginePage.facts.eternaljk.steam",
  ],
  taystjk: [
    "enginePage.facts.taystjk.upstreams",
    "enginePage.facts.taystjk.competitive",
    "enginePage.facts.taystjk.wiki",
    "enginePage.facts.taystjk.mission",
  ],
  jamme: [
    "enginePage.facts.jamme.what",
    "enginePage.facts.jamme.playback",
    "enginePage.facts.jamme.capture",
    "enginePage.facts.jamme.override",
    "enginePage.facts.jamme.mods",
  ],
  jk2mv: [
    "enginePage.facts.jk2mv.versions",
    "enginePage.facts.jk2mv.mods",
    "enginePage.facts.jk2mv.modern",
    "enginePage.facts.jk2mv.downloads",
    "enginePage.facts.jk2mv.fixes",
    "enginePage.facts.jk2mv.platforms",
  ],
} as const;

type FactKey = (typeof FACT_KEYS)[keyof typeof FACT_KEYS][number];

/** The keys of one engine, and an empty list for one nobody wrote about. */
function factKeysOf(engineId: string): readonly FactKey[] {
  // `lib` is ES2020, so no `Object.hasOwn`, and an index on a plain object
  // would happily answer for `constructor`.
  return Object.prototype.hasOwnProperty.call(FACT_KEYS, engineId)
    ? FACT_KEYS[engineId as keyof typeof FACT_KEYS]
    : [];
}

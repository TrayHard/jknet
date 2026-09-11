import { FolderX, Network, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
// --- slice: game switch ---
import { useActiveGame, useGameNames } from "../lib/game";
import {
  useClearJkhubCache,
  useJkhubIndexStatus,
  useRefreshJkhubCategories,
  useRefreshJkhubIndex,
} from "../lib/queries";
import { Button } from "./ui";

// --- slice: library cleanup ---
/**
 * The JKHub catalog card of the Settings screen.
 *
 * Three actions that used to sit on the **Library** screen, where a player
 * reading a grid of files met them every visit: a full crawl of the catalog,
 * a walk of the category tree, and emptying the cache folder. None of them is
 * part of browsing — the core keeps the catalog current by itself — and all
 * three cost jkhub.org real requests, so they belong next to the other caches
 * rather than above the cards.
 *
 * The catalog is per game, like the tab that reads it, so the card works on
 * the game the sidebar is set to and names it. Clearing the cache is not: the
 * folder holds both games, every downloaded archive and both indexes.
 */
export function JkhubCatalogCard() {
  const { t } = useTranslation("settings");
  const errorText = useErrorText();
  const format = useFormat();
  const game = useActiveGame();
  const { label } = useGameNames();
  const status = useJkhubIndexStatus(game);
  const refreshIndex = useRefreshJkhubIndex();
  const refreshCategories = useRefreshJkhubCategories();
  const clearCache = useClearJkhubCache();

  const [busy, setBusy] = useState<"index" | "categories" | "cache" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // One runner for the three: each is a promise, each locks every button while
  // it runs, and each says what it did or why it could not.
  const run = (
    what: "index" | "categories" | "cache",
    work: () => Promise<string | null>,
  ) => {
    setBusy(what);
    setNote(null);
    setFailure(null);
    void work()
      .then((message) => setNote(message))
      .catch((error: unknown) => setFailure(errorText(error)))
      .finally(() => setBusy(null));
  };

  // The core answers the crawl, and the status line under the row picks the
  // new count and date up by itself, so the run adds nothing to say.
  const rebuild = () =>
    run("index", async () => {
      await refreshIndex(game, true);
      return null;
    });

  const updateCategories = () =>
    run("categories", async () => {
      const answer = await refreshCategories(game);
      return t("jkhub.categoriesDone", { count: answer.categories.length });
    });

  const clear = () =>
    run("cache", async () => {
      await clearCache();
      return t("jkhub.cleared");
    });

  const state = status.data;
  const line = status.isLoading
    ? t("jkhub.reading")
    : state?.building
      ? t("jkhub.building")
      : !state?.available
        ? t("jkhub.missing")
        : t("jkhub.line", {
            count: state.files,
            date: format.date(state.updatedAt),
          });

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">{t("jkhub.title")}</h2>
      <p className="text-body-sm text-fg-secondary">{t("jkhub.text")}</p>

      <div className="flex items-start justify-between gap-16 pt-12">
        <span className="flex flex-col min-w-0">
          <span className="text-body-md-medium text-fg">
            {t("jkhub.catalog", { game: label(game) })}
          </span>
          <span className="text-body-sm text-fg-muted">{line}</span>
        </span>
        <span className="flex items-center gap-8 shrink-0">
          <Button
            icon={<Network size={16} />}
            disabled={busy !== null}
            title={t("jkhub.categoriesHint")}
            onClick={updateCategories}
          >
            {busy === "categories"
              ? t("jkhub.updatingCategories")
              : t("jkhub.categories")}
          </Button>
          <Button
            icon={<RefreshCw size={16} />}
            disabled={busy !== null || state?.building === true}
            title={t("jkhub.rebuildHint")}
            onClick={rebuild}
          >
            {busy === "index" ? t("jkhub.rebuilding") : t("jkhub.rebuild")}
          </Button>
        </span>
      </div>

      <div className="flex items-start justify-between gap-16 pt-12">
        <span className="flex flex-col min-w-0">
          <span className="text-body-md-medium text-fg">{t("jkhub.cache")}</span>
          <span className="text-body-sm text-fg-muted">{t("jkhub.cacheText")}</span>
        </span>
        <Button
          icon={<FolderX size={16} />}
          disabled={busy !== null}
          onClick={clear}
        >
          {busy === "cache" ? t("jkhub.clearing") : t("jkhub.clear")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger pt-12">
          {failure}
        </p>
      ) : null}
      {note && !failure ? (
        <p role="status" className="text-body-sm text-fg-secondary pt-12">
          {note}
        </p>
      ) : null}
    </section>
  );
}

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ExternalLink, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useToasts } from "../ToastsProvider";
import { Button, EmptyState, Select, type SelectOption } from "../ui";
import { JkhubCard } from "./JkhubCard";
import { JkhubDetails } from "./JkhubDetails";
// --- slice: jkhub index startup ---
import { JkhubIndexing } from "./JkhubIndexing";
import { JkhubTree } from "./JkhubTree";
// --- slice: i18n ---
import { useErrorText } from "../../i18n/errors";
import { useActiveGame, useGameNames } from "../../lib/game";
import type { JkhubCategory, JkhubInstallResult, JkhubSort, LibraryItem } from "../../lib/ipc";
import { jkhubIpc } from "../../lib/ipc";
import {
  useCancelJkhubIndex,
  useJkhubCategories,
  useJkhubDownloadProgress,
  useJkhubFile,
  useJkhubIndexProgress,
  useJkhubIndexStatus,
  useJkhubInstall,
  useJkhubSearch,
  useRefreshJkhubCategories,
  useRefreshJkhubIndex,
  useRefreshJkhubListing,
} from "../../lib/queries";
import { isTauri } from "../../lib/runtime";

// --- slice: i18n --- the ids go to the site, the labels come from the catalog.
//
// --- slice: jkhub index ---
// `topRated` is missing on purpose: the tab lists from the local index, and a
// listing card of this theme prints no stars, so no crawl ever saw a rating.
const SORT_IDS: JkhubSort[] = ["recentlyUpdated", "newest", "mostDownloaded", "name"];

/** Cards added by one press of **Load more**, and the most the grid holds. */
const PAGE = 25;
const MAX_SHOWN = 100;

/** How long the search waits after a keystroke before it asks the core. */
const DEBOUNCE_MS = 150;

/**
 * What the grid is scoped to, and who decided it.
 *
 * `null` is the one state the landing effect is allowed to fill in: the tab
 * has not chosen a category yet. Everything else is a decision — the `all` of
 * **Show all categories** included — and an effect that read `all` as «nothing
 * chosen» would put the landing category straight back and undo the press in
 * the same commit.
 *
 * `landed` and `picked` carry the same category and differ only in who chose
 * it, which is the whole of what [`searchScope`] needs.
 */
export type Scope =
  | { kind: "landed"; category: JkhubCategory }
  | { kind: "picked"; category: JkhubCategory }
  | { kind: "all" };

/**
 * The category a search is narrowed to, or null for the whole game.
 *
 * A query is answered out of the whole catalogue unless the player narrowed it
 * themselves. The tab has to open somewhere and opens on the first category
 * with files of its own — `Audio`, 44 of the 3 324 Jedi Academy files — and a
 * search that stayed inside that would answer «nothing matches» to almost
 * every word typed into the search box of the screen. Finding a file in a
 * category nobody opened is what the local index is for.
 *
 * Picking a category narrows the search to it, which is what the counts in the
 * tree are for; **Show all categories** widens it again.
 *
 * ```ts
 * searchScope({ kind: "landed", category: audio }, "")     // audio.id
 * searchScope({ kind: "landed", category: audio }, "kyle") // null
 * searchScope({ kind: "picked", category: audio }, "kyle") // audio.id
 * searchScope({ kind: "all" }, "kyle")                     // null
 * ```
 */
export function searchScope(scope: Scope | null, query: string): number | null {
  if (scope == null || scope.kind === "all") return null;
  if (scope.kind === "landed" && query !== "") return null;
  return scope.category.id;
}

interface JkhubBrowserProps {
  /** Client Install writes into. Null while none is selected. */
  clientId: string | null;
  clientName: string;
  /** Files already in that client, for the Installed badge. */
  installed: LibraryItem[];
  // --- slice: library cleanup ---
  /**
   * What the screen's search box holds, raw.
   *
   * The tab has no box of its own: one field in the header serves all three
   * tabs, so a query survives a switch between them. The debounce below this
   * stays here, because it is this tab that pays for a keystroke.
   */
  search: string;
}

/**
 * The **Browse JKHub** tab: the catalogue of jkhub.org inside the launcher.
 *
 * The design file stops at the tab strip for this screen, so the layout
 * follows the Installed tab next to it: a category rail on the left, a bar of
 * controls, and a grid of cards. The client this installs into is the one
 * picked in the bar above the tabs — the same choice the Installed tab uses,
 * rather than a second picker that could disagree with it.
 *
 * --- slice: jkhub index ---
 * Both the listing and the search come from the local catalogue index rather
 * than from a page of the site, which is what makes a query find a file in a
 * category nobody opened. The core keeps that index current on its own, and
 * **Refresh** asks for a top-up outright. How old the index is, a full rebuild
 * of it and a walk of the category tree live on the Settings screen, with the
 * other caches.
 */
export function JkhubBrowser({
  clientId,
  clientName,
  installed,
  search: typed,
}: JkhubBrowserProps) {
  const { t } = useTranslation("jkhub");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const gameNames = useGameNames();
  const [scope, setScope] = useState<Scope | null>(null);
  const [sort, setSort] = useState<JkhubSort>("recentlyUpdated");
  const [shown, setShown] = useState(PAGE);
  // Opening the tab with a word already in the box searches for it at once:
  // the wait below is for the next keystroke, not for text typed on another
  // tab a minute ago.
  const [query, setQuery] = useState(() => typed.trim());
  const [openFile, setOpenFile] = useState<number | null>(null);
  const [result, setResult] = useState<JkhubInstallResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingTree, setUpdatingTree] = useState(false);

  const toasts = useToasts();
  // JKHub keeps the two games in separate roots, so the tab browses the game
  // the launcher is set to. `Both Games/Other` shows up under either. The
  // switcher in the sidebar writes it; every query below is keyed by it and
  // fetches the new game's catalogue by itself.
  const game = useActiveGame();
  const categories = useJkhubCategories(game);
  const status = useJkhubIndexStatus(game);
  const indexing = useJkhubIndexProgress();
  const refreshListing = useRefreshJkhubListing();
  const refreshCategories = useRefreshJkhubCategories();
  const refreshIndex = useRefreshJkhubIndex();
  const cancelIndex = useCancelJkhubIndex();
  const progress = useJkhubDownloadProgress();
  const install = useJkhubInstall(clientId);
  const details = useJkhubFile(openFile);

  // The search waits out a burst of typing. Anything shorter than this and the
  // core folds three thousand descriptions per keystroke for nothing; anything
  // longer and the grid feels late.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // A switch of game is a switch of tree and of client: the picker above the
  // tabs now offers the other game's clients. Dropping the selection here, and
  // not waiting for the new tree to arrive, does two things. The listing query
  // never asks for a category id of the old tree under the new game, and the
  // details panel cannot keep an **Install** button that would write a Jedi
  // Academy file into a Jedi Outcast client.
  useEffect(() => {
    setScope(null);
    setOpenFile(null);
  }, [game]);

  // The first category with files of its own is the landing page of the tab:
  // the two roots hold nothing themselves, and neither does Maps. It is filled
  // in while nothing is chosen — after a change of game, and after a walk of
  // the tree that no longer holds the category which was picked in it. A scope
  // the player chose, `all` included, is left where it is.
  const tree = useMemo(() => categories.data?.categories ?? [], [categories.data]);
  useEffect(() => {
    if (tree.length === 0) return;
    if (scope?.kind === "all") return;
    if (scope != null && tree.some((entry) => entry.id === scope.category.id)) return;
    const first = tree.find((entry) => entry.hasFiles && entry.parentId != null);
    setScope(first ? { kind: "landed", category: first } : { kind: "all" });
  }, [tree, scope]);

  // The category the search is actually narrowed to, and the one the tree
  // highlights: while a query is answered out of the whole catalogue, nothing
  // is narrowed and nothing is highlighted.
  const scoped = searchScope(scope, query);
  const category = scope != null && scope.kind !== "all" ? scope.category : null;

  // A change of scope, order or query starts the grid over at one page.
  useEffect(() => {
    setShown(PAGE);
  }, [scoped, sort, query]);

  const search = useJkhubSearch(game, query, scoped, sort, shown);
  const cards = search.data?.cards ?? [];
  const total = search.data?.total ?? 0;
  const counts = query ? (search.data?.categoryCounts ?? {}) : null;
  const canLoadMore =
    shown < Math.min(total, MAX_SHOWN) && !search.isFetching;

  const names = useMemo(() => {
    const map = new Map<number, JkhubCategory>();
    for (const entry of tree) map.set(entry.id, entry);
    return map;
  }, [tree]);

  const installedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const item of installed) {
      if (item.provenance) ids.add(item.provenance.fileId);
    }
    return ids;
  }, [installed]);

  // A crawl of the other game must not put a progress line on this one.
  const building = status.data?.building === true;
  // --- slice: jkhub index startup ---
  // Whether there is a catalogue to list, to search and to type at. The rule
  // is the core's — `index::browsable` — and the screen only reads it. Until
  // the core has answered, the tab behaves as though it can browse: the status
  // arrives within a frame or two, and a waiting panel that appears and goes
  // again in that time is worse than one that is briefly hopeful.
  //
  // --- slice: library cleanup --- the search box reads the same answer from
  // `LibraryPage`, where the box now lives.
  const browsable = status.data?.available !== false;
  // The event is the fresher of the two; the answer of the status is what a tab
  // opened halfway through a crawl has instead of the events it missed.
  const step = indexing.get(game) ?? status.data?.progress ?? null;

  const runInstall = (id: number, replace: boolean) => {
    if (!clientId) {
      setFailure(t("install.pickClient"));
      return;
    }
    setFailure(null);
    setResult(null);
    install.mutate(
      { id, replace },
      {
        onSuccess: (answer) => {
          setResult(answer);
          if (answer.kind === "installed") {
            toasts.show(`jkhub:${id}`, {
              variant: "success",
              title: t("install.toastTitle", { client: clientName }),
              text: answer.files.join(", "),
            });
            return;
          }
          // Everything else needs a decision, and the dialog is where the
          // buttons for it are.
          setOpenFile(id);
        },
        onError: (error) => {
          const message = errorText(error);
          setFailure(message);
          toasts.show(`jkhub:${id}`, {
            variant: "error",
            title: t("install.failedTitle"),
            text: message,
          });
        },
      },
    );
  };

  const openSite = (id: number) => {
    if (!isTauri()) return;
    void jkhubIpc.open(id).catch((e: unknown) => setFailure(errorText(e)));
  };

  const reveal = (path: string) => {
    if (!isTauri()) return;
    void revealItemInDir(path).catch((e: unknown) => setFailure(errorText(e)));
  };

  // **Refresh** reads jkhub.org for what the catalogue index does not know
  // yet, and re-reads the open file page with it. It deliberately leaves the
  // category tree alone — that walk is twenty requests and has its own action
  // on the Settings screen.
  //
  // `full` is the crawl of every listing page. The core reaches for it on its
  // own when the cheap path cannot do the job; **Rebuild** on the Settings
  // screen is the way a player asks for it outright, and so is **Try again**
  // on the waiting panel below.
  const runRefresh = (full: boolean) => {
    setRefreshing(true);
    setFailure(null);
    void Promise.all([
      refreshIndex(game, full),
      // Only the open card: the grid comes from the index, which the refresh
      // is already rewriting.
      refreshListing({ game, categoryId: null, sort, pages: 0, fileId: openFile }),
    ])
      .then(([update]) => {
        // A run the player stopped is neither an update nor a catalogue that
        // was already current, and saying either would be a lie.
        if (update.cancelled) {
          toasts.show("jkhub:index", {
            variant: "info",
            title: t("index.stoppedTitle"),
            text: t("index.stoppedToast", { count: update.requests }),
          });
          return;
        }
        const changed = update.added + update.updated + update.removed;
        toasts.show("jkhub:index", {
          variant: "success",
          title: changed > 0 ? t("index.updatedTitle") : t("index.currentTitle"),
          text:
            changed > 0
              ? t("index.updatedText", {
                  added: update.added,
                  updated: update.updated,
                  count: update.files,
                })
              : t("index.currentText", { count: update.files }),
        });
      })
      .catch((e: unknown) => setFailure(errorText(e)))
      .finally(() => setRefreshing(false));
  };

  // --- slice: jkhub index startup ---
  // **Cancel** on the blocking panel. The core stops between pages and keeps
  // whatever index it had, which with nothing indexed is nothing at all — so
  // the panel switches to the empty state with **Try again** rather than
  // letting a half-read catalogue on screen.
  const runCancel = () => {
    setRefreshing(true);
    setFailure(null);
    void cancelIndex(game)
      .catch((e: unknown) => setFailure(errorText(e)))
      .finally(() => setRefreshing(false));
  };

  // --- slice: library cleanup ---
  // All that is left of **Update categories** on this tab: the way out of a
  // tab with no tree at all. The action itself lives on the Settings screen.
  const runUpdateCategories = () => {
    setUpdatingTree(true);
    setFailure(null);
    void refreshCategories(game)
      .then((answer) => {
        toasts.show("jkhub:categories", {
          variant: "success",
          title: t("install.categoriesTitle"),
          text: t("install.categoriesText", { count: answer.categories.length }),
        });
      })
      .catch((e: unknown) => setFailure(errorText(e)))
      .finally(() => setUpdatingTree(false));
  };

  if (!isTauri()) {
    return (
      <EmptyState
        icon={<ExternalLink size={24} />}
        title={t("empty.browserTitle")}
        text={t("empty.browserText")}
      />
    );
  }

  if (categories.isLoading) {
    return <p className="text-body-sm text-fg-muted">{t("loading.categories")}</p>;
  }

  if (categories.error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={24} />}
        title={t("empty.unreachableTitle")}
        text={errorText(categories.error)}
        action={
          // Nothing else on the tab works without a tree, so this one walks it.
          <Button
            icon={<RefreshCw size={16} />}
            disabled={updatingTree}
            onClick={runUpdateCategories}
          >
            {tCommon("actions.tryAgain")}
          </Button>
        }
      />
    );
  }

  // A query with answers elsewhere and none here is not an empty catalogue:
  // it is the wrong category, and the way out is one button.
  const elsewhere =
    query !== "" && total === 0 && scoped != null && category != null;

  return (
    <>
      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      <div className="flex items-start gap-24">
        <aside className="w-232 shrink-0">
          <JkhubTree
            categories={tree}
            selected={scoped}
            onSelect={(entry) => setScope({ kind: "picked", category: entry })}
            counts={counts}
          />
        </aside>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-12 pb-12">
            <span className="flex-1" />
            <span className="text-label-xs text-fg-muted">{t("sort.label")}</span>
            <Select
              ariaLabel={t("sort.label")}
              options={SORT_IDS.map<SelectOption>((id) => ({
                value: id,
                label: t(`sort.${id}`),
              }))}
              value={sort}
              onChange={(value) => setSort(value as JkhubSort)}
              className="w-176"
            />
            <Button
              icon={<RefreshCw size={16} />}
              disabled={refreshing || building}
              onClick={() => runRefresh(false)}
            >
              {t("refresh")}
            </Button>
          </div>

          {/* --- slice: library cleanup ---
              How many files answered, and nothing else. The line that named
              the category and the client, and the one that dated the index
              and offered to rebuild it, are gone: the tree already says which
              category is open, and the catalogue is kept current by the core
              and by the Settings screen. */}
          {query ? (
            <p className="text-body-sm text-fg-muted pb-12">
              {t("search.results", { count: total, game: gameNames.label(game) })}
            </p>
          ) : null}

          {/* --- slice: jkhub index startup ---
              Nothing to list and nothing to search: no crawl of this machine
              and no copy inside the build. The grid would sit empty while a
              crawl ran behind it, which reads as a broken screen rather than
              as a wait, so the wait takes its place — with the progress, the
              reason and one button to stop it. The bar above stays, and so
              does the search box in the header of the screen — switched off
              while this tab is open, because the catalogue is what is
              missing, not the tab. Every shipped build carries a snapshot, so
              this is a safety net and not the normal first run. */}
          {!browsable ? (
            <JkhubIndexing
              building={building}
              step={step}
              busy={refreshing}
              onCancel={runCancel}
              onRetry={() => runRefresh(true)}
            />
          ) : search.isLoading ? (
            <p className="text-body-sm text-fg-muted">{t("loading.files")}</p>
          ) : search.error ? (
            <EmptyState
              icon={<AlertTriangle size={24} />}
              title={t("empty.categoryTitle")}
              text={errorText(search.error)}
            />
          ) : cards.length === 0 ? (
            <EmptyState
              icon={<Search size={24} />}
              title={
                elsewhere ? t("empty.elsewhereTitle") : t("empty.filteredTitle")
              }
              text={
                elsewhere
                  ? t("empty.elsewhereText", { category: category.name })
                  : t("empty.filteredText")
              }
              action={
                elsewhere ? (
                  <Button onClick={() => setScope({ kind: "all" })}>
                    {t("empty.showAllCategories")}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-12">
                {cards.map((card) => (
                  <JkhubCard
                    key={card.id}
                    card={card}
                    categoryName={
                      names.get(card.categoryId ?? category?.id ?? 0)?.name
                    }
                    installed={installedIds.has(card.id)}
                    progress={progress.get(card.id) ?? null}
                    busy={install.isPending}
                    onOpen={() => {
                      setResult(null);
                      setOpenFile(card.id);
                    }}
                    onInstall={() => runInstall(card.id, false)}
                  />
                ))}
              </ul>

              <div className="flex justify-center pt-16">
                {canLoadMore ? (
                  <Button onClick={() => setShown((count) => count + PAGE)}>
                    {tCommon("actions.loadMore")}
                  </Button>
                ) : (
                  <span className="text-body-sm text-fg-muted">
                    {t("search.loaded", { shown: cards.length, total })}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {openFile != null ? (
        <JkhubDetails
          file={details.data}
          loading={details.isLoading}
          error={details.error ? errorText(details.error) : null}
          clientName={clientName}
          installed={installedIds.has(openFile)}
          busy={install.isPending}
          progress={progress.get(openFile) ?? null}
          result={result?.fileId === openFile ? result : null}
          onClose={() => {
            setOpenFile(null);
            setResult(null);
          }}
          onInstall={(replace) => runInstall(openFile, replace)}
          onOpenSite={() => openSite(openFile)}
          onRevealArchive={reveal}
        />
      ) : null}
    </>
  );
}

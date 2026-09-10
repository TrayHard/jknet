import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ExternalLink, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useToasts } from "../ToastsProvider";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  type SelectOption,
} from "../ui";
import { JkhubCard } from "./JkhubCard";
import { JkhubDetails } from "./JkhubDetails";
import { JkhubTree } from "./JkhubTree";
// --- slice: i18n ---
import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { useActiveGame, useGameNames } from "../../lib/game";
import type { JkhubCategory, JkhubInstallResult, JkhubSort, LibraryItem } from "../../lib/ipc";
import { jkhubIpc } from "../../lib/ipc";
import {
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

/** An index older than this is described by its date rather than its age. */
const A_DAY = 24 * 60 * 60;

interface JkhubBrowserProps {
  /** Client Install writes into. Null while none is selected. */
  clientId: string | null;
  clientName: string;
  /** Files already in that client, for the Installed badge. */
  installed: LibraryItem[];
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
 * category nobody opened. The core keeps that index current on its own; the
 * only thing this screen does about it is say how old it is and offer to read
 * jkhub.org again.
 */
export function JkhubBrowser({ clientId, clientName, installed }: JkhubBrowserProps) {
  const { t } = useTranslation("jkhub");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const gameNames = useGameNames();
  const [category, setCategory] = useState<JkhubCategory | null>(null);
  const [sort, setSort] = useState<JkhubSort>("recentlyUpdated");
  const [shown, setShown] = useState(PAGE);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
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
    setCategory(null);
    setOpenFile(null);
  }, [game]);

  // The first category with files of its own is the landing page of the tab:
  // the two roots hold nothing themselves, and neither does Maps. A change of
  // game brings a different tree, and a category picked in the old one is not
  // in it, so the landing page is chosen again.
  const tree = useMemo(() => categories.data?.categories ?? [], [categories.data]);
  useEffect(() => {
    if (tree.length === 0) return;
    if (category != null && tree.some((entry) => entry.id === category.id)) return;
    const first = tree.find((entry) => entry.hasFiles && entry.parentId != null);
    setCategory(first ?? null);
  }, [tree, category]);

  // A change of category, order or query starts the grid over at one page.
  useEffect(() => {
    setShown(PAGE);
  }, [category?.id, sort, query]);

  const search = useJkhubSearch(game, query, category?.id ?? null, sort, shown);
  const cards = search.data?.cards ?? [];
  const total = search.data?.total ?? 0;
  const counts = query ? (search.data?.categoryCounts ?? {}) : null;
  const stale = search.data?.stale || categories.data?.stale;
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
  const step = indexing.get(game);

  const indexLine = () => {
    if (building && step) {
      return t("index.building", { done: step.done, total: step.total });
    }
    if (building) return t("index.startingUp");
    const state = status.data;
    if (!state?.indexed) return t("index.missing");
    if (state.age < A_DAY) {
      return t("index.line", { time: format.age(state.age), count: state.files });
    }
    return t("index.lineDate", {
      date: format.date(state.updatedAt),
      count: state.files,
    });
  };

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
  // in the tree header.
  //
  // `full` is the crawl of every listing page. The core reaches for it on its
  // own when the cheap path cannot do the job, and **Rebuild** is the way a
  // player asks for it outright.
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
  const elsewhere = query !== "" && total === 0 && category != null;

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
            selected={category?.id ?? null}
            onSelect={setCategory}
            onUpdate={runUpdateCategories}
            updating={updatingTree}
            counts={counts}
          />
        </aside>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-12 pb-12">
            <Input
              icon={<Search size={16} />}
              placeholder={t("search.placeholder")}
              value={typed}
              className="w-232"
              onChange={(event) => setTyped(event.target.value)}
            />
            <span className="flex-1" />
            {stale ? (
              <Badge tone="warm" icon={<AlertTriangle size={12} />}>
                {t("fromCache")}
              </Badge>
            ) : null}
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

          <p className="text-body-sm text-fg-muted">
            {/* The category name comes from jkhub.org: data, not copy. */}
            {query
              ? t("search.results", {
                  count: total,
                  game: gameNames.label(game),
                })
              : category
                ? t("scope.category", { category: category.name, client: clientName })
                : t("scope.noCategory", { client: clientName })}
          </p>

          <p className="flex items-center gap-8 text-label-xs text-fg-muted pb-12 pt-4">
            <span>{indexLine()}</span>
            <button
              type="button"
              onClick={() => runRefresh(true)}
              disabled={refreshing || building}
              title={t("index.rebuildHint")}
              className={
                refreshing || building
                  ? "text-fg-muted cursor-default"
                  : "text-fg-muted hover:text-fg cursor-pointer"
              }
            >
              {t("index.rebuild")}
            </button>
          </p>

          {search.isLoading ? (
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
                  <Button onClick={() => setCategory(null)}>
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

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ExternalLink, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useToasts } from "../ToastsProvider";
import { Badge, Button, EmptyState, Input } from "../ui";
import { JkhubCard } from "./JkhubCard";
import { JkhubDetails } from "./JkhubDetails";
import { JkhubTree } from "./JkhubTree";
import { Select, type SelectOption } from "./Select";
import { errorMessage, type JkhubCategory, type JkhubInstallResult, type JkhubSort, type LibraryItem } from "../../lib/ipc";
import { jkhubIpc } from "../../lib/ipc";
import {
  useJkhubCategories,
  useJkhubDownloadProgress,
  useJkhubFile,
  useJkhubInstall,
  useJkhubListing,
  useRefreshJkhub,
} from "../../lib/queries";
import { isTauri } from "../../lib/runtime";

/**
 * The game this tab browses.
 *
 * TODO(game-switch): read the active game from the settings once the launcher
 * has one. JKHub keeps Jedi Academy and Jedi Outcast in separate roots, and
 * the tree is fetched per game, so this is the only place that has to change.
 */
const GAME = "ja" as const;

const SORTS: SelectOption[] = [
  { value: "recentlyUpdated", label: "Recently updated" },
  { value: "newest", label: "Newest" },
  { value: "mostDownloaded", label: "Most downloaded" },
  { value: "topRated", label: "Top rated" },
  { value: "name", label: "Name" },
];

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
 */
export function JkhubBrowser({ clientId, clientName, installed }: JkhubBrowserProps) {
  const [category, setCategory] = useState<JkhubCategory | null>(null);
  const [sort, setSort] = useState<JkhubSort>("recentlyUpdated");
  const [pages, setPages] = useState(1);
  const [filter, setFilter] = useState("");
  const [openFile, setOpenFile] = useState<number | null>(null);
  const [result, setResult] = useState<JkhubInstallResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const toasts = useToasts();
  const categories = useJkhubCategories(GAME);
  const refresh = useRefreshJkhub();
  const progress = useJkhubDownloadProgress();
  const install = useJkhubInstall(clientId);
  const details = useJkhubFile(openFile);

  // The first category with files of its own is the landing page of the tab:
  // the two roots hold nothing themselves, and neither does Maps.
  const tree = useMemo(() => categories.data?.categories ?? [], [categories.data]);
  useEffect(() => {
    if (category != null || tree.length === 0) return;
    const first = tree.find((entry) => entry.hasFiles && entry.parentId != null);
    if (first) setCategory(first);
  }, [tree, category]);

  // A change of category or order starts the paging over.
  useEffect(() => {
    setPages(1);
  }, [category?.id, sort]);

  const page1 = useJkhubListing(category?.id ?? null, sort, 1);
  const page2 = useJkhubListing(pages >= 2 ? (category?.id ?? null) : null, sort, 2);
  const page3 = useJkhubListing(pages >= 3 ? (category?.id ?? null) : null, sort, 3);
  const page4 = useJkhubListing(pages >= 4 ? (category?.id ?? null) : null, sort, 4);

  // Four pages of twenty-five is a hundred cards, which is as far as **Load
  // more** goes before the sort or the filter is the better tool. A hook
  // cannot be called in a loop, so the pages are named rather than mapped.
  const loaded = [page1, page2, page3, page4].slice(0, pages);
  const cards = loaded.flatMap((query) => query.data?.cards ?? []);
  const totalPages = page1.data?.pages ?? 1;
  const canLoadMore = pages < Math.min(totalPages, 4) && !loaded.some((q) => q.isFetching);
  const stale = loaded.some((query) => query.data?.stale) || categories.data?.stale;

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

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return cards;
    return cards.filter(
      (card) =>
        card.title.toLowerCase().includes(needle) ||
        card.author?.name.toLowerCase().includes(needle) ||
        card.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [cards, filter]);

  const runInstall = (id: number, replace: boolean) => {
    if (!clientId) {
      setFailure("Pick a client above first: a file is installed into a client.");
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
              title: `Installed into ${clientName}`,
              text: answer.files.join(", "),
            });
            return;
          }
          // Everything else needs a decision, and the dialog is where the
          // buttons for it are.
          setOpenFile(id);
        },
        onError: (error) => {
          const message = errorMessage(error);
          setFailure(message);
          toasts.show(`jkhub:${id}`, {
            variant: "error",
            title: "Install failed",
            text: message,
          });
        },
      },
    );
  };

  const openSite = (id: number) => {
    if (!isTauri()) return;
    void jkhubIpc.open(id).catch((e: unknown) => setFailure(errorMessage(e)));
  };

  const reveal = (path: string) => {
    if (!isTauri()) return;
    void revealItemInDir(path).catch((e: unknown) => setFailure(errorMessage(e)));
  };

  const runRefresh = () => {
    setRefreshing(true);
    setFailure(null);
    void refresh(GAME)
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setRefreshing(false));
  };

  if (!isTauri()) {
    return (
      <EmptyState
        icon={<ExternalLink size={24} />}
        title="JKHub needs the launcher window"
        text="This tab talks to jkhub.org through the JKNet core, which a browser preview does not have."
      />
    );
  }

  if (categories.isLoading) {
    return <p className="text-body-sm text-fg-muted">Reading the JKHub categories…</p>;
  }

  if (categories.error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={24} />}
        title="JKHub did not answer"
        text={errorMessage(categories.error)}
        action={
          <Button icon={<RefreshCw size={16} />} onClick={runRefresh}>
            Try again
          </Button>
        }
      />
    );
  }

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
          />
        </aside>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-12 pb-12">
            <Input
              icon={<Search size={16} />}
              placeholder="Filter loaded files"
              value={filter}
              className="w-232"
              onChange={(event) => setFilter(event.target.value)}
            />
            <span className="flex-1" />
            {stale ? (
              <Badge tone="warm" icon={<AlertTriangle size={12} />}>
                From cache
              </Badge>
            ) : null}
            <span className="text-label-xs text-fg-muted">Sort by</span>
            <Select
              label="Sort by"
              options={SORTS}
              value={sort}
              onChange={(value) => setSort(value as JkhubSort)}
              className="w-176"
            />
            <Button
              icon={<RefreshCw size={16} />}
              disabled={refreshing}
              onClick={runRefresh}
            >
              Refresh
            </Button>
          </div>

          <p className="text-body-sm text-fg-muted pb-12">
            {category
              ? `${category.name} · installs into ${clientName}`
              : `Pick a category · installs into ${clientName}`}
          </p>

          {page1.isLoading ? (
            <p className="text-body-sm text-fg-muted">Loading files…</p>
          ) : page1.error ? (
            <EmptyState
              icon={<AlertTriangle size={24} />}
              title="This category did not load"
              text={errorMessage(page1.error)}
            />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={<Search size={24} />}
              title="Nothing matches"
              text="No loaded file matches the filter. Clear it, load more pages, or pick another category."
            />
          ) : (
            <>
              <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-12">
                {shown.map((card) => (
                  <JkhubCard
                    key={card.id}
                    card={card}
                    categoryName={
                      category ? names.get(category.id)?.name : undefined
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
                  <Button onClick={() => setPages((count) => count + 1)}>
                    Load more
                  </Button>
                ) : (
                  <span className="text-body-sm text-fg-muted">
                    {cards.length} of {totalPages * (page1.data?.perPage ?? 25)}{" "}
                    files loaded. Narrow the category or change the order to see
                    the rest.
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
          error={details.error ? errorMessage(details.error) : null}
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

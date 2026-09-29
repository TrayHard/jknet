import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, ChevronRight, Library, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { useShareDialog } from "../../../../src/components/chat/ShareToChatDialog.tsx";
import { JkhubCard } from "../../../../src/components/library/JkhubCard.tsx";
import { byAuthor } from "../../../../src/components/library/jkhubQuery.ts";
import { useSectionName } from "../../../../src/components/library/jkhubSections.ts";
import { JkhubTree } from "../../../../src/components/library/JkhubTree.tsx";
import { Button, EmptyState, Input, Select } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useFormat } from "../../../../src/i18n/useFormat.ts";
import { backend } from "../../../../src/lib/backend.ts";
import { jkhubModCard } from "../../../../src/lib/chat/cardDrafts.ts";
import { useGameNames } from "../../../../src/lib/game.ts";
import { jkhubIpc, type JkhubSort, type SortDirection } from "../../../../src/lib/ipc.ts";
import { useJkhubCategories, useJkhubIndexStatus } from "../../../../src/lib/queries.ts";
import { jkhubPath, useSectionOf } from "../catalog/jkhub.ts";
import { GameSwitch } from "../catalog/GameSwitch.tsx";
import { catalogUnavailable } from "../catalog/serverList.ts";
import { useCatalogGame, useQueryWriter } from "../catalog/useCatalogGame.ts";

/** Cards of one page, the launcher's `RESULTS_PER_PAGE`. */
const PAGE = 25;

/** How long the search waits after a keystroke before it asks the service. */
const DEBOUNCE_MS = 300;

const SORTS: readonly JkhubSort[] = ["recentlyUpdated", "newest", "mostDownloaded", "topRated", "name"];

/** A whole number of the address from 1, or `null`. */
function positive(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  const number = Number(value);
  return number >= 1 ? number : null;
}

/**
 * The JKHub mods of the catalog JKNet Online keeps, read only: the search
 * with the launcher's query syntax (`by:"Circa" duel after:2025-01-01`), the
 * game, the eight sections with their counts, the order, and 25 cards a
 * page. Everything lives in the address
 * (`/jkhub?game=ja&q=hilt&category=1000024&sort=mostDownloaded&page=2`), so
 * a view can be shared as a link.
 *
 * A card opens the file's page beside the list or, on a phone, in its place;
 * its button opens the file on JKHub, and its share button sends it to a
 * chat. Installing is JKNet's on the PC. A catalog the service does not
 * serve yet — switched off, or still being built — says so instead of an
 * empty grid.
 */
export function JkhubScreen() {
  const { t } = useTranslation("jkhub");
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const navigate = useNavigate();
  const location = useLocation();
  const gameNames = useGameNames();
  const sectionName = useSectionName();
  const share = useShareDialog();
  const { game, setGame } = useCatalogGame();
  const [params] = useSearchParams();
  const write = useQueryWriter();
  const q = params.get("q") ?? "";
  const category = positive(params.get("category"));
  const sortValue = params.get("sort") ?? "";
  const sort: JkhubSort = (SORTS as readonly string[]).includes(sortValue) ? (sortValue as JkhubSort) : "recentlyUpdated";
  const direction: SortDirection = params.get("dir") === "asc" ? "asc" : "desc";
  const page = positive(params.get("page")) ?? 1;
  const searchInput = useRef<HTMLInputElement>(null);
  const [treeOpen, setTreeOpen] = useState(false);

  // The box follows the address when it changes under it, and writes it a
  // moment after the typing stops.
  const [typed, setTyped] = useState(q);
  const written = useRef(q);
  useEffect(() => {
    if (q === written.current) return;
    written.current = q;
    setTyped(q);
  }, [q]);
  useEffect(() => {
    const next = typed.trim();
    if (next === q) return;
    const timer = setTimeout(() => {
      written.current = next;
      write({ q: next, page: "" });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed, q, write]);

  const status = useJkhubIndexStatus(game);
  const categories = useJkhubCategories(game, status.data?.available === true);
  const tree = useMemo(() => categories.data?.categories ?? [], [categories.data]);
  const sectionOf = useSectionOf(tree);
  const available = status.data?.available === true;

  const search = useQuery({
    queryKey: ["jkhub", "search", game, q, category, sort, PAGE, direction, page],
    queryFn: () => jkhubIpc.search({ game, query: q, categoryId: category, sort, direction, page, perPage: PAGE }),
    enabled: available,
    staleTime: 5 * 60_000,
    // The page on screen stays while the next one, or a narrower query, loads.
    placeholderData: (previous) => previous,
    retry: (failures, error) => !catalogUnavailable(error) && failures < 1,
  });
  const cards = search.data?.cards ?? [];
  const total = search.data?.total ?? 0;
  const pages = Math.max(search.data?.pages ?? 1, 1);
  const counts = q ? (search.data?.categoryCounts ?? {}) : null;
  const totals = q ? null : (search.data?.categoryCounts ?? null);
  const picked = category === null ? null : (tree.find((entry) => entry.id === category) ?? null);

  const failure = status.error ?? search.error ?? null;
  const unavailable = (failure !== null && catalogUnavailable(failure)) || status.data?.available === false;

  return (
    <div className="flex flex-col pb-16" data-testid="jkhub-list">
      <div className="flex flex-col gap-8 px-16 pt-4 pb-12">
        <Input
          ref={searchInput}
          icon={<Search size={16} />}
          aria-label={tWeb("jkhub.search")}
          placeholder={tWeb("jkhub.search")}
          value={typed}
          disabled={unavailable}
          onChange={(event) => setTyped(event.target.value)}
          trailing={
            typed ? (
              <button
                type="button"
                aria-label={tWeb("serverList.clearSearch")}
                title={tWeb("serverList.clearSearch")}
                onClick={() => {
                  setTyped("");
                  searchInput.current?.focus();
                }}
                className="inline-flex size-20 items-center justify-center rounded-sm text-fg-muted hover:text-fg cursor-pointer select-none"
              >
                <X size={14} aria-hidden />
              </button>
            ) : undefined
          }
        />
        {/* The sections of the two games have ids of their own: a switch
            starts over on the whole catalogue of the other game. */}
        <GameSwitch game={game} onChange={(next) => setGame(next, { category: "", page: "" })} />
        <p className="text-body-sm text-fg-secondary">{tWeb("jkhub.lead")}</p>
        {!unavailable ? (
          <>
            <div className="flex items-center gap-8">
              <Select
                ariaLabel={t("sort.label")}
                options={SORTS.map((id) => ({ value: id, label: t(`sort.${id}`) }))}
                value={sort}
                onChange={(value) => write({ sort: value === "recentlyUpdated" ? "" : value, page: "" })}
                className="min-w-0 flex-1"
              />
              <Button
                size="sm"
                variant="ghost"
                icon={direction === "asc" ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
                aria-label={direction === "asc" ? tWeb("jkhub.ascending") : tWeb("jkhub.descending")}
                title={direction === "asc" ? tWeb("jkhub.ascending") : tWeb("jkhub.descending")}
                onClick={() => write({ dir: direction === "asc" ? "" : "asc", page: "" })}
              />
            </div>
            <div className="flex flex-col gap-4">
              <button
                type="button"
                aria-expanded={treeOpen}
                aria-controls="jkhub-tree"
                onClick={() => setTreeOpen((open) => !open)}
                className="flex min-h-36 items-center gap-6 rounded-md px-4 text-left text-body-sm-medium text-fg-secondary cursor-pointer hover:bg-hover-overlay hover:text-fg"
              >
                {treeOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
                <span className="min-w-0 flex-1 truncate">
                  {tWeb("jkhub.categoryLine", { name: picked !== null ? sectionName(picked) : tWeb("jkhub.allCategories") })}
                </span>
              </button>
              {treeOpen ? (
                <div id="jkhub-tree" className="rounded-md border border-line-subtle bg-surface p-8" data-testid="jkhub-tree">
                  {category !== null ? (
                    <Button size="sm" variant="ghost" className="mb-8" onClick={() => write({ category: "", page: "" })}>
                      {t("empty.showAllCategories")}
                    </Button>
                  ) : null}
                  <JkhubTree
                    categories={tree}
                    selected={category}
                    onSelect={(entry) => write({ category: String(entry.id), page: "" })}
                    counts={counts}
                    totals={totals}
                  />
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {available && search.data !== undefined ? (
          <p className="text-body-sm text-fg-muted" role="status">
            {t("search.results", { count: total, game: gameNames.label(game) })}
            {status.data?.updatedAt ? ` · ${tWeb("jkhub.indexedAt", { date: format.date(status.data.updatedAt) })}` : null}
          </p>
        ) : null}
      </div>

      {status.isLoading || (available && search.isLoading) ? (
        <p role="status" className="px-16 py-12 text-body-sm text-fg-muted">
          {t("loading.files")}
        </p>
      ) : unavailable ? (
        <EmptyState
          className="mx-16"
          icon={<Library size={24} />}
          title={tWeb("jkhub.unavailableTitle")}
          text={tWeb("jkhub.unavailableText")}
          action={
            <Button
              disabled={status.isFetching}
              onClick={() => {
                void status.refetch();
                void search.refetch();
              }}
            >
              {tCommon("actions.tryAgain")}
            </Button>
          }
        />
      ) : failure !== null ? (
        <EmptyState
          className="mx-16"
          icon={<AlertTriangle size={24} />}
          title={t("empty.categoryTitle")}
          text={errorText(failure)}
          action={
            <Button disabled={search.isFetching} onClick={() => void search.refetch()}>
              {tCommon("actions.tryAgain")}
            </Button>
          }
        />
      ) : cards.length === 0 ? (
        <EmptyState
          className="mx-16"
          icon={<Search size={24} />}
          title={t("empty.filteredTitle")}
          text={tWeb("jkhub.emptyText")}
          action={
            category !== null ? (
              <Button onClick={() => write({ category: "", page: "" })}>{t("empty.showAllCategories")}</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(216px,100%),1fr))] gap-12 px-16" aria-label={tWeb("jkhub.results")}>
            {cards.map((card) => (
              <JkhubCard
                key={card.id}
                card={card}
                categoryName={sectionOf(card.categoryId)}
                installed={false}
                // The card's one button opens the file on JKHub: nothing is
                // installed from a browser.
                openOnly
                busy={false}
                onOpen={() => void navigate(`${jkhubPath(game, card.id)}${location.search}`)}
                onInstall={() => undefined}
                onOpenSite={() => void backend().openExternal(card.url)}
                onShare={share.available ? () => share.open({ kind: "card", card: jkhubModCard({ ...card, game }, game) }) : undefined}
                onAuthor={(author) => setTyped((current) => byAuthor(current, author))}
              />
            ))}
          </ul>
          {pages > 1 ? (
            <nav className="flex items-center justify-between gap-8 px-16 pt-16" aria-label={tWeb("jkhub.pages")}>
              <Button size="sm" disabled={page <= 1} onClick={() => write({ page: page - 1 <= 1 ? "" : String(page - 1) })}>
                {tWeb("jkhub.previous")}
              </Button>
              <span className="text-body-sm text-fg-muted" data-testid="jkhub-page">
                {tWeb("jkhub.page", { page: Math.min(page, pages), pages })}
              </span>
              <Button size="sm" disabled={page >= pages} onClick={() => write({ page: String(page + 1) })}>
                {tWeb("jkhub.next")}
              </Button>
            </nav>
          ) : null}
        </>
      )}
      {share.dialog}
    </div>
  );
}

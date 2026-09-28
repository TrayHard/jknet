import { AlertTriangle, Search, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import { BundleCard } from "../../../../src/components/bundles/BundleCard.tsx";
import { Button, EmptyState, Input, Select } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useGameNames } from "../../../../src/lib/game.ts";
import { onlineErrorCode, type BundleSort } from "../../../../src/lib/ipc.ts";
import { useBundles } from "../../../../src/lib/queries.ts";
import { setCatalogCount } from "../catalog/counts.ts";
import { GameSwitch } from "../catalog/GameSwitch.tsx";
import { useCatalogGame, useQueryValue } from "../catalog/useCatalogGame.ts";

const SORTS: readonly BundleSort[] = ["popular", "new", "installs"];

/** How long the search waits after a keystroke before it asks the service. */
const DEBOUNCE_MS = 300;

/** The most cards one page of the catalogue holds, as in the launcher's tab. */
const PAGE = 100;

/** The path of a bundle's page. */
export function bundlePath(bundleId: string): string {
  return `/bundles/${encodeURIComponent(bundleId)}`;
}

/**
 * The bundles of JKNet Online, read only: the search, the game switch and
 * the order in the address (`/bundles?game=jo&q=duel&sort=new`), so a
 * filtered view can be shared as a link, and a card per bundle, the
 * launcher's. A card opens the bundle's page beside the list or, on a phone,
 * in its place; the page keeps the list's address, so going back finds the
 * list as it was.
 */
export function BundlesScreen({ selectedId }: { selectedId?: string }) {
  const { t } = useTranslation("bundles");
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const location = useLocation();
  const { label: gameName } = useGameNames();
  const { game, setGame } = useCatalogGame();
  const [q, setQ] = useQueryValue("q");
  const [sortValue, setSort] = useQueryValue("sort");
  const sort: BundleSort = (SORTS as readonly string[]).includes(sortValue) ? (sortValue as BundleSort) : "popular";
  const searchInput = useRef<HTMLInputElement>(null);

  // The box follows the address when it changes under it — the browser's
  // back, a pasted link — and writes it a moment after the typing stops.
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
      setQ(next);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed, q, setQ]);

  const list = useBundles({ game, sort, q, limit: PAGE });
  const cards = list.data?.items ?? [];
  const total = list.data?.total ?? cards.length;
  const filtered = q !== "";

  // The menu's count of this game's bundles comes from an unfiltered list.
  useEffect(() => {
    if (!filtered && list.data !== undefined && !list.isPlaceholderData) {
      setCatalogCount(`bundles:${game}`, list.data.total);
    }
  }, [filtered, game, list.data, list.isPlaceholderData]);

  return (
    <div className="flex flex-col pb-16" data-testid="bundles-list">
      <div className="flex flex-col gap-8 px-16 pt-4 pb-12">
        <Input
          ref={searchInput}
          icon={<Search size={16} />}
          aria-label={t("toolbar.search")}
          placeholder={t("toolbar.search")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          trailing={
            typed ? (
              <button
                type="button"
                aria-label={t("toolbar.clearSearch")}
                title={t("toolbar.clearSearch")}
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
        <GameSwitch game={game} onChange={setGame} />
        <p className="text-body-sm text-fg-secondary">{tWeb("catalog.bundlesLead")}</p>
        <div className="flex items-center gap-8">
          <span className="min-w-0 flex-1 truncate text-body-sm text-fg-muted">
            {list.data !== undefined && cards.length > 0 ? t("list.results", { count: total }) : null}
          </span>
          <Select
            ariaLabel={t("toolbar.sort")}
            options={SORTS.map((id) => ({ value: id, label: t(`toolbar.sortBy.${id}`) }))}
            value={sort}
            onChange={(value) => setSort(value === "popular" ? "" : value)}
            className="w-160 shrink-0"
          />
        </div>
      </div>

      {list.isLoading ? (
        <p role="status" className="px-16 py-12 text-body-sm text-fg-muted">
          {t("list.loading")}
        </p>
      ) : list.error ? (
        <EmptyState
          className="mx-16"
          icon={<AlertTriangle size={24} />}
          title={t("list.errorTitle")}
          text={onlineErrorCode(list.error) === "not_found" ? t("list.unsupported") : errorText(list.error)}
          action={
            <Button disabled={list.isFetching} onClick={() => void list.refetch()}>
              {tCommon("actions.tryAgain")}
            </Button>
          }
        />
      ) : cards.length === 0 ? (
        <EmptyState
          className="mx-16"
          icon={filtered ? <Search size={24} /> : <Upload size={24} />}
          title={filtered ? t("list.filteredTitle") : t("list.emptyTitle", { game: gameName(game) })}
          text={filtered ? t("list.filteredText") : tWeb("catalog.bundlesEmpty")}
        />
      ) : (
        <ul className="flex flex-col gap-10 px-16">
          {cards.map((card) => (
            <BundleCard
              key={card.id}
              card={card}
              installed={false}
              selected={card.id === selectedId}
              onOpen={() => void navigate(`${bundlePath(card.id)}${location.search}`)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

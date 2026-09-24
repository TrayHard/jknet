import {
  AlertTriangle,
  ClipboardCheck,
  FilePen,
  Link2,
  Package,
  Plus,
  Search,
  Trash2,
  Upload,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { OPEN_BUNDLE_PARAM, draftRoute } from "../../lib/bundleRoutes";
import { useActiveGame, useGameNames } from "../../lib/game";
import { onlineErrorCode, type BundleSort, type DraftSummary } from "../../lib/ipc";
import {
  useAccountState,
  useBundleDrafts,
  useBundles,
  useClients,
  useCreateBundleDraft,
  useDeleteBundleDraft,
  useEnginesOfGame,
  useIsBundleAdmin,
  useOnlineConfigured,
} from "../../lib/queries";
import { Badge, Button, Dialog, EmptyState, Input, Select, type SelectOption } from "../ui";
import { BundleCard } from "./BundleCard";
import { BundleDetailsDialog } from "./BundleDetailsDialog";
import { MyBundlesDialog } from "./MyBundlesDialog";
import { ReviewQueueDialog } from "./ReviewQueueDialog";

const SORT_IDS: BundleSort[] = ["popular", "new", "installs"];

/** How long the search waits after a keystroke before it asks the service. */
const DEBOUNCE_MS = 300;

/** The most cards one page of the catalogue holds. */
const PAGE = 100;

/**
 * --- slice: bundles ---
 *
 * The **Bundles** tab of the Clients screen: the drafts on this disk, then
 * the catalogue of JKNet Online.
 *
 * The drafts come first because they are the player's own work: a strip with
 * **New bundle** and a card per draft of the active game, each with
 * **Continue** into the editor and **Delete**. Under it the catalogue has the
 * shape of the JKHub tab of the Library screen without the rail: a bar with
 * the search box, the order and the engine, and a grid of cards. The game is
 * the one in the sidebar switcher, as it is everywhere else. **My bundles**
 * and, for an administrator, **Review queue** stand at the end of the bar and
 * open dialogs of their own.
 */
export function BundlesTab() {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const { t: tAccount } = useTranslation("account");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const configured = useOnlineConfigured();
  const game = useActiveGame();
  const { label: gameName } = useGameNames();
  const engines = useEnginesOfGame(game);
  const clients = useClients();
  const account = useAccountState();
  const isAdmin = useIsBundleAdmin();

  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BundleSort>("popular");
  const [engineId, setEngineId] = useState<string>("");
  const [openBundle, setOpenBundle] = useState<string | null>(null);
  const [mineOpen, setMineOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  // The editor sends a player here with `?bundle=<id>` after a publish: the
  // record opens and the parameter goes, so a reload does not reopen it.
  const [search, setSearch] = useSearchParams();
  const askedFor = search.get(OPEN_BUNDLE_PARAM);
  useEffect(() => {
    if (askedFor === null) return;
    setOpenBundle(askedFor);
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(OPEN_BUNDLE_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [askedFor, setSearch]);

  // The search waits out a burst of typing: every keystroke would otherwise
  // be a request to the service.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // A switch of game is a switch of catalogue, and the engines of the other
  // game are not in this one's list.
  useEffect(() => {
    setEngineId("");
    setOpenBundle(null);
  }, [game]);

  const list = useBundles(
    {
      game,
      sort,
      q: query,
      engineId: engineId === "" ? null : engineId,
      limit: PAGE,
    },
    // No service, no catalogue: the tab says so instead of asking and failing.
    configured !== false,
  );

  const signedIn = account.data?.onlineSignedIn === true;
  const cards = list.data?.items ?? [];
  const total = list.data?.total ?? cards.length;
  const filtered = query !== "" || engineId !== "";

  const engineOptions: SelectOption[] = useMemo(
    () => [
      { value: "", label: t("toolbar.anyEngine") },
      ...engines.map((engine) => ({ value: engine.id, label: engine.name })),
    ],
    [engines, t],
  );

  // Which bundles a client of this machine came out of, for the badge.
  const installedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const client of clients.data ?? []) {
      if (client.bundle?.bundleId) ids.add(client.bundle.bundleId);
    }
    return ids;
  }, [clients.data]);

  return (
    <>
      <DraftsStrip onOpen={(draftId) => void navigate(draftRoute(draftId))} />

      <h2 className="text-label-xs text-fg-muted pb-12">{t("catalogue.heading")}</h2>

      {configured === false ? (
        <EmptyState
          icon={<WifiOff size={24} />}
          title={t("list.offTitle")}
          text={tAccount("notConfigured")}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-12 pb-16">
            <Input
              ref={searchInput}
              icon={<Search size={16} />}
              aria-label={t("toolbar.search")}
              placeholder={t("toolbar.search")}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="flex-1 min-w-200 max-w-[420px]"
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
            <Select
              ariaLabel={t("toolbar.sort")}
              label={t("toolbar.sort")}
              options={SORT_IDS.map((id) => ({ value: id, label: t(`toolbar.sortBy.${id}`) }))}
              value={sort}
              onChange={(value) => setSort(value as BundleSort)}
              className="w-200"
            />
            <Select
              ariaLabel={t("toolbar.engine")}
              label={t("toolbar.engine")}
              options={engineOptions}
              value={engineId}
              onChange={setEngineId}
              className="w-200"
            />
            <div className="ml-auto flex items-center gap-8">
              {isAdmin ? (
                <Button icon={<ClipboardCheck size={16} />} onClick={() => setReviewOpen(true)}>
                  {t("toolbar.reviewQueue")}
                </Button>
              ) : null}
              <Button
                icon={<Package size={16} />}
                disabled={!signedIn}
                title={signedIn ? undefined : t("toolbar.myBundlesSignIn")}
                onClick={() => setMineOpen(true)}
              >
                {t("toolbar.myBundles")}
              </Button>
            </div>
          </div>

          {list.isLoading ? (
            <p className="text-body-sm text-fg-muted">{t("list.loading")}</p>
          ) : list.error ? (
            <EmptyState
              icon={<AlertTriangle size={24} />}
              title={t("list.errorTitle")}
              text={
                // A service from before bundles answers 404 on the catalogue;
                // the account wording of `online.notFound` would send the
                // player to sign in again for nothing.
                onlineErrorCode(list.error) === "not_found"
                  ? t("list.unsupported")
                  : errorText(list.error)
              }
              action={
                <Button disabled={list.isFetching} onClick={() => void list.refetch()}>
                  {tCommon("actions.tryAgain")}
                </Button>
              }
            />
          ) : cards.length === 0 ? (
            <EmptyState
              icon={filtered ? <Search size={24} /> : <Upload size={24} />}
              title={filtered ? t("list.filteredTitle") : t("list.emptyTitle", { game: gameName(game) })}
              text={filtered ? t("list.filteredText") : t("list.emptyText")}
            />
          ) : (
            <>
              <p className="text-body-sm text-fg-muted pb-12">{t("list.results", { count: total })}</p>
              {/* The same grid as the JKHub tab: columns follow the width of the
                  list, and a card never grows past its share of a row. */}
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(216px,100%),1fr))] gap-12">
                {cards.map((card) => (
                  <BundleCard
                    key={card.id}
                    card={card}
                    installed={installedIds.has(card.id)}
                    onOpen={() => setOpenBundle(card.id)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {openBundle !== null ? (
        <BundleDetailsDialog key={openBundle} bundleId={openBundle} onClose={() => setOpenBundle(null)} />
      ) : null}
      {mineOpen ? (
        <MyBundlesDialog
          onClose={() => setMineOpen(false)}
          onOpen={(bundleId) => {
            setMineOpen(false);
            setOpenBundle(bundleId);
          }}
          onEdit={(draftId) => {
            setMineOpen(false);
            void navigate(draftRoute(draftId));
          }}
        />
      ) : null}
      {reviewOpen ? <ReviewQueueDialog onClose={() => setReviewOpen(false)} /> : null}
    </>
  );
}

/**
 * The drafts of the active game, with the button that starts one.
 *
 * A draft lives in the data folder of the launcher and is written by every
 * edit, so the strip has nothing to save and nothing to lose: **Continue**
 * opens the editor where the author left it, **Delete** removes the folder
 * after a question. A draft bound to a published bundle says so; its next
 * publish is a version of that bundle.
 */
function DraftsStrip({ onOpen }: { onOpen: (draftId: string) => void }) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const game = useActiveGame();
  const drafts = useBundleDrafts();
  const create = useCreateBundleDraft();
  const remove = useDeleteBundleDraft();
  const [pendingDelete, setPendingDelete] = useState<DraftSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const mine = (drafts.data ?? []).filter((draft) => draft.game === game);

  const startDraft = () => {
    setFailure(null);
    create.mutate(
      { game, name: t("drafts.defaultName") },
      {
        onSuccess: (draft) => onOpen(draft.id),
        onError: (e) => setFailure(errorText(e)),
      },
    );
  };

  return (
    <section className="flex flex-col gap-12 pb-24">
      <div className="flex items-center gap-12">
        <h2 className="text-label-xs text-fg-muted flex-1">{t("drafts.heading")}</h2>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={create.isPending}
          onClick={startDraft}
        >
          {create.isPending ? tCommon("states.creating") : t("drafts.newBundle")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {failure}
        </p>
      ) : null}
      {drafts.error ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {errorText(drafts.error)}
        </p>
      ) : null}

      {mine.length === 0 ? (
        <p className="text-body-sm text-fg-muted">{t("drafts.empty")}</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-12">
          {mine.map((draft) => (
            <li
              key={draft.id}
              className="flex flex-col gap-8 rounded-lg border border-line bg-surface p-12"
            >
              <div className="flex items-start gap-8 min-w-0">
                <FilePen size={16} className="text-fg-muted shrink-0 mt-2" aria-hidden />
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  <span className="text-body-md-medium text-fg truncate" title={draft.name}>
                    {draft.name}
                  </span>
                  <span className="text-body-sm text-fg-muted">
                    {t("drafts.components", { count: draft.componentCount })}
                    {" · "}
                    {t("card.files", { count: draft.fileCount })}
                    {" · "}
                    {format.bytes(draft.blobBytes)}
                  </span>
                  <span className="text-mono-xs text-fg-muted">
                    {t("drafts.updated", { date: format.date(draft.updatedAt) })}
                  </span>
                </div>
                {draft.bundleId ? (
                  <Badge tone="purple" icon={<Link2 size={12} />} className="shrink-0" title={t("drafts.linkedHint")}>
                    {t("drafts.linked")}
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-8">
                <Button size="sm" variant="primary" onClick={() => onOpen(draft.id)}>
                  {t("drafts.continue")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={14} />}
                  disabled={remove.isPending}
                  onClick={() => setPendingDelete(draft)}
                >
                  {t("drafts.delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete !== null ? (
        <Dialog
          title={t("drafts.confirmTitle", { draft: pendingDelete.name })}
          body={t("drafts.confirmBody")}
          variant="danger"
          onClose={() => setPendingDelete(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  setFailure(null);
                  remove.mutate(pendingDelete.id, {
                    onError: (e) => setFailure(errorText(e)),
                    onSettled: () => setPendingDelete(null),
                  });
                }}
              >
                {remove.isPending ? tCommon("states.deleting") : t("drafts.confirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </section>
  );
}

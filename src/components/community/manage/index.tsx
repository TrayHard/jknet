/**
 * The management screen of a community and the composer of its news, loaded
 * when they are opened: they carry the Markdown editor, which a reader of
 * the catalogue never needs.
 *
 * Not exported by `components/community/index.ts`. The launcher and the
 * website import this file, hand {@link CommunityManage} to `CommunityApp`
 * as `renderManage` and {@link CommunityNewsComposer} to the platform as
 * `renderNewsComposer`; the web app, which only reads, never bundles them.
 */

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

import type { ManageSection, NewsComposerProps } from "../platform";

const ManageScreen = lazy(() => import("./ManageScreen"));
const NewsComposer = lazy(() => import("./NewsComposer"));

function Loading() {
  const { t } = useTranslation("community");
  return (
    <p role="status" className="text-body-sm text-fg-muted">
      {t("common.loading")}
    </p>
  );
}

/** The management screen of the community `id`, opened on `section`. */
export function CommunityManage({ id, section }: { id: string; section?: ManageSection }) {
  return (
    <Suspense fallback={<Loading />}>
      <ManageScreen key={id} id={id} section={section} />
    </Suspense>
  );
}

/** The composer of the news of the **News** tab, for an organizer. */
export function CommunityNewsComposer(props: NewsComposerProps) {
  return (
    <Suspense fallback={<Loading />}>
      <NewsComposer {...props} />
    </Suspense>
  );
}

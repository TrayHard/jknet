/**
 * The management screen of a community, loaded when it is opened: it
 * carries the Markdown editors, which a reader of the catalogue never needs.
 *
 * Not exported by `components/community/index.ts`. The launcher and the
 * website import this file and hand {@link CommunityManage} to
 * `CommunityApp` as `renderManage`; the web app, which only reads, never
 * bundles it.
 */

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

import type { ManageSection } from "../platform";

const ManageScreen = lazy(() => import("./ManageScreen"));

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

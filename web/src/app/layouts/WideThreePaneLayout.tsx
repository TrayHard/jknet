import { useCallback } from "react";
import { Navigate } from "react-router";

import { DETAILS_COLUMN_QUERY, useMedia } from "../useMedia.ts";
import { DetailsColumn, DetailsSheet } from "./DetailsSheet.tsx";
import { EmptyPane } from "./EmptyPane.tsx";
import { NavRail } from "./NavRail.tsx";
import type { LayoutProps } from "./types.ts";

/**
 * The wide screen: W1, three panes.
 *
 * The rail with the seven sections, the list pane (320 px) and the content
 * pane (the rest, at least 500 px): the detail of the route, or the
 * section's empty pane. A route with an aside adds the details column —
 * 288 px beside the content from 1200 px on, a sheet over its right edge
 * below that. There is no back button: the list stays on screen and the
 * browser's back walks the history. Dialogs stay centred, as in the launcher.
 */
export function WideThreePaneLayout({ view, nav, me, navigate, banners }: LayoutProps) {
  const column = useMedia(DETAILS_COLUMN_QUERY);
  const { parent } = view;
  const closeAside = useCallback(() => {
    if (parent !== undefined) navigate(parent);
  }, [navigate, parent]);

  if (view.detail === undefined && view.defaultDetail !== undefined) {
    return <Navigate to={view.defaultDetail} replace />;
  }

  const listTitle = nav.find((item) => item.section === view.section)?.label ?? view.title;
  const asideTitle = view.asideTitle ?? view.title;

  return (
    <div data-layout="wide" className="flex h-full min-h-0 bg-app">
      <NavRail nav={nav} me={me} />
      <div className="flex min-w-0 flex-1 flex-col">
        {banners}
        <div className="flex min-h-0 flex-1">
          <section
            data-pane="list"
            aria-label={listTitle}
            className="flex w-320 shrink-0 flex-col border-r border-line-subtle bg-app"
          >
            <div className="flex min-h-64 shrink-0 items-center gap-8 px-16 pt-18 pb-12">
              <h1 className="min-w-0 flex-1 truncate text-display-md text-fg">{listTitle}</h1>
              {view.headerActions !== undefined ? (
                <div className="flex shrink-0 items-center gap-4">{view.headerActions}</div>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{view.list}</div>
          </section>

          <main data-pane="detail" className="relative flex min-w-500 flex-1 flex-col bg-surface">
            {view.detail !== undefined && view.ownHeader === true ? (
              <div className="flex min-h-0 flex-1 flex-col">{view.detail}</div>
            ) : view.detail !== undefined ? (
              <>
                <header className="flex h-64 shrink-0 items-center gap-12 border-b border-line-subtle px-24">
                  {view.detailHeader !== undefined ? (
                    <div className="flex min-w-0 flex-1 items-center">{view.detailHeader}</div>
                  ) : (
                    <h2 className="min-w-0 flex-1 truncate text-heading-md text-fg">{view.title}</h2>
                  )}
                  {view.detailActions !== undefined ? (
                    <div className="flex shrink-0 items-center gap-4">{view.detailActions}</div>
                  ) : null}
                </header>
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{view.detail}</div>
              </>
            ) : view.section === "settings" ? null : (
              <EmptyPane section={view.section} />
            )}
            {view.aside !== undefined && !column ? (
              <DetailsSheet title={asideTitle} onClose={closeAside}>
                {view.aside}
              </DetailsSheet>
            ) : null}
          </main>

          {view.aside !== undefined && column ? (
            <DetailsColumn title={asideTitle} onClose={closeAside}>
              {view.aside}
            </DetailsColumn>
          ) : null}
        </div>
      </div>
    </div>
  );
}

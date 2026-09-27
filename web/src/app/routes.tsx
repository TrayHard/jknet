import { useTranslation } from "react-i18next";
import { Navigate, useLocation, type RouteObject } from "react-router";

import { useAccountState } from "../../../src/lib/queries.ts";
import { LayoutHost, type RouteHandle } from "./LayoutHost.tsx";
import { HOME, ROUTES, SIGN_IN, SIGN_IN_DONE } from "./routeTable.ts";
import { SignInDoneScreen } from "./screens/SignInDoneScreen.tsx";
import { SignInScreen } from "./screens/SignInScreen.tsx";

/**
 * Everything inside the layout needs an account. Signed out, the path the
 * player asked for goes along as `next` and opens after the sign-in.
 */
function SignedInFrame() {
  const { t } = useTranslation("common");
  const account = useAccountState();
  const location = useLocation();
  if (account.data === undefined) {
    return (
      <p role="status" className="px-24 py-24 text-body-sm text-fg-muted">
        {t("states.loading")}
      </p>
    );
  }
  if (!account.data.onlineSignedIn) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`${SIGN_IN}?next=${next}`} replace />;
  }
  return <LayoutHost />;
}

/**
 * The route tree: the two sign-in pages full page, every route of
 * `routeTable.ts` inside the layout, and `/` or anything unknown to the chats.
 */
export const routes: RouteObject[] = [
  { path: SIGN_IN, element: <SignInScreen /> },
  { path: SIGN_IN_DONE, element: <SignInDoneScreen /> },
  {
    element: <SignedInFrame />,
    children: ROUTES.map((spec) => ({ path: spec.path, handle: { spec } satisfies RouteHandle })),
  },
  { path: "*", element: <Navigate to={HOME} replace /> },
];

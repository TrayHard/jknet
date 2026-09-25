import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { HostingInfo, JoinResult } from "../../lib/ipc";
import { useToasts } from "../ToastsProvider";

/** How long the toast of a join stays: long enough to read, gone before the game window. */
const JOIN_TOAST_MS = 8000;

/** The private server a join went to, as the presence or the invite named it. */
export interface JoinTarget {
  /** Display name of the host. */
  hostName: string;
  /** The server name the invite or the presence carried. */
  serverName: string | null;
  hosting: HostingInfo | null | undefined;
}

/**
 * The toast after **Join** on a private server: which way the game went.
 *
 * `lan` and `relay` say so, with the address the game connects to where the
 * answer names it: the relay has one address, a network may have several and
 * the core does not say which one answered. A server open to the host's
 * network only that did not answer here gets the warning instead: the game
 * starts anyway and keeps knocking. An ordinary server (`direct`) gets
 * nothing, as before.
 */
export function useJoinToast(): (result: JoinResult, target: JoinTarget) => void {
  const { t } = useTranslation("host");
  const { show, dismiss } = useToasts();

  return useCallback(
    (result: JoinResult, target: JoinTarget) => {
      if (result.path === "direct") return;
      const hosting = target.hosting ?? null;
      const server = target.serverName ?? target.hostName;
      const lan = hosting?.lanAddresses ?? [];
      const id = `join:${Date.now()}`;

      if (result.probeFailed) {
        show(id, {
          variant: "warning",
          title: t("join.probeFailed", { name: target.hostName }),
          text: lan[0] ? `${server} · ${lan[0]}` : server,
        });
      } else {
        const address =
          result.path === "relay" ? (hosting?.relayAddress ?? null) : lan.length === 1 ? lan[0] : null;
        show(id, {
          variant: "info",
          title: result.path === "relay" ? t("join.relay") : t("join.lan"),
          text: address ? `${server} · ${address}` : server,
        });
      }
      window.setTimeout(() => dismiss(id), JOIN_TOAST_MS);
    },
    [show, dismiss, t],
  );
}

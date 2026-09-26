import { ExternalLink } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { isTrustedLink, linkHost } from "../../lib/chat/linkify";
import { useOpenChatLink } from "../../lib/queries";
import { useToasts } from "../ToastsProvider";
import { Button, Dialog } from "../ui";
import { Layer } from "./Layer";
import { chatRefusal, CONFIRM_LINK } from "./refusal";

/**
 * --- slice: chat ---
 *
 * Opening a link of a message.
 *
 * jknet.app and jkhub.org open at once. Any other host asks first, naming
 * the host and showing the whole address: the words of a link and where it
 * goes are both written by another player. The core checks the address again
 * and opens it in the system browser; nothing opens inside the launcher.
 *
 * --- slice: chat cards ---
 * The core applies the same rule and refuses an address it wants confirmed
 * with `confirm_link`, naming the host. Should the two ever disagree, that
 * refusal opens the same dialog rather than a toast.
 */
export function useLinkOpener(): { open: (href: string) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<string | null>(null);
  const openLink = useOpenChatLink();
  const toasts = useToasts();
  const errorText = useErrorText();
  const { mutate } = openLink;
  const { show } = toasts;

  const go = useCallback(
    (url: string, confirmed: boolean) =>
      mutate(
        { url, confirmed },
        {
          onError: (error) => {
            if (!confirmed && chatRefusal(error)?.code === CONFIRM_LINK) {
              setPending(url);
              return;
            }
            show(`chat-link:${url}`, { variant: "error", title: errorText(error) });
          },
        },
      ),
    [mutate, show, errorText],
  );

  const open = useCallback(
    (href: string) => {
      if (isTrustedLink(href)) go(href, false);
      else setPending(href);
    },
    [go],
  );

  // --- slice: chat cards --- drawn into the body: a card asks for it from
  // inside a message group, whose paint is contained (`Layer`).
  const dialog =
    pending === null ? null : (
      <Layer>
        <LinkConfirmDialog
          href={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            go(pending, true);
            setPending(null);
          }}
        />
      </Layer>
    );

  return { open, dialog };
}

/**
 * **Open a link to {host}?** — the whole address, as it will open, and the
 * reminder that another player wrote it.
 */
export function LinkConfirmDialog({
  href,
  onCancel,
  onConfirm,
}: {
  href: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  return (
    <Dialog
      title={t("link.title", { host: linkHost(href) })}
      body={t("link.body")}
      onClose={onCancel}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {tCommon("actions.cancel")}
          </Button>
          <Button variant="primary" icon={<ExternalLink size={14} />} onClick={onConfirm}>
            {t("link.open")}
          </Button>
        </>
      }
    >
      <p className="mt-12 rounded-md border border-line bg-input p-10 text-mono-xs text-fg-secondary break-all [unicode-bidi:isolate]">
        {href}
      </p>
    </Dialog>
  );
}

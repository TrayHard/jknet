import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { useJkhubComments } from "../../lib/queries";
import { Button } from "../ui";
import { openJkhubLink } from "./jkhubLinks";

export function JkhubComments({ fileId, count }: { fileId: number; count: number }) {
  const { t } = useTranslation("jkhub");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();
  const errorText = useErrorText();
  const [page, setPage] = useState(1);
  const comments = useJkhubComments(fileId, page);
  return (
    <section className="flex flex-col gap-12 border-t border-line pt-16" aria-label={t("comments.title")}>
      <h3 className="text-heading-sm text-fg">{t("details.comments", { count: format.number(count) })}</h3>
      {comments.isLoading ? <p role="status" className="text-body-sm text-fg-muted">{t("comments.loading")}</p> : null}
      {comments.error ? <div role="alert" className="flex flex-col items-start gap-8 text-body-sm text-fg-danger">
        <p>{errorText(comments.error)}</p>
        <Button size="sm" disabled={comments.isFetching} onClick={() => void comments.refetch()}>{tCommon("actions.retry")}</Button>
      </div> : null}
      {comments.data?.stale ? <p role="status" className="text-body-sm text-fg-muted">{t("comments.stale")}</p> : null}
      {comments.data?.items.length === 0 ? <p className="text-body-sm text-fg-muted">{t("comments.empty")}</p> : null}
      {comments.data?.items.map((comment) => (
        <article key={comment.id} className="rounded-md border border-line bg-elevated p-12 flex flex-col gap-8">
          <header className="flex flex-wrap items-baseline justify-between gap-8">
            <span className="text-body-sm-medium text-fg">{comment.author || t("details.authorUnknown")}</span>
            {comment.postedAt ? <time dateTime={comment.postedAt} className="text-body-sm text-fg-muted">{format.date(comment.postedAt)}</time> : null}
          </header>
          <div className="jkhub-richtext" onClick={openJkhubLink} dangerouslySetInnerHTML={{ __html: comment.contentHtml }} />
        </article>
      ))}
      {page > 1 || (comments.data?.pages ?? 1) > 1 ? (
        <nav aria-label={t("comments.pages")} className="flex items-center justify-between gap-8">
          <Button size="sm" disabled={page <= 1 || comments.isFetching} onClick={() => setPage(page - 1)}>{t("comments.previous")}</Button>
          <span className="text-body-sm text-fg-muted">{t("comments.page", { page, total: comments.data?.pages ?? page })}</span>
          <Button size="sm" disabled={!comments.data || page >= comments.data.pages || comments.isFetching} onClick={() => setPage(page + 1)}>{t("comments.next")}</Button>
        </nav>
      ) : null}
    </section>
  );
}

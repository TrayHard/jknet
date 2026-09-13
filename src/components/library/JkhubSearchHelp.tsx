import { CircleHelp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Dialog } from "../ui";

const OPERATORS = ["words", "author", "exactAuthor", "after", "before"] as const;

export function JkhubSearchHelp() {
  const { t } = useTranslation("jkhub");
  const { t: tCommon } = useTranslation("common");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="px-8 shrink-0" aria-label={t("search.helpTitle")} title={t("search.helpTitle")} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <CircleHelp size={18} aria-hidden />
      </Button>
      {open ? (
        <Dialog title={t("search.helpTitle")} body={t("search.helpScope")} wide onClose={() => setOpen(false)} actions={<Button onClick={() => setOpen(false)}>{tCommon("actions.close")}</Button>}>
          <div className="max-h-[60vh] overflow-y-auto pt-16 flex flex-col gap-16">
            <dl className="flex flex-col gap-12">
              {OPERATORS.map((operator) => (
                <div key={operator} className="grid grid-cols-[200px_1fr] gap-16">
                  <dt className="text-mono-sm text-fg-accent"><code>{t(`search.help.${operator}.example`)}</code></dt>
                  <dd className="text-body-sm text-fg-secondary">{t(`search.help.${operator}.text`)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-body-sm text-fg-secondary">{t("search.helpCombine")}</p>
            <code className="text-mono-sm text-fg rounded-md bg-elevated p-12 break-words">{t("search.helpExample")}</code>
            <p className="text-body-sm text-fg-muted">{t("search.helpRules")}</p>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

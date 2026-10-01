import { Globe, MessageCircle, Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input, Select } from "../../ui";
import { LINK_NAMES } from "../format";
import type { CommunityDiscord } from "../types";
import type { Remote } from "../useRemote";
import { changed, rowKey, type ManageDraft } from "./model";
import { Field, FieldNote, Section, useProblemText, type NoteTone } from "./parts";
import { LIMITS, LINK_KINDS, type DraftProblems } from "./validate";

/**
 * **Links**: the website and the Discord invite side by side, then up to
 * eight other links, each a kind and an address on a host of that kind.
 *
 * The invite is checked by the service against Discord: once it is saved,
 * the line under the field says whether it works, from
 * `GET communities/{id}/discord`.
 */
export function LinksSection({
  base,
  draft,
  problems,
  edit,
  discord,
}: {
  base: ManageDraft;
  draft: ManageDraft;
  problems: DraftProblems;
  edit: (patch: Partial<ManageDraft>) => void;
  /** What the service says of the saved invite; `undefined` data while it is asked. */
  discord: Remote<CommunityDiscord>;
}) {
  const { t } = useTranslation("community");
  const problemText = useProblemText();
  const id = useId();
  const kindName = (kind: string) => (kind === "other" ? t("manage.links.other") : (LINK_NAMES[kind] ?? kind));

  const websiteNote = problems.website ? (
    <FieldNote id={`${id}-website-note`} tone="bad">
      {problemText(problems.website, { max: LIMITS.link })}
    </FieldNote>
  ) : (
    <FieldNote id={`${id}-website-note`}>{t("manage.links.websiteHint")}</FieldNote>
  );

  let discordTone: NoteTone = "neutral";
  let discordText: string;
  if (problems.discord) {
    discordTone = "bad";
    discordText = problemText(problems.discord, { max: LIMITS.link });
  } else if (draft.discord.trim() === "") {
    discordText = t("manage.links.discordHint");
  } else if (changed(base, draft, "discord")) {
    discordText = t("manage.links.discordUnsaved");
  } else if (discord.data === undefined) {
    discordText = discord.error ? t("manage.links.discordUnavailable") : t("manage.links.discordChecking");
  } else if (discord.data.inviteStatus === "ok" && discord.data.invite) {
    discordTone = "ok";
    const invite = discord.data.invite;
    discordText =
      invite.members !== null
        ? t("manage.links.discordOkMembers", { name: invite.name, count: invite.members })
        : t("manage.links.discordOk", { name: invite.name });
  } else if (discord.data.inviteStatus === "invalid") {
    discordTone = "warn";
    discordText = t("manage.links.discordInvalid");
  } else if (discord.data.inviteStatus === "none") {
    discordTone = "warn";
    discordText = t("manage.links.discordNotInvite");
  } else {
    discordText = t("manage.links.discordUnavailable");
  }

  const setLink = (key: number, patch: { kind?: string; url?: string }) =>
    edit({ links: draft.links.map((link) => (link.key === key ? { ...link, ...patch } : link)) });

  return (
    <Section section="links" title={t("manage.sections.links")}>
      <div className="grid grid-cols-2 gap-16 @max-[880px]/community:grid-cols-1">
        <Field label={t("manage.links.website")} htmlFor={`${id}-website`} note={websiteNote}>
          <Input
            id={`${id}-website`}
            type="url"
            inputMode="url"
            spellCheck={false}
            icon={<Globe size={16} />}
            placeholder={t("manage.links.websitePlaceholder")}
            value={draft.website}
            invalid={problems.website !== undefined}
            aria-describedby={`${id}-website-note`}
            onChange={(event) => edit({ website: event.target.value })}
          />
        </Field>
        <Field
          label={t("manage.links.discord")}
          htmlFor={`${id}-discord`}
          note={
            <div aria-live="polite">
              <FieldNote id={`${id}-discord-note`} tone={discordTone}>
                {discordText}
              </FieldNote>
            </div>
          }
        >
          <Input
            id={`${id}-discord`}
            type="url"
            inputMode="url"
            spellCheck={false}
            icon={<MessageCircle size={16} />}
            placeholder={t("manage.links.discordPlaceholder")}
            value={draft.discord}
            invalid={problems.discord !== undefined}
            aria-describedby={`${id}-discord-note`}
            onChange={(event) => edit({ discord: event.target.value })}
          />
        </Field>
      </div>

      <div className="flex min-w-0 flex-col gap-8">
        <div className="flex items-baseline justify-between gap-8">
          <span className="text-body-sm-medium text-fg-secondary">{t("manage.links.others")}</span>
          <span className="text-mono-xs text-fg-secondary">{t("manage.links.count", { count: draft.links.length, max: LIMITS.links })}</span>
        </div>
        {draft.links.map((link) => {
          const problem = problems.links[link.key];
          const name = kindName(link.kind);
          return (
            <div key={link.key} className="flex min-w-0 flex-col gap-6">
              <div className="grid grid-cols-[148px_minmax(0,1fr)_auto] items-center gap-8 @max-[560px]/community:grid-cols-[minmax(0,1fr)_auto]">
                <Select
                  value={link.kind}
                  onChange={(kind) => setLink(link.key, { kind })}
                  ariaLabel={t("manage.links.kind")}
                  className="@max-[560px]/community:col-span-2"
                  options={[...LINK_KINDS, ...(LINK_KINDS.includes(link.kind as (typeof LINK_KINDS)[number]) ? [] : [link.kind])].map((kind) => ({
                    value: kind,
                    label: kindName(kind),
                  }))}
                />
                <Input
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  aria-label={t("manage.links.address", { kind: name })}
                  aria-describedby={problem ? `${id}-link-${link.key}` : undefined}
                  placeholder={t("manage.links.websitePlaceholder")}
                  value={link.url}
                  invalid={problem !== undefined}
                  onChange={(event) => setLink(link.key, { url: event.target.value })}
                />
                <Button
                  variant="ghost"
                  icon={<Trash2 size={16} />}
                  aria-label={t("manage.links.remove", { kind: name })}
                  title={t("manage.links.remove", { kind: name })}
                  onClick={() => edit({ links: draft.links.filter((item) => item.key !== link.key) })}
                />
              </div>
              {problem ? (
                <FieldNote id={`${id}-link-${link.key}`} tone="bad">
                  {problemText(problem, { max: LIMITS.link, kind: link.kind })}
                </FieldNote>
              ) : null}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
          <Button
            size="sm"
            wrap
            icon={<Plus size={14} />}
            disabled={draft.links.length >= LIMITS.links}
            onClick={() => edit({ links: [...draft.links, { key: rowKey(), kind: "other", url: "" }] })}
          >
            {t("manage.links.add")}
          </Button>
          <span className="text-body-sm text-fg-secondary">{t("manage.links.addHint")}</span>
        </div>
      </div>
    </Section>
  );
}

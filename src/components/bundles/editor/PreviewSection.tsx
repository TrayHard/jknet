import { Globe, MessageCircle, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  bundleLanguages,
  localizedBundleText,
  preferredBundleLanguage,
  useInterfaceLanguage,
} from "../../../lib/bundleText";
import type { Draft } from "../../../lib/ipc";
import { useAccountState, useEngines } from "../../../lib/queries";
import { Avatar, Badge } from "../../ui";
import { BundleCard } from "../BundleCard";
import { BundleManifestView } from "../BundleManifestView";
import { LanguageSwitch } from "../LanguageSwitch";
import { MarkdownView } from "../MarkdownView";
import { ExternalAnchor, Section, useBasedOnLine } from "../bundleFiles";
import { draftCard, draftManifest } from "./draftModel";

/**
 * --- slice: bundles ---
 *
 * **Preview**: the card and the record of the draft as the catalogue would
 * show them.
 *
 * The same two components the Bundles tab draws, fed the manifest the draft
 * would publish as: every badge, every source and every hash is the one a
 * player will read. The author is the signed-in account, or «You» while
 * signed out; the counters start at zero.
 */
export function PreviewSection({ draft }: { draft: Draft }) {
  const { t } = useTranslation("bundles");
  const account = useAccountState();
  const engines = useEngines();
  const basedOn = useBasedOnLine();
  const owner = account.data?.onlineSignedIn ? (account.data.onlineUser ?? null) : null;
  // The author of the card: the signed-in account, or «You» while signed
  // out, because the card of a draft has an author either way.
  const you = t("editor.preview.you");
  const card = useMemo(
    () =>
      draftCard(
        draft,
        owner
          ? { id: owner.id, displayName: owner.displayName, avatarUrl: owner.avatarUrl }
          : { id: "", displayName: you, avatarUrl: null },
      ),
    [draft, owner, you],
  );
  const manifest = useMemo(() => draftManifest(draft), [draft]);
  // The record opens in the language a player of this launcher would read
  // it in; the switch shows the author the other languages the way the
  // dialog of the catalogue will.
  const interfaceLanguage = useInterfaceLanguage();
  const [pickedLanguage, setPickedLanguage] = useState<string | null>(null);
  const languages = bundleLanguages(draft);
  const language =
    pickedLanguage !== null && languages.includes(pickedLanguage)
      ? pickedLanguage
      : preferredBundleLanguage(draft, interfaceLanguage);
  const text = localizedBundleText(draft, language);
  // The registry is the judge of what this build can install; the card of
  // the catalogue asks the core the same question.
  const engineKnown = useMemo(() => {
    const known: Record<string, boolean> = {};
    for (const component of draft.components) {
      known[component.id] = engines.data?.some((engine) => engine.id === component.engineId) !== false;
    }
    return known;
  }, [draft.components, engines.data]);

  return (
    <div className="flex flex-col gap-24">
      <Section heading={t("editor.preview.card")}>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(216px,100%),1fr))] gap-12 max-w-[720px]">
          <BundleCard card={card} installed={false} onOpen={() => undefined} />
        </ul>
      </Section>

      <Section heading={t("editor.preview.record")}>
        <div className="flex flex-col gap-16 rounded-lg border border-line bg-surface p-16">
          <div className="flex flex-col gap-8">
            <h3 className="text-display-md text-fg">{text.name}</h3>
            <div className="flex flex-wrap items-center gap-8 text-body-sm text-fg-muted">
              <Avatar name={owner?.displayName ?? null} src={owner?.avatarUrl} size="sm" />
              <span className="text-fg-secondary">{owner?.displayName ?? t("editor.preview.you")}</span>
              <span aria-hidden="true">·</span>
              <span>{t("details.version", { label: draft.versionLabel })}</span>
              <LanguageSwitch languages={languages} value={language} onChange={setPickedLanguage} className="ml-auto" />
            </div>
            {card.components.length > 0 ? (
              <p className="text-body-sm text-fg-secondary">
                {t("card.basedOn", { engines: basedOn(card.components) })}
              </p>
            ) : null}
            {card.hasExecutables ? (
              <div>
                <Badge tone="warm" icon={<ShieldAlert size={12} />}>
                  {t("card.executables")}
                </Badge>
              </div>
            ) : null}
            {draft.tags.length > 0 ? (
              <div className="flex flex-wrap gap-6">
                {draft.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
            {draft.website || draft.discord ? (
              <div className="flex flex-wrap items-center gap-16 text-body-sm">
                {draft.website ? (
                  <ExternalAnchor href={draft.website} className="text-fg-accent">
                    <Globe size={14} aria-hidden />
                    {t("details.website")}
                  </ExternalAnchor>
                ) : null}
                {draft.discord ? (
                  <ExternalAnchor href={draft.discord} className="text-fg-accent">
                    <MessageCircle size={14} aria-hidden />
                    {t("details.discord")}
                  </ExternalAnchor>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* The description as the catalogue will draw it, in the language picked; the pictures come from the folder of the draft. */}
          <MarkdownView
            key={language}
            markdown={text.description}
            images={{ kind: "draft", draftId: draft.id }}
            empty={
              text.summary.trim() !== "" ? (
                <p className="text-body-sm text-fg-secondary">{text.summary}</p>
              ) : (
                <p className="text-body-sm text-fg-muted">{t("details.noDescription")}</p>
              )
            }
          />

          {manifest.components.length === 0 ? (
            <p className="text-body-sm text-fg-muted">{t("editor.preview.noComponents")}</p>
          ) : (
            <BundleManifestView
              manifest={manifest}
              engineKnown={engineKnown}
              source={{ kind: "draft", draftId: draft.id }}
            />
          )}
        </div>
      </Section>
    </div>
  );
}

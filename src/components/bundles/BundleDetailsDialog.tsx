import { Check, Download, Globe, Heart, MessageCircle, Share2, ShieldAlert, Star } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { installJobKey, useBundleInstallJob } from "../../lib/bundleJobs";
import {
  bundleLanguages,
  localizedBundleText,
  preferredBundleLanguage,
  useInterfaceLanguage,
} from "../../lib/bundleText";
import { bundleCard } from "../../lib/chat/cardDrafts";
import { useOpenClientWindow } from "../../lib/clientWindow";
import { cn } from "../../lib/format";
import type { BundleVersion, BundleVersionSummary } from "../../lib/ipc";
import {
  useAccountState,
  useBundle,
  useBundleVersion,
  useClients,
  useInstallBundle,
  useLikeBundle,
} from "../../lib/queries";
import { useShareDialog } from "../chat/ShareToChatDialog";
import { Avatar, Badge, Button, Dialog } from "../ui";
import { BundleInstallForm, type InstallableComponent } from "./BundleInstallForm";
import { BundleManifestView } from "./BundleManifestView";
import { LanguageSwitch } from "./LanguageSwitch";
import { MarkdownView } from "./MarkdownView";
import { ExternalAnchor, Section, isExecutable, useBasedOnLine } from "./bundleFiles";

interface BundleDetailsDialogProps {
  bundleId: string;
  onClose: () => void;
}

/**
 * --- slice: bundles ---
 *
 * One bundle in full, and the way to install it.
 *
 * A wide dialog, as the JKHub record is: the record of a bundle is a list of
 * components, each a list of files with a badge each, and a third column
 * beside the grid would leave every column too narrow to read. The install
 * lives at the bottom of the body — a base name, a tick per component, a
 * word of trust when the bundle carries executables — and its bar and its
 * outcome are read out of `bundleJobs`, so closing the dialog and opening it
 * again shows the install where it got to.
 */
export function BundleDetailsDialog({ bundleId, onClose }: BundleDetailsDialogProps) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const basedOn = useBasedOnLine();

  const record = useBundle(bundleId);
  const clients = useClients();
  const account = useAccountState();
  const like = useLikeBundle();
  const install = useInstallBundle();
  const openClientWindow = useOpenClientWindow();
  // --- slice: chat cards --- **Share to chat**: the bundle as a card.
  const share = useShareDialog();
  const { t: tChat } = useTranslation("chat");

  // The version on screen. `null` is the latest one, which came with the
  // record; another one is fetched with its manifest when picked.
  const [pickedVersionId, setPickedVersionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const details = record.data;
  const latest = details?.latest ?? null;

  // The language of the name, the summary and the description: the one
  // pressed on the switch, else the language of the launcher when the
  // author translated into it, else the language of the bundle.
  const interfaceLanguage = useInterfaceLanguage();
  const [pickedLanguage, setPickedLanguage] = useState<string | null>(null);
  const languages = details ? bundleLanguages(details) : [];
  const language =
    pickedLanguage !== null && languages.includes(pickedLanguage)
      ? pickedLanguage
      : details
        ? preferredBundleLanguage(details, interfaceLanguage)
        : interfaceLanguage;
  const text = details ? localizedBundleText(details, language) : null;
  const picked = useBundleVersion(
    bundleId,
    pickedVersionId !== null && pickedVersionId !== latest?.id ? pickedVersionId : null,
  );
  const version: BundleVersion | null =
    pickedVersionId === null || pickedVersionId === latest?.id
      ? latest
      : (picked.data ?? null);
  const job = useBundleInstallJob(version ? installJobKey(bundleId, version.id) : null);

  const signedIn = account.data?.onlineSignedIn === true;
  const engineKnown = details?.local.engineKnown ?? {};
  // The clients made out of this bundle, finished ones only: a client whose
  // install stopped halfway is the card's business, with **Resume install**.
  const installedClients = (details?.local.installedClients ?? [])
    .filter((link) => !link.pending)
    .map((link) => clients.data?.find((client) => client.id === link.clientId)?.name ?? null)
    .filter((name): name is string => name !== null);

  const components: InstallableComponent[] = (version?.manifest.components ?? []).map(
    (component) => ({
      id: component.id,
      label: component.label,
      engineId: component.engine.engineId,
      releaseTag: component.engine.releaseTag,
      modes: component.modes,
      known: engineKnown[component.id] !== false,
    }),
  );
  const hasExecutables =
    version?.hasExecutables === true ||
    (version?.manifest.components ?? []).some(
      (component) =>
        component.overlay.files.some((file) => isExecutable(file.kind)) ||
        component.files.some((file) => isExecutable(file.kind)),
    ) ||
    (version?.manifest.shared.files ?? []).some((file) => isExecutable(file.kind));

  const title =
    text?.name ?? (record.isLoading ? t("details.loadingTitle") : t("details.fallbackTitle"));

  const runInstall = (
    baseName: string,
    componentIds: string[],
    existingClientIds: Record<string, string> | null,
  ) => {
    if (version === null) return;
    setFailure(null);
    // A refusal is the store's to show: the mutation writes every failure
    // there, and the notice under the form prints it with **Retry**. The
    // line above the body is for the like and for opening a client, which
    // the store knows nothing of; a second copy of the same refusal there
    // said nothing the notice did not.
    install.mutate({ bundleId, versionId: version.id, baseName, componentIds, existingClientIds });
  };

  const toggleLike = () => {
    if (!details) return;
    setFailure(null);
    like.mutate(
      { bundleId, liked: !details.likedByMe },
      { onError: (e) => setFailure(errorText(e)) },
    );
  };

  return (
    <>
      <Dialog
        title={title}
        wide
        onClose={onClose}
        actions={
          <>
            {share.available && details && text ? (
              <Button
                variant="ghost"
                icon={<Share2 size={16} />}
                onClick={() =>
                  share.open({
                    kind: "card",
                    card: bundleCard({ id: details.id, slug: details.slug, name: text.name, game: details.game }),
                  })
                }
              >
                {tChat("share.action")}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              {tCommon("actions.close")}
            </Button>
          </>
        }
      >
        {record.error ? (
          <p role="alert" className="text-body-sm text-fg-danger pt-12">
            {errorText(record.error)}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-body-sm text-fg-danger pt-12">
            {failure}
          </p>
        ) : null}

        {details && text ? (
          <div className="flex flex-col gap-16 pt-16 max-h-[60vh] overflow-y-auto pr-4">
            {/* Head: who, which version, when; the languages; the engines; the counters; the tags; the links. */}
            <div className="flex flex-col gap-8">
              <div className="flex flex-wrap items-center gap-8 text-body-sm text-fg-muted">
                <Avatar name={details.owner?.displayName ?? null} src={details.owner?.avatarUrl} size="sm" />
                <span className="text-fg-secondary">
                  {details.owner?.displayName ?? t("card.ownerUnknown")}
                </span>
                {version ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t("details.version", { label: version.label })}</span>
                  </>
                ) : null}
                {version?.publishedAt ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t("details.published", { date: format.date(version.publishedAt) })}</span>
                  </>
                ) : null}
                {/* The switch stands only on a bundle with a translation. */}
                <LanguageSwitch languages={languages} value={language} onChange={setPickedLanguage} className="ml-auto" />
              </div>
              {version && version.components.length > 0 ? (
                <p className="text-body-sm text-fg-secondary">
                  {t("card.basedOn", { engines: basedOn(version.components) })}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-8">
                <button
                  type="button"
                  onClick={toggleLike}
                  disabled={!signedIn || like.isPending}
                  aria-pressed={details.likedByMe}
                  aria-label={details.likedByMe ? t("details.unlike") : t("details.like")}
                  title={signedIn ? (details.likedByMe ? t("details.unlike") : t("details.like")) : t("details.likeSignIn")}
                  className={cn(
                    "inline-flex items-center gap-6 h-28 px-10 rounded-sm border select-none",
                    "text-body-sm-medium transition-colors duration-150",
                    "disabled:cursor-not-allowed disabled:text-fg-disabled",
                    details.likedByMe
                      ? "border-line-accent bg-accent-subtle text-fg-accent"
                      : "border-line text-fg-secondary hover:bg-surface-hover cursor-pointer",
                  )}
                >
                  <Heart size={14} fill={details.likedByMe ? "currentColor" : "none"} aria-hidden />
                  {t("details.likes", { count: details.likes })}
                </button>
                <span className="inline-flex items-center gap-4 text-body-sm text-fg-muted">
                  <Download size={14} aria-hidden />
                  {t("details.installs", { count: details.installs })}
                </span>
                {installedClients.length > 0 ? (
                  <Badge tone="success" icon={<Check size={12} />}>
                    {t("card.installed")}
                  </Badge>
                ) : null}
                {details.featured ? (
                  <Badge tone="accent" icon={<Star size={12} />}>
                    {t("card.featured")}
                  </Badge>
                ) : null}
                {hasExecutables ? (
                  <Badge tone="warm" icon={<ShieldAlert size={12} />}>
                    {t("card.executables")}
                  </Badge>
                ) : null}
              </div>

              {details.tags.length > 0 ? (
                <div className="flex flex-wrap gap-6">
                  {details.tags.map((tag) => (
                    <Badge key={tag} tone="neutral">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {details.website || details.discord ? (
                <div className="flex flex-wrap items-center gap-16 text-body-sm">
                  {details.website ? (
                    <ExternalAnchor href={details.website} className="text-fg-accent">
                      <Globe size={14} aria-hidden />
                      {t("details.website")}
                    </ExternalAnchor>
                  ) : null}
                  {details.discord ? (
                    <ExternalAnchor href={details.discord} className="text-fg-accent">
                      <MessageCircle size={14} aria-hidden />
                      {t("details.discord")}
                    </ExternalAnchor>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* The description in the language picked, as the author wrote it in
                Markdown; the summary stands in for an empty one. Keyed by the
                language so a switch draws the other text from the top. */}
            <MarkdownView
              key={language}
              markdown={text.description}
              empty={
                text.summary.trim() !== "" ? (
                  <p className="text-body-sm text-fg-secondary">{text.summary}</p>
                ) : (
                  <p className="text-body-sm text-fg-muted">{t("details.noDescription")}</p>
                )
              }
            />

            {/* Components, shared files, shared configs. */}
            {version === null ? (
              <p className="text-body-sm text-fg-muted">
                {picked.error ? errorText(picked.error) : tCommon("states.loading")}
              </p>
            ) : (
              <BundleManifestView
                manifest={version.manifest}
                engineKnown={engineKnown}
                source={{ kind: "bundle", bundleId, versionId: version.id }}
              />
            )}

            {/* Versions */}
            {details.versions.length > 0 ? (
              <Section heading={t("details.versions")}>
                <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
                  {details.versions.map((entry) => (
                    <VersionRow
                      key={entry.id}
                      version={entry}
                      selected={entry.id === (version?.id ?? latest?.id)}
                      onSelect={() => setPickedVersionId(entry.id)}
                    />
                  ))}
                </ul>
                {picked.error ? (
                  <p className="text-body-sm text-fg-danger">{errorText(picked.error)}</p>
                ) : null}
              </Section>
            ) : null}

            {/* Install */}
            <Section heading={t("details.install.heading")}>
              {version === null ? (
                <p className="text-body-sm text-fg-muted">{t("details.install.noVersion")}</p>
              ) : (
                <BundleInstallForm
                  key={version.id}
                  components={components}
                  defaultName={text.name}
                  hasExecutables={hasExecutables}
                  job={job}
                  installedClients={installedClients}
                  onInstall={runInstall}
                  onOpenClient={(clientId) => {
                    setFailure(null);
                    openClientWindow(clientId).catch((e: unknown) => setFailure(errorText(e)));
                  }}
                />
              )}
            </Section>
          </div>
        ) : record.isLoading ? (
          <p className="text-body-sm text-fg-muted pt-16">{tCommon("states.loading")}</p>
        ) : null}
      </Dialog>
      {share.dialog}
    </>
  );
}

/** One version of the list: label, status, date, size, changelog. */
function VersionRow({
  version,
  selected,
  onSelect,
}: {
  version: BundleVersionSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const basedOn = useBasedOnLine();
  return (
    <li className={cn("flex flex-col gap-4 px-12 py-8", selected && "bg-selected-overlay")}>
      <div className="flex items-center gap-8 min-w-0">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          title={t("details.showVersion", { label: version.label })}
          className={cn(
            "text-body-sm-medium truncate cursor-pointer hover:text-fg-accent hover:underline",
            selected ? "text-fg-accent" : "text-fg",
          )}
        >
          {version.label}
        </button>
        {version.status !== "published" ? (
          <Badge tone={version.status === "rejected" ? "danger" : version.status === "pending" ? "warm" : "neutral"}>
            {t(`details.status.${version.status}`)}
          </Badge>
        ) : null}
        <span className="text-mono-xs text-fg-muted shrink-0 ml-auto">
          {format.date(version.publishedAt ?? version.createdAt)}
        </span>
        <span className="text-mono-xs text-fg-muted shrink-0">
          {t("details.versionSize", { size: format.bytes(version.blobBytes), count: version.fileCount })}
        </span>
      </div>
      {version.components.length > 0 ? (
        <span className="text-body-sm text-fg-muted truncate">
          {t("card.basedOn", { engines: basedOn(version.components) })}
        </span>
      ) : null}
      {version.changelog.trim() !== "" ? (
        <p className="text-body-sm text-fg-secondary whitespace-pre-line">{version.changelog}</p>
      ) : null}
      {version.reviewNote ? (
        <p className="text-body-sm text-fg-warm">{t("details.reviewNote", { note: version.reviewNote })}</p>
      ) : null}
    </li>
  );
}

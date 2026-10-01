import { ImagePlus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../lib/format";
import { Button } from "../../ui";
import { blobUrl } from "../api";
import { hueStyle } from "../bits";
import { useFailureText } from "../errors";
import { monogram } from "../format";
import { useCommunityPlatform, type CommunityImageKind, type ImageRefusal, type UploadedImage } from "../platform";
import type { Community } from "../types";
import { useAction } from "../useRemote";
import type { ManageDraft } from "./model";
import { FieldNote, Section, useSizeText } from "./parts";
import { IMAGE_ACCEPT, uploadImageFile } from "./upload";

/** What the screen knows of a picture it uploaded in this visit. */
type Picked = Record<CommunityImageKind, UploadedImage | null>;

/**
 * **Logo and cover**: each picture with its preview, its limits and
 * **Replace** and **Remove**, or the empty box with **Choose file**.
 *
 * Choosing a file uploads it to the store of the service at once — the
 * launcher's core behind its own dialog, the website through a file input —
 * and the form holds its hash. The page shows it after **Save changes**,
 * which binds the hash to the community.
 */
export function ImagesSection({
  community,
  base,
  draft,
  edit,
}: {
  community: Community;
  base: ManageDraft;
  draft: ManageDraft;
  edit: (patch: Partial<ManageDraft>) => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const [picked, setPicked] = useState<Picked>({ logo: null, banner: null });
  const canUpload = platform.pickImage !== undefined || platform.putBlob !== undefined;

  return (
    <Section section="images" title={t("manage.sections.images")}>
      <div className="grid grid-cols-2 gap-16 @max-[880px]/community:grid-cols-1">
        <ImageBox
          kind="logo"
          community={community}
          sha256={draft.logo}
          saved={base.logo}
          picked={picked.logo}
          canUpload={canUpload}
          onUploaded={(image) => {
            setPicked((current) => ({ ...current, logo: image }));
            edit({ logo: image.sha256 });
          }}
          onRemove={() => edit({ logo: null })}
        />
        <ImageBox
          kind="banner"
          community={community}
          sha256={draft.banner}
          saved={base.banner}
          picked={picked.banner}
          canUpload={canUpload}
          onUploaded={(image) => {
            setPicked((current) => ({ ...current, banner: image }));
            edit({ banner: image.sha256 });
          }}
          onRemove={() => edit({ banner: null })}
        />
      </div>
    </Section>
  );
}

function ImageBox({
  kind,
  community,
  sha256,
  saved,
  picked,
  canUpload,
  onUploaded,
  onRemove,
}: {
  kind: CommunityImageKind;
  community: Community;
  sha256: string | null;
  saved: string | null;
  picked: UploadedImage | null;
  canUpload: boolean;
  onUploaded: (image: UploadedImage) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const failure = useFailureText();
  const sizeText = useSizeText();
  const action = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const logo = kind === "logo";
  const label = logo ? t("manage.images.logo") : t("manage.images.cover");
  const url = blobUrl(platform.apiBase, sha256);
  const shown = url !== null && broken !== sha256;

  const refusal = (refused: ImageRefusal) =>
    refused.reason === "tooBig"
      ? t("manage.images.tooBig", { name: refused.fileName, max: sizeText(refused.maxBytes) })
      : t("manage.images.notPicture", { name: refused.fileName });

  const choose = () => {
    setProblem(null);
    if (platform.pickImage) {
      void action.run(
        async () => {
          const result = await platform.pickImage!(kind);
          if (result.outcome === "refused") setProblem(refusal(result));
          if (result.outcome === "uploaded") onUploaded(result);
        },
        (reason) => setProblem(t("manage.images.failed", { reason: failure(reason) })),
      );
      return;
    }
    input.current?.click();
  };

  const fromInput = (file: File | undefined) => {
    if (!file || !platform.putBlob) return;
    const put = platform.putBlob;
    void action.run(
      async () => {
        const result = await uploadImageFile(file, kind, put);
        if ("refused" in result) setProblem(refusal(result.refused));
        else onUploaded(result.uploaded);
      },
      (reason) => setProblem(t("manage.images.failed", { reason: failure(reason) })),
    );
  };

  const meta =
    picked !== null && picked.sha256 === sha256
      ? picked.width !== null && picked.height !== null
        ? t("manage.images.metaSized", { name: picked.fileName, width: picked.width, height: picked.height, size: sizeText(picked.size) })
        : t("manage.images.meta", { name: picked.fileName, size: sizeText(picked.size) })
      : null;
  const status = action.busy
    ? t("manage.images.uploading")
    : sha256 !== saved
      ? sha256 === null
        ? t("manage.images.removedUnsaved")
        : t("manage.images.unsaved")
      : sha256 !== null
        ? t("manage.images.current")
        : null;
  const limits = logo ? t("manage.images.logoLimits") : t("manage.images.coverLimits");
  const empty = logo ? t("manage.images.noLogo") : t("manage.images.noCover");
  // A cover is three times as wide as it is tall: it takes the width of the
  // box, with what it says under it, rather than squeezing the text beside.
  const wide = !logo && sha256 !== null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <span className="text-body-sm-medium text-fg-secondary">{label}</span>
      <div
        className={cn(
          "flex min-h-80 min-w-0 rounded-md border border-line bg-input p-8",
          wide ? "flex-col gap-12" : "items-center gap-16 pr-12 @max-[420px]/community:flex-col @max-[420px]/community:items-start",
        )}
      >
        {sha256 !== null ? (
          <span
            role="img"
            aria-label={logo ? t("manage.images.logoAlt", { name: community.name }) : t("manage.images.coverAlt", { name: community.name })}
            className={cn(
              "relative flex shrink-0 items-center justify-center overflow-hidden",
              logo ? "size-64 rounded-[14px] border-2" : "aspect-[3/1] w-full rounded-md border",
              shown ? "border-line bg-elevated" : logo ? "jkc-logo" : "jkc-cover",
            )}
            style={hueStyle(community.id)}
          >
            {shown ? (
              <img src={url} alt="" className="absolute inset-0 size-full object-cover" onError={() => setBroken(sha256)} />
            ) : logo ? (
              <span className="font-display text-[22px] font-semibold leading-none" aria-hidden="true">
                {monogram(community.name)}
              </span>
            ) : null}
          </span>
        ) : (
          <span
            className="flex size-64 shrink-0 items-center justify-center rounded-lg border border-dashed border-line-strong text-fg-secondary"
            aria-hidden="true"
          >
            <ImagePlus size={20} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {meta ? <span className="text-mono-xs text-fg [overflow-wrap:anywhere]">{meta}</span> : null}
          {status ? (
            <span role="status" className={cn("text-body-sm", sha256 !== saved && !action.busy ? "text-fg-warm" : "text-fg-secondary")}>
              {status}
            </span>
          ) : null}
          <span className="text-body-sm text-fg-secondary">{sha256 === null ? `${limits} ${empty}` : limits}</span>
          {canUpload ? (
            <div className="flex flex-wrap gap-6">
              <Button size="sm" wrap icon={<Upload size={14} />} disabled={action.busy} onClick={choose}>
                {sha256 === null ? t("manage.images.pick") : t("manage.images.replace")}
              </Button>
              {sha256 !== null ? (
                <Button size="sm" variant="ghost" wrap disabled={action.busy} onClick={onRemove}>
                  {t("manage.images.remove")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {problem ? <FieldNote tone="bad">{problem}</FieldNote> : null}
      {platform.pickImage === undefined && platform.putBlob ? (
        <input
          ref={input}
          type="file"
          accept={IMAGE_ACCEPT}
          hidden
          aria-label={label}
          onChange={(event) => {
            fromInput(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      ) : null}
    </div>
  );
}

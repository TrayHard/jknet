/**
 * Choosing a picture and putting it in the store of JKNet Online, the way the
 * host can: the launcher's core behind its own dialog (`pickImage`, the
 * command `community_pick_image`), or a file input whose file is checked and
 * hashed here and handed to the host's `putBlob` (the website). The logo and
 * the cover of the management screen and the cover of an event in its editor
 * go through this one hook; the web app gives neither and uploads nothing.
 *
 * A refusal — too big, not a PNG, JPEG or WebP — is an answer, not an error:
 * the screen says it with {@link usePictureRefusalText}. A failed upload is
 * the error the host threw, for the screen to put in its own sentence.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useSizeText } from "./manage/parts";
import { IMAGE_ACCEPT, uploadImageFile } from "./manage/upload";
import { useCommunityPlatform, type ImageRefusal, type PictureKind, type UploadedImage } from "./platform";
import { useAction } from "./useRemote";

/** Why the last choice did not give a picture: the checks refused the file, or the upload failed. */
export type PictureProblem = { refused: ImageRefusal } | { failed: unknown };

export interface PictureUpload {
  /** The host can upload: the launcher's dialog or the website's file input. */
  canUpload: boolean;
  busy: boolean;
  problem: PictureProblem | null;
  /** Opens the dialog or the file input. */
  choose: () => void;
  /** The hidden file input of a host without the dialog; render it anywhere in the screen. */
  fileInput: ReactNode;
}

/**
 * One picture of a screen. `label` names the hidden file input for screen
 * readers; `onUploaded` gets the picture once it is in the store.
 */
export function usePictureUpload(kind: PictureKind, label: string, onUploaded: (image: UploadedImage) => void): PictureUpload {
  const platform = useCommunityPlatform();
  const action = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<PictureProblem | null>(null);
  const { pickImage, putBlob } = platform;

  const choose = () => {
    setProblem(null);
    if (pickImage) {
      void action.run(
        async () => {
          const result = await pickImage(kind);
          if (result.outcome === "refused") setProblem({ refused: result });
          if (result.outcome === "uploaded") onUploaded(result);
        },
        (reason) => setProblem({ failed: reason }),
      );
      return;
    }
    input.current?.click();
  };

  const fromInput = (file: File | undefined) => {
    if (!file || !putBlob) return;
    void action.run(
      async () => {
        const result = await uploadImageFile(file, kind, putBlob);
        if ("refused" in result) setProblem({ refused: result.refused });
        else onUploaded(result.uploaded);
      },
      (reason) => setProblem({ failed: reason }),
    );
  };

  const fileInput =
    pickImage === undefined && putBlob ? (
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
    ) : null;

  return { canUpload: pickImage !== undefined || putBlob !== undefined, busy: action.busy, problem, choose, fileInput };
}

/** The sentence of a refused file: the size it may take, or the types the service takes. */
export function usePictureRefusalText(): (refused: ImageRefusal) => string {
  const { t } = useTranslation("community");
  const sizeText = useSizeText();
  return useCallback(
    (refused: ImageRefusal) =>
      refused.reason === "tooBig"
        ? t("manage.images.tooBig", { name: refused.fileName, max: sizeText(refused.maxBytes) })
        : t("manage.images.notPicture", { name: refused.fileName }),
    [t, sizeText],
  );
}

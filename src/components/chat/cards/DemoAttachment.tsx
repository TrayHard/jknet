import { FolderInput } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { demoGame } from "../../../lib/chat/cardDrafts";
import { useActiveGame, useDefaultClient, useGameNames } from "../../../lib/game";
import { useImportChatFile } from "../../../lib/queries";
import { Button } from "../../ui";
import type { AttachmentProps } from "./index";
import { CardStatus } from "./CardShell";
import { FileFrame } from "./FileCard";
import { useChatFile } from "./useChatFile";

/**
 * --- slice: chat cards ---
 *
 * A demo of a message.
 *
 * The game is read off the extension — `dm_26` is Jedi Academy, `dm_15` Jedi
 * Outcast — and **Add to Media** puts the demo into the demo folder of the
 * default client of that game, where the Media screen lists it, plays it and
 * renders a video out of it. **Save** puts it anywhere else.
 */
export function DemoAttachment({ file, message }: AttachmentProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const format = useFormat();
  const games = useGameNames();
  const active = useActiveGame();
  const game = demoGame(file.name) ?? active;
  const client = useDefaultClient(game);
  const state = useChatFile(file, message);
  const importFile = useImportChatFile();

  const addButton = (
    <Button
      size="sm"
      variant="primary"
      icon={<FolderInput size={14} />}
      disabled={client === undefined || importFile.isPending || importFile.isSuccess}
      title={client === undefined ? t("cards.noClient", { game: games.label(game) }) : t("files.demo.addHint", { client: client.name })}
      onClick={() => {
        if (client !== undefined) importFile.mutate({ fileId: file.id, target: { kind: "demo", clientId: client.id } });
      }}
    >
      {importFile.isPending ? t("files.adding") : importFile.isSuccess ? t("files.addedToMedia") : t("files.addToMedia")}
    </Button>
  );

  return (
    <>
      <FileFrame
        file={file}
        state={state}
        subtitle={`${t("files.class.demo")} · ${games.short(game)} · ${format.bytes(file.size)}`}
        actions={addButton}
        extra={
          importFile.error ? (
            <CardStatus tone="danger">{errorText(importFile.error)}</CardStatus>
          ) : importFile.isSuccess && client !== undefined ? (
            <CardStatus tone="success">{t("files.demo.added", { client: client.name })}</CardStatus>
          ) : client === undefined ? (
            <CardStatus>{t("cards.noClient", { game: games.label(game) })}</CardStatus>
          ) : null
        }
      />
      {state.dialog}
    </>
  );
}

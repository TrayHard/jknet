import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { GROUP_MAX_MEMBERS, GROUP_TITLE_MAX, addOutcome, groupRoom } from "../../lib/chat/groups";
import { useChatMeId, useCreateChatGroup, useFriendsState } from "../../lib/queries";
import { Button, Dialog, Input } from "../ui";
import { FriendPicker } from "./FriendPicker";
import { useGroupReport } from "./GroupReport";
import { Layer } from "./Layer";
import { useChatNames } from "./useChatText";

interface GroupDialogProps {
  onClose: () => void;
  /** The group exists: show it. */
  onCreated: (conversationId: string) => void;
}

/**
 * --- slice: chat groups ---
 *
 * **New group**: a name, which may stay empty — the group then shows the
 * names of its members — and the friends to start it with, up to 19 besides
 * me. Friends who ask before being added get an invitation instead; the
 * service says so in its answer, and the toast after it tells the player.
 * Everybody picked here sees the whole history from the first message on.
 */
export function GroupDialog({ onClose, onCreated }: GroupDialogProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const friends = useFriendsState().data?.friends ?? [];
  const meId = useChatMeId();
  const names = useChatNames();
  const create = useCreateChatGroup();
  const report = useGroupReport();
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const exclude = useMemo(() => new Set(meId === null ? [] : [meId]), [meId]);
  const room = groupRoom(null);

  const submit = () => {
    if (picked.length === 0 || create.isPending) return;
    create.mutate(
      { title: title.trim(), memberIds: picked },
      {
        onSuccess: (result) => {
          onCreated(result.conversation.id);
          report.toast(addOutcome(result), names.title(result.conversation), result.conversation.id);
          onClose();
        },
      },
    );
  };

  return (
    <Layer>
      <Dialog
        title={t("group.new")}
        body={t("group.newBody", { max: GROUP_MAX_MEMBERS })}
        onClose={onClose}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              {tCommon("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={picked.length === 0 || create.isPending}
              title={picked.length === 0 ? t("group.pickHint") : undefined}
              onClick={submit}
            >
              {create.isPending ? t("group.creating") : t("group.create")}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-16 pt-16"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-6">
            <span className="text-label-xs text-fg-muted">{t("group.name")}</span>
            <Input
              autoFocus
              value={title}
              maxLength={GROUP_TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("group.namePlaceholder")}
              disabled={create.isPending}
            />
          </label>
          <FriendPicker
            friends={friends}
            exclude={exclude}
            picked={picked}
            onChange={setPicked}
            room={room}
            countText={t("group.count", { used: 1 + picked.length, max: GROUP_MAX_MEMBERS })}
            noneLeftText={t("group.noFriends")}
            disabled={create.isPending}
          />
          <p className="text-body-sm text-fg-muted">{t("group.asksNote")}</p>
          {create.error ? (
            <p role="alert" className="text-body-sm text-fg-danger">
              {errorText(create.error)}
            </p>
          ) : null}
        </form>
      </Dialog>
    </Layer>
  );
}

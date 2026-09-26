import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { GROUP_MAX_MEMBERS, addOutcome, addedAnybody, groupRoom, type AddOutcome } from "../../lib/chat/groups";
import type { Conversation } from "../../lib/ipc";
import { useAddChatMembers, useFriendsState } from "../../lib/queries";
import { Button, Dialog } from "../ui";
import { FriendPicker } from "./FriendPicker";
import { useGroupReport } from "./GroupReport";
import { Layer } from "./Layer";
import { useChatNames } from "./useChatText";

interface AddMembersDialogProps {
  conversation: Conversation;
  onClose: () => void;
}

/**
 * --- slice: chat groups ---
 *
 * **Add friends** of a group: any member adds their own friends while the
 * group has room. A friend who asks before being added gets an invitation
 * and joins once they accept it; whether they see the history before their
 * join depends on the group's setting at that moment (D1).
 *
 * An answer that added or invited somebody closes the dialog, the rest of
 * it in a toast. An answer that added nobody stays, with the reasons under
 * the list.
 */
export function AddMembersDialog({ conversation, onClose }: AddMembersDialogProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const friends = useFriendsState().data?.friends ?? [];
  const names = useChatNames();
  const add = useAddChatMembers();
  const report = useGroupReport();
  const [picked, setPicked] = useState<string[]>([]);
  const [refused, setRefused] = useState<AddOutcome | null>(null);
  const exclude = useMemo(
    () => new Set(conversation.members.map((member) => member.user.id)),
    [conversation.members],
  );
  const room = groupRoom(conversation);
  const title = names.title(conversation);

  const submit = () => {
    if (picked.length === 0 || add.isPending) return;
    setRefused(null);
    add.mutate(
      { conversationId: conversation.id, userIds: picked },
      {
        onSuccess: (result) => {
          const outcome = addOutcome(result);
          if (!addedAnybody(outcome)) {
            setRefused(outcome);
            setPicked([]);
            return;
          }
          report.toast(outcome, title, conversation.id);
          onClose();
        },
      },
    );
  };

  const reasons = refused === null ? [] : report.lines(refused, false);

  return (
    <Layer>
      <Dialog
        title={t("group.addTitle", { title })}
        body={t("group.addBody")}
        onClose={onClose}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              {tCommon("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={picked.length === 0 || add.isPending}
              title={picked.length === 0 ? t("group.pickHint") : undefined}
              onClick={submit}
            >
              {add.isPending ? t("group.adding") : t("group.add", { count: Math.max(1, picked.length) })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-12 pt-16">
          {room === 0 ? (
            <p className="text-body-sm text-fg-warm">{t("group.full", { max: GROUP_MAX_MEMBERS })}</p>
          ) : (
            <FriendPicker
              friends={friends}
              exclude={exclude}
              picked={picked}
              onChange={setPicked}
              room={room}
              countText={t("group.count", { used: conversation.members.length + picked.length, max: GROUP_MAX_MEMBERS })}
              noneLeftText={friends.length === 0 ? t("group.noFriends") : t("group.allIn")}
              disabled={add.isPending}
            />
          )}
          {reasons.length > 0 ? (
            <div role="alert" className="flex flex-col gap-2 rounded-md bg-warm-subtle px-10 py-8 text-body-sm text-fg-warm">
              {reasons.map((line) => (
                <p key={line} className="[unicode-bidi:isolate]">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
          {add.error ? (
            <p role="alert" className="text-body-sm text-fg-danger">
              {errorText(add.error)}
            </p>
          ) : null}
        </div>
      </Dialog>
    </Layer>
  );
}

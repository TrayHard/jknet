import { Crown, LogOut, MessageCircle, Pencil, UserMinus, UserPlus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import {
  GROUP_MAX_MEMBERS,
  GROUP_TITLE_MAX,
  canAddMembers,
  canChangeHistory,
  canRemoveMember,
  canRename,
  leaveOutcome,
  orderMembers,
  ownerIdOf,
  ownsConversation,
} from "../../lib/chat/groups";
import { cn } from "../../lib/format";
import type { ChatMember, ChatNotifyLevel, Conversation } from "../../lib/ipc";
import {
  useFriendPresence,
  useLeaveChat,
  useRemoveChatMember,
  useRenameChatGroup,
  useSetChatNotify,
  useSetHistoryForNewMembers,
} from "../../lib/queries";
import { useStatusLine } from "../friends/useStatusLine";
import { Avatar, Button, Dialog, Input, Menu, Toggle, type MenuItem } from "../ui";
import { AddMembersDialog } from "./AddMembersDialog";
import { ConversationAvatar } from "./ConversationAvatar";
import { Layer } from "./Layer";
import { useMessageFriend } from "./useOpenChat";
import { useChatNames } from "./useChatText";

interface GroupInfoPanelProps {
  /** A group or a server chat. */
  conversation: Conversation;
  /** Back to the messages. */
  onClose: () => void;
  /** I left, or ended the chat: the layout goes back to the list. */
  onLeft: () => void;
  /** Opens with the name in an editable field: **Rename group** of the header. */
  renaming?: boolean;
  /** Opens **Add friends** at once: the item of the header's menu. */
  adding?: boolean;
  dense?: boolean;
}

const LEVELS: ChatNotifyLevel[] = ["all", "mentions", "mute"];

/**
 * --- slice: chat groups ---
 *
 * The info of a group or of a server chat, in place of the messages.
 *
 * A group: its name — which only the owner renames (D5) — the members with a
 * crown on the owner, **Add friends** for any member while there is room,
 * **Remove from group** for the owner, the switch «New members see history»
 * — the owner's; the others see it off-limits with who can change it (D1) —
 * the notification level, and **Leave group**, which says beforehand what
 * leaving does: the owner hands the group to the member who joined earliest
 * (D4), the last member deletes it.
 *
 * A server chat: the host and the guests, the host removes a guest, the
 * history switch read-only — the host changes it on the Play with friends
 * screen — and **Leave chat** for a guest (D9), **End chat** for the host.
 */
export function GroupInfoPanel({
  conversation,
  onClose,
  onLeft,
  renaming: startRenaming = false,
  adding: startAdding = false,
  dense = false,
}: GroupInfoPanelProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const names = useChatNames();
  const meId = names.meId;
  const server = conversation.kind === "server";
  const owner = ownsConversation(conversation, meId);
  const ownerId = ownerIdOf(conversation);
  const title = names.title(conversation);

  const rename = useRenameChatGroup();
  const history = useSetHistoryForNewMembers();
  const notify = useSetChatNotify();
  const leave = useLeaveChat();
  const remove = useRemoveChatMember();

  const [draft, setDraft] = useState<string | null>(startRenaming && canRename(conversation, meId) ? (conversation.title ?? "") : null);
  const [addOpen, setAddOpen] = useState(startAdding && canAddMembers(conversation));
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [removing, setRemoving] = useState<ChatMember | null>(null);

  const ownerName = ownerId === null ? null : ownerId === meId ? null : names.personName(ownerId);
  const subtitle = server
    ? owner
      ? t("info.serverByYou")
      : t("info.serverBy", { name: ownerName ?? t("people.former") })
    : ownerId === null
      ? t("info.group")
      : owner
        ? t("info.groupByYou")
        : t("info.groupBy", { name: ownerName ?? t("people.former") });

  const saveName = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next === (conversation.title ?? "").trim()) {
      setDraft(null);
      return;
    }
    rename.mutate({ conversationId: conversation.id, title: next }, { onSuccess: () => setDraft(null) });
  };

  const outcome = leaveOutcome(conversation, meId);
  const leaveText =
    outcome.kind === "delete"
      ? t("info.leaveDelete", { title })
      : outcome.kind === "handover"
        ? t("info.leaveHandover", { title, name: outcome.next.displayName })
        : outcome.kind === "end"
          ? t("info.leaveEndText")
          : server
            ? t("info.leaveServerText")
            : t("info.leaveText", { title });
  const leaveLabel = outcome.kind === "end" ? t("info.endChat") : server ? t("info.leaveServer") : t("info.leave");

  const members = orderMembers(conversation);
  const historyEditable = canChangeHistory(conversation, meId);
  const historyNote = server
    ? owner
      ? t("info.historyHostHere")
      : t("info.historyHostOnly")
    : historyEditable
      ? t("info.historyHint")
      : t("info.historyOwnerOnly", { name: ownerName ?? t("people.former") });

  return (
    <section
      aria-label={server ? t("info.titleServer") : t("info.title")}
      className="flex h-full min-h-0 flex-col"
    >
      <div className={cn("flex shrink-0 items-center gap-8 border-b border-line-subtle", dense ? "h-36 px-8" : "h-40 px-12")}>
        <h3 className="min-w-0 flex-1 truncate text-heading-sm text-fg">
          {server ? t("info.titleServer") : t("info.title")}
        </h3>
        <button
          type="button"
          aria-label={t("info.close")}
          title={t("info.close")}
          onClick={onClose}
          className="flex size-28 shrink-0 items-center justify-center rounded-sm text-fg-secondary cursor-pointer select-none hover:bg-hover-overlay hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Who: the picture, the name, who made it. */}
        <div className={cn("flex items-center gap-12 border-b border-line-subtle", dense ? "p-8" : "px-16 py-12")}>
          <ConversationAvatar conversation={conversation} meId={meId} size="md" />
          {draft === null ? (
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body-md-medium text-fg [unicode-bidi:isolate]">{title}</span>
              <span className="truncate text-body-sm text-fg-muted">{subtitle}</span>
            </div>
          ) : (
            <form
              className="flex min-w-0 flex-1 flex-col gap-6"
              onSubmit={(event) => {
                event.preventDefault();
                saveName();
              }}
            >
              <Input
                autoFocus
                value={draft}
                maxLength={GROUP_TITLE_MAX}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    // The field answers Escape itself: the drawer stays open.
                    event.preventDefault();
                    event.stopPropagation();
                    setDraft(null);
                  }
                }}
                aria-label={t("info.renameLabel")}
                placeholder={t("info.renamePlaceholder")}
                className="h-32"
                disabled={rename.isPending}
              />
              <span className="flex items-center gap-6">
                <Button size="sm" variant="primary" type="submit" disabled={rename.isPending}>
                  {tCommon("actions.save")}
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(null)}>
                  {tCommon("actions.cancel")}
                </Button>
              </span>
            </form>
          )}
          {draft === null && canRename(conversation, meId) ? (
            <button
              type="button"
              aria-label={t("info.rename")}
              title={t("info.rename")}
              onClick={() => setDraft(conversation.title ?? "")}
              className="flex size-28 shrink-0 items-center justify-center rounded-sm text-fg-secondary cursor-pointer select-none hover:bg-hover-overlay hover:text-fg"
            >
              <Pencil size={14} />
            </button>
          ) : null}
        </div>
        {rename.error ? (
          <p role="alert" className="px-16 pt-8 text-body-sm text-fg-danger">
            {errorText(rename.error)}
          </p>
        ) : null}

        {/* The members, the owner first. */}
        <InfoSection
          title={
            server
              ? t("info.membersServer", { used: conversation.members.length })
              : t("info.members", { used: conversation.members.length, max: GROUP_MAX_MEMBERS })
          }
          action={
            conversation.kind === "group" ? (
              <Button
                size="sm"
                icon={<UserPlus size={14} />}
                disabled={!canAddMembers(conversation) || !conversation.canSend}
                title={canAddMembers(conversation) ? undefined : t("group.full", { max: GROUP_MAX_MEMBERS })}
                onClick={() => setAddOpen(true)}
              >
                {t("info.add")}
              </Button>
            ) : null
          }
          dense={dense}
        >
          <ul className="flex flex-col gap-2">
            {members.map((member) => (
              <MemberRow
                key={member.user.id}
                conversation={conversation}
                member={member}
                me={member.user.id === meId}
                isOwner={member.user.id === ownerId}
                canRemove={canRemoveMember(conversation, meId, member.user.id)}
                onRemove={() => setRemoving(member)}
              />
            ))}
          </ul>
          <p className="px-4 pt-6 text-body-sm text-fg-muted">
            {server
              ? t("info.ruleServer")
              : owner
                ? t("info.ruleOwner")
                : t("info.ruleMember", { name: ownerName ?? t("people.former") })}
          </p>
          {remove.error ? (
            <p role="alert" className="px-4 pt-6 text-body-sm text-fg-danger">
              {errorText(remove.error)}
            </p>
          ) : null}
        </InfoSection>

        {/* History for later members (D1). */}
        <InfoSection title={t("info.history")} dense={dense}>
          <div className="flex items-center gap-12 px-4">
            <span className="min-w-0 flex-1 text-body-md text-fg">{t("info.historySwitch")}</span>
            <Toggle
              checked={conversation.historyForNewMembers}
              disabled={!historyEditable || history.isPending}
              label={t("info.historySwitch")}
              onChange={(on) => history.mutate({ conversationId: conversation.id, on })}
            />
          </div>
          <p className="px-4 pt-6 text-body-sm text-fg-muted">
            {conversation.historyForNewMembers ? t("info.historyOn") : t("info.historyOff")} {historyNote}
          </p>
          {history.error ? (
            <p role="alert" className="px-4 pt-6 text-body-sm text-fg-danger">
              {errorText(history.error)}
            </p>
          ) : null}
        </InfoSection>

        {/* Notifications of this chat. */}
        <InfoSection title={t("info.notifications")} dense={dense}>
          <div role="radiogroup" aria-label={t("notify.menu")} className="flex flex-col gap-2">
            {LEVELS.map((level) => {
              const on = conversation.notify === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={notify.isPending}
                  onClick={() => notify.mutate({ conversationId: conversation.id, notify: level })}
                  className="flex w-full items-start gap-10 rounded-md px-6 py-6 text-left cursor-pointer select-none hover:bg-hover-overlay disabled:cursor-wait"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-2 flex size-16 shrink-0 items-center justify-center rounded-full border",
                      on ? "border-line-accent" : "border-line-strong",
                    )}
                  >
                    {on ? <span className="size-8 rounded-full bg-accent" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body-md text-fg">{t(`notify.${level}`)}</span>
                    <span className="text-body-sm text-fg-muted">{t(`notify.${level}Hint`)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {notify.error ? (
            <p role="alert" className="px-4 pt-6 text-body-sm text-fg-danger">
              {errorText(notify.error)}
            </p>
          ) : null}
        </InfoSection>

        {/* Leaving, with what it does said first. */}
        <div className={cn("flex flex-col gap-8", dense ? "p-8" : "px-16 py-12")}>
          {confirmLeave ? (
            <div className="flex flex-col gap-8 rounded-md border border-line-danger bg-danger-subtle p-10">
              <p className="text-body-sm text-fg [unicode-bidi:isolate]">{leaveText}</p>
              <span className="flex items-center gap-6">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={leave.isPending}
                  onClick={() => leave.mutate(conversation.id, { onSuccess: onLeft })}
                >
                  {outcome.kind === "end" ? t("info.endChat") : t("info.confirmLeave")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmLeave(false)}>
                  {tCommon("actions.cancel")}
                </Button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmLeave(true)}
              className="flex h-28 items-center gap-6 self-start rounded-sm px-12 text-body-sm-medium text-fg-danger cursor-pointer select-none transition-colors duration-150 hover:bg-danger-subtle"
            >
              <LogOut size={14} />
              {leaveLabel}
            </button>
          )}
          {leave.error ? (
            <p role="alert" className="text-body-sm text-fg-danger">
              {errorText(leave.error)}
            </p>
          ) : null}
        </div>
      </div>

      {addOpen ? <AddMembersDialog conversation={conversation} onClose={() => setAddOpen(false)} /> : null}
      {removing !== null ? (
        <Layer>
          <Dialog
            variant="danger"
            title={t("info.removeTitle", { name: removing.user.displayName, title })}
            body={
              server
                ? t("info.removeServerBody", { name: removing.user.displayName })
                : t("info.removeBody", { name: removing.user.displayName })
            }
            onClose={() => setRemoving(null)}
            actions={
              <>
                <Button variant="ghost" onClick={() => setRemoving(null)}>
                  {tCommon("actions.cancel")}
                </Button>
                <Button
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(
                      { conversationId: conversation.id, userId: removing.user.id },
                      { onSettled: () => setRemoving(null) },
                    )
                  }
                >
                  {tCommon("actions.remove")}
                </Button>
              </>
            }
          />
        </Layer>
      ) : null}
    </section>
  );
}

function InfoSection({
  title,
  action,
  dense,
  children,
}: {
  title: string;
  action?: ReactNode;
  dense: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-8 border-b border-line-subtle", dense ? "p-8" : "px-12 py-12")}>
      <div className="flex min-h-28 items-center gap-8 px-4">
        <h4 className="min-w-0 flex-1 truncate text-label-xs text-fg-muted">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

interface MemberRowProps {
  conversation: Conversation;
  member: ChatMember;
  me: boolean;
  isOwner: boolean;
  canRemove: boolean;
  onRemove: () => void;
}

/**
 * One member: the face with the presence dot of a friend, the name, a crown
 * for the owner, and what the player can do about them — write to a friend,
 * remove them when the player owns the chat.
 */
function MemberRow({ conversation, member, me, isOwner, canRemove, onRemove }: MemberRowProps) {
  const { t } = useTranslation("chat");
  const statusLine = useStatusLine();
  const presence = useFriendPresence(me ? null : member.user.id);
  const message = useMessageFriend();
  const server = conversation.kind === "server";
  const name = member.user.displayName;

  const items: MenuItem[] = [];
  if (presence !== undefined) {
    items.push({ id: "message", label: t("info.message"), icon: <MessageCircle size={14} /> });
  }
  if (canRemove) {
    items.push({
      id: "remove",
      label: server ? t("info.removeServer") : t("info.remove"),
      icon: <UserMinus size={14} />,
      danger: true,
    });
  }

  const status = me ? null : presence !== undefined ? statusLine(presence) : t("info.notFriend");

  return (
    <li className="flex min-w-0 items-center gap-10 rounded-md px-4 py-4">
      <Avatar name={name} src={member.user.avatarUrl} size="sm" status={presence?.status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-6">
          <span className="truncate text-body-md text-fg [unicode-bidi:isolate]">{name}</span>
          {me ? <span className="shrink-0 text-body-sm text-fg-muted">{t("info.you")}</span> : null}
          {isOwner ? (
            <span className="flex shrink-0 items-center gap-4 text-label-xs text-fg-warm" title={server ? t("info.host") : t("info.creator")}>
              <Crown size={12} aria-hidden="true" />
              {server ? t("info.host") : t("info.creator")}
            </span>
          ) : null}
        </span>
        {status !== null ? <span className="truncate text-body-sm text-fg-muted">{status}</span> : null}
      </span>
      {items.length > 0 ? (
        <Menu
          size="sm"
          ariaLabel={t("info.memberMenu", { name })}
          items={items}
          onSelect={(id) => {
            if (id === "message") message.open(member.user.id);
            if (id === "remove") onRemove();
          }}
        />
      ) : null}
    </li>
  );
}

import { Crown, KeyRound, LogOut, UserPlus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Avatar, Badge, Button, Combobox, Dialog, Input, RadioCard } from "../../ui";
import { LinkButton } from "../bits";
import { useFailureText } from "../errors";
import { useCommunityApi, useCommunityPlatform } from "../platform";
import type { Community, CommunityPerson } from "../types";
import { useAction } from "../useRemote";
import { Section, SectionNoticeLine, useSectionNotice } from "./parts";
import { accountIdOf, LIMITS } from "./validate";

/** Someone the screen offers: a person and why they may be picked. */
export interface Candidate {
  person: CommunityPerson;
  /** A friend, an editor, or both. */
  hint: string;
}

/**
 * Picks an account: a friend from a list with a search, or — for an
 * administrator, and wherever the host cannot list friends — an account id.
 * Either way the pick goes to `onPick` by its button.
 */
export function PersonPicker({
  candidates,
  byId,
  label,
  actionLabel,
  busy,
  onPick,
}: {
  /** `null` while the host is asking for them; `undefined` where it cannot. */
  candidates: Candidate[] | null | undefined;
  byId: boolean;
  label: string;
  actionLabel: string;
  busy: boolean;
  onPick: (person: { id: string; name: string | null }) => void;
}) {
  const { t } = useTranslation("community");
  const id = useId();
  const [chosen, setChosen] = useState("");
  const [typed, setTyped] = useState("");
  const [typedWrong, setTypedWrong] = useState(false);
  const showId = byId || candidates === undefined;
  const pickTyped = () => {
    const account = accountIdOf(typed);
    if (account === null) {
      setTypedWrong(true);
      return;
    }
    const known = candidates?.find((candidate) => candidate.person.id === account);
    onPick({ id: account, name: known?.person.displayName ?? null });
    setTyped("");
  };
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {candidates !== undefined ? (
        <div className="flex min-w-0 flex-col gap-6">
          <span id={`${id}-friend`} className="text-body-sm-medium text-fg-secondary">
            {label}
          </span>
          <div className="flex min-w-0 flex-wrap gap-8">
            <Combobox
              value={chosen}
              onChange={setChosen}
              className="min-w-0 flex-1 basis-[200px]"
              ariaLabel={label}
              searchLabel={t("manage.team.search")}
              emptyText={t("manage.team.nobody")}
              placeholder={candidates === null ? t("manage.team.friendsLoading") : candidates.length === 0 ? t("manage.team.nobody") : t("manage.team.pickPlaceholder")}
              disabled={candidates === null || candidates.length === 0}
              options={(candidates ?? []).map((candidate) => ({ value: candidate.person.id, label: candidate.person.displayName, hint: candidate.hint }))}
            />
            <Button
              wrap
              disabled={busy || chosen === "" || !candidates?.some((candidate) => candidate.person.id === chosen)}
              onClick={() => {
                const candidate = candidates?.find((item) => item.person.id === chosen);
                if (candidate) onPick({ id: candidate.person.id, name: candidate.person.displayName });
                setChosen("");
              }}
            >
              {actionLabel}
            </Button>
          </div>
        </div>
      ) : null}
      {showId ? (
        <div className="flex min-w-0 flex-col gap-6">
          <label htmlFor={`${id}-account`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.team.byId")}
          </label>
          <div className="flex min-w-0 flex-wrap gap-8">
            <Input
              id={`${id}-account`}
              className="min-w-0 flex-1 basis-[200px]"
              spellCheck={false}
              placeholder={t("manage.team.byIdPlaceholder")}
              value={typed}
              invalid={typedWrong}
              onChange={(event) => {
                setTyped(event.target.value);
                setTypedWrong(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  pickTyped();
                }
              }}
            />
            <Button wrap disabled={busy || typed.trim() === ""} onClick={pickTyped}>
              {actionLabel}
            </Button>
          </div>
          {typedWrong ? (
            <span role="alert" className="text-body-sm text-fg-danger">
              {t("manage.team.byIdWrong")}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A person of the team: the avatar, the name, «you», the role and an action. */
function PersonRow({ person, you, badge, end }: { person: CommunityPerson; you: boolean; badge: ReactNode; end?: ReactNode }) {
  const { t } = useTranslation("community");
  return (
    <li className="-mx-8 flex min-h-44 min-w-0 flex-wrap items-center gap-x-10 gap-y-4 rounded-md px-8 py-6 hover:bg-hover-overlay">
      <Avatar name={person.displayName} src={person.avatarUrl} />
      <span className="flex min-w-0 flex-1 items-baseline gap-8">
        <span className="min-w-0 text-body-md-medium text-fg [overflow-wrap:anywhere]">{person.displayName}</span>
        {you ? <span className="shrink-0 text-body-sm text-fg-secondary">{t("manage.team.you")}</span> : null}
      </span>
      {badge}
      {end}
    </li>
  );
}

/** The people of a list in one order: friends by name. */
function byName(a: CommunityPerson, b: CommunityPerson): number {
  return a.displayName.localeCompare(b.displayName);
}

/**
 * **Editors and ownership**: the owner, the editors, and what the reader may
 * do with them. The owner names editors among JKNet friends and hands the
 * community to a friend or an editor; an administrator names any account. An
 * editor may step down. Every change goes to the service at once.
 */
export function TeamSection({
  community,
  onApplied,
  onLeft,
  onAssignOwner,
}: {
  community: Community;
  onApplied: (community: Community) => void;
  /** The reader stepped down and manages the page no more. */
  onLeft: () => void;
  /** Scrolls to the administrator's way to name an owner. */
  onAssignOwner: () => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const [notice, setNotice] = useSectionNotice();
  const [dialog, setDialog] = useState<"transfer" | "leave" | null>(null);
  const viewer = community.viewer;
  const admin = viewer?.isAdmin === true;
  const owner = viewer?.role === "owner";
  const manages = owner || admin;
  const me = platform.accountId;
  const editorIds = new Set(community.editors.map((editor) => editor.id));
  const friends = platform.friends;

  const addCandidates: Candidate[] | null | undefined =
    friends === undefined || friends === null
      ? friends
      : friends
          .filter((friend) => friend.id !== community.ownerId && friend.id !== me && !editorIds.has(friend.id))
          .sort(byName)
          .map((person) => ({ person, hint: t("manage.team.friend") }));

  const run = (work: () => Promise<Community>, done: (next: Community) => string) =>
    action.run(
      async () => {
        setNotice(null);
        const next = await work();
        onApplied(next);
        setNotice({ tone: "success", text: done(next) });
      },
      (reason) => setNotice({ tone: "danger", text: failure(reason) }),
    );

  const nameOf = (next: Community, id: string, fallback: string | null) =>
    next.editors.find((editor) => editor.id === id)?.displayName ?? (next.owner?.id === id ? next.owner.displayName : null) ?? fallback ?? id;

  const note = admin
    ? community.ownerId === null
      ? t("manage.team.noteAdminNoOwner")
      : t("manage.team.noteAdmin")
    : owner
      ? t("manage.team.noteOwner")
      : community.owner
        ? t("manage.team.noteEditor", { name: community.owner.displayName })
        : t("manage.team.noteEditorNoOwner");

  return (
    <Section
      section="team"
      title={t("manage.sections.team")}
      count={t("manage.team.count", { count: community.editors.length, max: LIMITS.editors })}
    >
      <ul className="flex min-w-0 flex-col gap-4">
        {community.owner ? (
          <PersonRow
            person={community.owner}
            you={community.owner.id === me}
            badge={
              <Badge tone="warm" icon={<Crown size={12} />}>
                {t("roles.owner")}
              </Badge>
            }
          />
        ) : (
          <li className="-mx-8 flex min-h-44 min-w-0 flex-wrap items-center gap-x-10 gap-y-4 px-8 py-6">
            <span className="flex size-32 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-body-sm-medium text-fg-secondary" aria-hidden="true">
              ?
            </span>
            <span className="min-w-0 flex-1 text-body-md text-fg-secondary">{t("manage.team.noOwner")}</span>
            {admin ? (
              <LinkButton onClick={onAssignOwner}>{t("manage.team.assign")}</LinkButton>
            ) : null}
          </li>
        )}
        {community.editors.map((editor) => (
          <PersonRow
            key={editor.id}
            person={editor}
            you={editor.id === me}
            badge={<Badge>{t("roles.editor")}</Badge>}
            end={
              manages ? (
                <Button
                  size="sm"
                  variant="ghost"
                  wrap
                  disabled={action.busy}
                  aria-label={t("manage.team.removeLabel", { name: editor.displayName })}
                  onClick={() =>
                    void run(
                      () => api.removeEditor(community.id, editor.id),
                      () => t("manage.team.removed", { name: editor.displayName }),
                    )
                  }
                >
                  {t("manage.team.remove")}
                </Button>
              ) : editor.id === me ? (
                <Button size="sm" variant="ghost" wrap icon={<LogOut size={14} />} disabled={action.busy} onClick={() => setDialog("leave")}>
                  {t("manage.team.leave")}
                </Button>
              ) : null
            }
          />
        ))}
      </ul>
      {community.editors.length === 0 ? <p className="-mt-8 text-body-sm text-fg-secondary">{t("manage.team.noEditors")}</p> : null}

      {manages ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-16 @max-[720px]/community:grid-cols-1">
          {community.editors.length < LIMITS.editors ? (
            <PersonPicker
              candidates={addCandidates}
              byId={admin}
              label={t("manage.team.addFriend")}
              actionLabel={t("manage.team.add")}
              busy={action.busy}
              onPick={(person) =>
                void run(
                  () => api.addEditor(community.id, person.id),
                  (next) => t("manage.team.added", { name: nameOf(next, person.id, person.name) }),
                )
              }
            />
          ) : (
            <p className="text-body-sm text-fg-secondary">{t("manage.team.full")}</p>
          )}
          {community.ownerId !== null ? (
            <Button wrap icon={<KeyRound size={16} />} disabled={action.busy} onClick={() => setDialog("transfer")}>
              {t("manage.team.transfer")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="text-body-sm text-fg-secondary">{note}</p>
      <SectionNoticeLine notice={notice} />

      {dialog === "transfer" ? (
        <TransferDialog
          community={community}
          admin={admin}
          busy={action.busy}
          onClose={() => setDialog(null)}
          onTransfer={(person) =>
            void action.run(
              async () => {
                setNotice(null);
                const next = await api.transfer(community.id, person.id);
                setDialog(null);
                onApplied(next);
                setNotice({ tone: "success", text: t("manage.team.transferred", { name: next.owner?.displayName ?? person.name ?? person.id }) });
              },
              (reason) => {
                setDialog(null);
                setNotice({ tone: "danger", text: failure(reason) });
              },
            )
          }
        />
      ) : null}

      {dialog === "leave" && me !== null ? (
        <Dialog
          title={t("manage.team.leaveTitle")}
          body={t("manage.team.leaveText", { name: community.name })}
          variant="danger"
          onClose={() => setDialog(null)}
          actions={
            <>
              <Button variant="ghost" wrap disabled={action.busy} onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                wrap
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    async () => {
                      await api.removeEditor(community.id, me);
                      setDialog(null);
                      onLeft();
                    },
                    (reason) => {
                      setDialog(null);
                      setNotice({ tone: "danger", text: failure(reason) });
                    },
                  )
                }
              >
                {t("manage.team.leaveConfirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </Section>
  );
}

/**
 * **Hand over ownership**: the editors and the reader's friends, one to
 * pick, and for an administrator any account by its id. The previous owner
 * stays an editor.
 */
function TransferDialog({
  community,
  admin,
  busy,
  onClose,
  onTransfer,
}: {
  community: Community;
  admin: boolean;
  busy: boolean;
  onClose: () => void;
  onTransfer: (person: { id: string; name: string | null }) => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const name = useId();
  const me = platform.accountId;
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const editors = community.editors.filter((editor) => editor.id !== me && editor.id !== community.ownerId);
  const friends = (platform.friends ?? []).filter(
    (friend) => friend.id !== me && friend.id !== community.ownerId && !editors.some((editor) => editor.id === friend.id),
  );
  const candidates: Candidate[] = [
    ...editors.map((person) => ({
      person,
      hint: (platform.friends ?? []).some((friend) => friend.id === person.id) ? t("manage.team.editorFriend") : t("roles.editor"),
    })),
    ...[...friends].sort(byName).map((person) => ({ person, hint: t("manage.team.friend") })),
  ];
  const typedId = accountIdOf(typed);
  const chosen = typedId !== null ? { id: typedId, name: null } : candidates.find((candidate) => candidate.person.id === picked);
  const target = chosen === undefined ? null : "person" in chosen ? { id: chosen.person.id, name: chosen.person.displayName } : chosen;
  const owner = community.owner?.displayName ?? null;
  const body =
    community.ownerId === me || !owner ? t("manage.team.transferText") : t("manage.team.transferTextOther", { name: owner });

  return (
    <Dialog
      title={t("manage.team.transferTitle")}
      body={body}
      variant="danger"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" wrap disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" wrap disabled={busy || target === null} onClick={() => target && onTransfer(target)}>
            {t("manage.team.transferConfirm")}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[min(360px,50vh)] flex-col gap-6 overflow-y-auto pt-16">
        {candidates.map((candidate) => (
          <RadioCard
            key={candidate.person.id}
            name={name}
            selected={picked === candidate.person.id && typedId === null}
            onSelect={() => {
              setPicked(candidate.person.id);
              setTyped("");
            }}
            title={
              <span className="flex min-w-0 items-center gap-8">
                <Avatar name={candidate.person.displayName} src={candidate.person.avatarUrl} size="sm" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{candidate.person.displayName}</span>
              </span>
            }
            aside={<span className="text-mono-xs text-fg-secondary">{candidate.hint}</span>}
          />
        ))}
        {candidates.length === 0 && !admin ? <p className="text-body-sm text-fg-secondary">{t("manage.team.transferNone")}</p> : null}
      </div>
      {admin ? (
        <div className="flex flex-col gap-6 pt-12">
          <label htmlFor={`${name}-account`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.team.byIdAny")}
          </label>
          <Input
            id={`${name}-account`}
            spellCheck={false}
            placeholder={t("manage.team.byIdPlaceholder")}
            value={typed}
            invalid={typed.trim() !== "" && typedId === null}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      ) : null}
      <p className="flex items-center gap-8 pt-12 text-body-sm text-fg-secondary">
        <UserPlus size={14} className="shrink-0" aria-hidden="true" />
        {t("manage.team.transferRule")}
      </p>
    </Dialog>
  );
}

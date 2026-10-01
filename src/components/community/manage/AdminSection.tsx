import { Crown, ShieldCheck, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Avatar, Badge, Button, Dialog, Input, Toggle } from "../../ui";
import { useFailureText } from "../errors";
import { useCommunityApi, useCommunityPlatform } from "../platform";
import type { Community } from "../types";
import { useAction } from "../useRemote";
import { Section, SectionNoticeLine, useSectionNotice } from "./parts";
import { PersonPicker, type Candidate } from "./TeamSection";

/**
 * **Administration**, for the JKNet administrators alone: the owner, the
 * **JKNet community** mark, publishing a page without an owner in the
 * catalogue, and deleting the community. Each change goes to the service at
 * once; deleting asks for the name first.
 */
export function AdminSection({
  community,
  onApplied,
  onDeleted,
}: {
  community: Community;
  onApplied: (community: Community) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const [notice, setNotice] = useSectionNotice();
  const [deleting, setDeleting] = useState(false);
  const owned = community.ownerId !== null;

  const friends = platform.friends;
  const candidates: Candidate[] | null | undefined =
    friends === null
      ? null
      : [
          ...community.editors.map((person) => ({ person, hint: t("roles.editor") })),
          ...(friends ?? [])
            .filter((friend) => !community.editors.some((editor) => editor.id === friend.id))
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((person) => ({ person, hint: t("manage.team.friend") })),
        ];

  const change = (body: { ownerId?: string | null; featured?: boolean; listed?: boolean }, done?: (next: Community) => string) =>
    action.run(
      async () => {
        setNotice(null);
        const next = await api.admin(community.id, body);
        onApplied(next);
        if (done) setNotice({ tone: "success", text: done(next) });
      },
      (reason) => setNotice({ tone: "danger", text: failure(reason) }),
    );

  /**
   * Removes the owner and keeps them as an editor, as the design promises:
   * the service drops the owner alone, and the administrator names the
   * previous owner an editor in a second write.
   */
  const clearOwner = () => {
    const previous = community.owner;
    void action.run(
      async () => {
        setNotice(null);
        let next = await api.admin(community.id, { ownerId: null });
        onApplied(next);
        if (previous) {
          try {
            next = await api.addEditor(community.id, previous.id);
            onApplied(next);
            setNotice({ tone: "success", text: t("manage.admin.cleared", { name: previous.displayName }) });
          } catch (reason) {
            setNotice({ tone: "danger", text: t("manage.admin.clearedNotEditor", { name: previous.displayName, reason: failure(reason) }) });
          }
        }
      },
      (reason) => setNotice({ tone: "danger", text: failure(reason) }),
    );
  };

  const listedHint = owned ? t("manage.admin.listedOwned") : community.listed ? t("manage.admin.listedOn") : t("manage.admin.listedOff");

  return (
    <Section
      section="admin"
      title={t("manage.sections.admin")}
      tools={
        <Badge tone="purple" icon={<ShieldCheck size={12} />}>
          {t("manage.admin.only")}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 items-start gap-24 @max-[880px]/community:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-8">
          <span className="text-body-sm-medium text-fg-secondary">{t("manage.admin.owner")}</span>
          {community.owner ? (
            <>
              <div className="flex min-h-44 min-w-0 flex-wrap items-center gap-x-10 gap-y-4">
                <Avatar name={community.owner.displayName} src={community.owner.avatarUrl} />
                <span className="min-w-0 flex-1 text-body-md-medium text-fg [overflow-wrap:anywhere]">{community.owner.displayName}</span>
                <Badge tone="warm" icon={<Crown size={12} />}>
                  {t("roles.owner")}
                </Badge>
                <Button size="sm" variant="ghost" wrap disabled={action.busy} onClick={clearOwner}>
                  {t("manage.admin.clear")}
                </Button>
              </div>
              <p className="text-body-sm text-fg-secondary">{t("manage.admin.clearHint")}</p>
            </>
          ) : (
            <>
              <PersonPicker
                candidates={candidates}
                byId
                label={t("manage.admin.ownerPick")}
                actionLabel={t("manage.admin.assign")}
                busy={action.busy}
                onPick={(person) =>
                  void change({ ownerId: person.id }, (next) =>
                    t("manage.admin.assigned", { name: next.owner?.displayName ?? person.name ?? person.id }),
                  )
                }
              />
              <p className="text-body-sm text-fg-secondary">{t("manage.admin.assignHint")}</p>
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-16">
          <Setting
            title={t("manage.admin.featured")}
            hint={t("manage.admin.featuredHint")}
            checked={community.featured}
            disabled={action.busy}
            onChange={(featured) => void change({ featured })}
          />
          <Setting
            title={t("manage.admin.listed")}
            hint={listedHint}
            checked={community.listed && !owned}
            disabled={action.busy || owned}
            onChange={(listed) => void change({ listed })}
          />
        </div>
      </div>
      <SectionNoticeLine notice={notice} />
      <div className="flex min-w-0 flex-wrap items-center gap-16 rounded-md border border-line-danger bg-danger-subtle px-16 py-14">
        <span className="flex min-w-0 flex-1 basis-[240px] flex-col gap-2">
          <span className="text-body-md-medium text-fg-danger">{t("manage.admin.delete")}</span>
          <span className="text-body-sm text-fg-secondary">{t("manage.admin.deleteHint")}</span>
        </span>
        <Button variant="danger" wrap icon={<Trash2 size={16} />} disabled={action.busy} onClick={() => setDeleting(true)}>
          {t("manage.admin.delete")}
        </Button>
      </div>
      {deleting ? (
        <DeleteDialog
          community={community}
          busy={action.busy}
          onClose={() => setDeleting(false)}
          onDelete={() =>
            void action.run(
              async () => {
                await api.remove(community.id);
                setDeleting(false);
                onDeleted();
              },
              (reason) => {
                setDeleting(false);
                setNotice({ tone: "danger", text: failure(reason) });
              },
            )
          }
        />
      ) : null}
    </Section>
  );
}

/** A switch with its title and the line under it. */
function Setting({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-16">
      <span className="flex min-w-0 flex-col gap-2">
        <span className="text-body-md-medium text-fg">{title}</span>
        <span className="text-body-sm text-fg-secondary">{hint}</span>
      </span>
      <Toggle checked={checked} disabled={disabled} label={title} onChange={onChange} />
    </div>
  );
}

/** **Delete the community?** — the name typed out before the button wakes. */
function DeleteDialog({ community, busy, onClose, onDelete }: { community: Community; busy: boolean; onClose: () => void; onDelete: () => void }) {
  const { t } = useTranslation("community");
  const id = useId();
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === community.name.trim();
  return (
    <Dialog
      title={t("manage.admin.deleteTitle")}
      body={t("manage.admin.deleteText", { name: community.name })}
      variant="danger"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" wrap disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" wrap disabled={busy || !matches} onClick={onDelete}>
            {t("manage.admin.deleteConfirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 pt-16">
        <label htmlFor={`${id}-name`} className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">
          <Trans t={t} i18nKey="manage.admin.deleteType" values={{ name: community.name }} components={[<b className="font-semibold text-fg" />]} />
        </label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches && !busy) {
              event.preventDefault();
              onDelete();
            }
          }}
        />
      </div>
    </Dialog>
  );
}

import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import type { Client, PlayerProfile } from "../../lib/ipc";
import {
  useDeleteProfile,
  useProfiles,
  useSetDefaultProfile,
} from "../../lib/queries";
import { Badge, Button, Dialog } from "../ui";
import { ColoredNickname } from "./ColoredNickname";
import { blankProfile, ProfileForm } from "./ProfileForm";

/**
 * The player profiles of one client: the list, and the form over it.
 *
 * A profile is who the player is inside the game — the nickname other players
 * read, the skin, the hilts and the colours — and it belongs to this client.
 * One of them is the default, and that is the one **Play** and **Connect**
 * start with; the rest wait for the Connect dialog to offer them.
 *
 * The list and the form never show at once. The form is tall — a grid of skins
 * alone is a third of the window — and a list underneath it would only be
 * something to scroll past.
 */
export function PlayerProfilesCard({ client }: { client: Client }) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const book = useProfiles(client.id);
  const remove = useDeleteProfile(client.id);
  const setDefault = useSetDefaultProfile(client.id);

  /** The profile being edited, or `null` while the list is on screen. */
  const [editing, setEditing] = useState<PlayerProfile | null>(null);
  /** The profile the confirmation dialog is about. */
  const [removing, setRemoving] = useState<PlayerProfile | null>(null);

  const profiles = book.data?.profiles ?? [];
  const defaultId = book.data?.defaultProfileId ?? null;
  const failure = book.error ?? remove.error ?? setDefault.error;

  if (editing !== null) {
    return (
      <ProfileForm
        client={client}
        profile={editing}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-12">
      <p className="text-body-sm text-fg-muted">
        {t("clientWindow.profiles.intro")}
      </p>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger break-words">
          {errorText(failure)}
        </p>
      ) : null}

      {profiles.length === 0 ? (
        <p className="text-body-sm text-fg-muted">
          {t("clientWindow.profiles.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className={cn(
                "flex items-center gap-12 px-12 py-8 rounded-md",
                "border border-line bg-input",
              )}
            >
              <span className="flex-1 min-w-0 flex flex-col gap-2">
                <span className="flex items-center gap-8 min-w-0">
                  <span className="text-body-md text-fg truncate">{profile.name}</span>
                  {profile.id === defaultId ? (
                    <Badge tone="accent">{t("card.default")}</Badge>
                  ) : null}
                </span>
                <ColoredNickname
                  raw={profile.nickname ?? ""}
                  placeholder={t("clientWindow.profiles.noNickname")}
                  className="text-body-sm text-fg-secondary truncate"
                />
              </span>

              {profile.id === defaultId ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Star size={14} />}
                  disabled={setDefault.isPending}
                  title={t("clientWindow.profiles.makeDefault")}
                  aria-label={t("clientWindow.profiles.makeDefault")}
                  onClick={() => setDefault.mutate(profile.id)}
                />
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={<Pencil size={14} />}
                title={t("clientWindow.profiles.edit", { profile: profile.name })}
                aria-label={t("clientWindow.profiles.edit", { profile: profile.name })}
                onClick={() => setEditing(profile)}
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={14} />}
                title={t("clientWindow.profiles.remove", { profile: profile.name })}
                aria-label={t("clientWindow.profiles.remove", { profile: profile.name })}
                onClick={() => setRemoving(profile)}
              />
            </li>
          ))}
        </ul>
      )}

      <span>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={14} />}
          onClick={() => setEditing(blankProfile())}
        >
          {t("clientWindow.profiles.new")}
        </Button>
      </span>

      {removing !== null ? (
        <Dialog
          variant="danger"
          title={t("clientWindow.profiles.removeDialog.title", {
            profile: removing.name,
          })}
          body={t("clientWindow.profiles.removeDialog.body")}
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRemoving(null)}
              >
                {t("clientWindow.profiles.form.cancel")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(removing.id, {
                    onSettled: () => setRemoving(null),
                  });
                }}
              >
                {t("clientWindow.profiles.removeDialog.confirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

import { UserRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { parseCharColor, type ProfileCardFields } from "../../../lib/chat/cardDrafts";
import { clientsOfGame, useActiveGame, useDefaultClient, useGameNames } from "../../../lib/game";
import { SABER_BLADE_RGB, type ChatCardProfile } from "../../../lib/ipc";
import { useChatCardToProfile, useClients } from "../../../lib/queries";
import { ColoredNickname } from "../../client/ColoredNickname";
import { ProfileForm } from "../../client/ProfileForm";
import { Button, Dialog, Select } from "../../ui";
import { Layer } from "../Layer";
import { CardFact, CardShell, CardStatus } from "./CardShell";
import type { CardViewProps } from "./withFields";

/**
 * --- slice: chat cards ---
 *
 * A player profile: the nickname in its colours, the model, the hilts, the
 * blades and the tint.
 *
 * **Save as my profile** asks the core to turn the card into a new profile
 * (`chat_card_to_profile`), which checks every value with the rules of the
 * profile form, and opens that form on it in a client of the active game.
 * Nothing is saved until the player presses **Save profile** there.
 */
export function ProfileCardView({ card, fields }: CardViewProps<"profile">) {
  const { t } = useTranslation("chat");
  const { t: tClients } = useTranslation("clients");
  const errorText = useErrorText();
  const toProfile = useChatCardToProfile();
  const [draft, setDraft] = useState<ChatCardProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const title = fields.nickname;

  const blade = (value: string | null) => {
    if (value === null || !/^[0-5]$/.test(value)) return null;
    const index = Number(value);
    return (
      <span className="inline-flex items-center gap-4">
        <span aria-hidden="true" className="size-8 rounded-full" style={{ backgroundColor: SABER_BLADE_RGB[index] }} />
        {tClients(`clientWindow.profiles.saberColors.${index as 0 | 1 | 2 | 3 | 4 | 5}`)}
      </span>
    );
  };
  const tint = parseCharColor(fields.charColor);

  return (
    <>
      <CardShell
        label={t("cards.label", { kind: t("cards.kinds.profile"), title: fields.nickname })}
        icon={<UserRound size={16} />}
        title={<ColoredNickname raw={title} placeholder={fields.model} />}
        subtitle={t("cards.kinds.profile")}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={toProfile.isPending}
            onClick={() => {
              setSaved(false);
              toProfile.mutate(card, { onSuccess: setDraft });
            }}
          >
            {t("cards.profile.save")}
          </Button>
        }
        status={
          toProfile.error ? (
            <CardStatus tone="danger">{errorText(toProfile.error)}</CardStatus>
          ) : saved ? (
            <CardStatus tone="success">{t("cards.profile.saved")}</CardStatus>
          ) : null
        }
      >
        <dl className="flex flex-col gap-2">
          <CardFact label={t("cards.profile.model")}>
            <span className="text-mono-xs">{fields.model}</span>
          </CardFact>
          <CardFact label={t("cards.profile.hilts")}>
            <span className="text-mono-xs">{[fields.saber1, fields.saber2].filter(Boolean).join(", ")}</span>
          </CardFact>
          <CardFact label={t("cards.profile.blades")}>
            <span className="inline-flex flex-wrap items-center gap-x-8">
              {blade(fields.color1)}
              {fields.saber2 !== null ? blade(fields.color2) : null}
            </span>
          </CardFact>
          {tint !== null ? (
            <CardFact label={t("cards.profile.tint")}>
              <span className="inline-flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className="size-10 rounded-xs border border-line"
                  style={{ backgroundColor: `rgb(${tint.red}, ${tint.green}, ${tint.blue})` }}
                />
                <span className="text-mono-xs">{fields.charColor}</span>
              </span>
            </CardFact>
          ) : null}
        </dl>
      </CardShell>
      {draft !== null ? (
        <Layer>
          <ProfileApplyDialog
            draft={draft}
            fields={fields}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              setSaved(true);
            }}
          />
        </Layer>
      ) : null}
    </>
  );
}

/**
 * The profile form of the Player profiles screen, over the chat, filled in
 * from the card: which client keeps the profile, and the form itself.
 */
function ProfileApplyDialog({
  draft,
  fields,
  onClose,
  onSaved,
}: {
  draft: ChatCardProfile;
  fields: ProfileCardFields;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("chat");
  const game = useActiveGame();
  const games = useGameNames();
  const clients = useClients();
  const fallback = useDefaultClient();
  const own = clientsOfGame(clients.data, game);
  const [clientId, setClientId] = useState<string | null>(null);
  const client = own.find((entry) => entry.id === (clientId ?? fallback?.id)) ?? own[0];

  return (
    <Dialog
      wide
      title={t("apply.profile.title", { name: draft.profile.name || fields.model })}
      body={t("apply.profile.body")}
      onClose={onClose}
      actions={null}
    >
      <div className="flex flex-col gap-12 pt-12">
        {draft.skipped.length > 0 ? (
          <p className="rounded-md border border-line-warm bg-warm-subtle px-10 py-8 text-body-sm text-fg-warm">
            {t("apply.profile.skipped", { fields: draft.skipped.join(", ") })}
          </p>
        ) : null}
        {client === undefined ? (
          <p className="text-body-sm text-fg-muted">{t("cards.noClient", { game: games.label(game) })}</p>
        ) : (
          <>
            <Select
              label={t("apply.profile.client")}
              ariaLabel={t("apply.profile.client")}
              value={client.id}
              options={own.map((entry) => ({ value: entry.id, label: entry.name }))}
              onChange={setClientId}
              className="w-full max-w-400"
            />
            <div className="max-h-[60vh] overflow-y-auto pr-4">
              <ProfileForm key={client.id} client={client} profile={draft.profile} onDone={onClose} onSaved={onSaved} />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

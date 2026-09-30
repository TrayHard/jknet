import { AlertTriangle, Check, LogOut, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useProviderNames } from "../../../../src/components/account/provider.ts";
import { Avatar, Badge, Button, Dialog, Input } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import type { OnlineUser } from "../../../../src/lib/ipc.ts";
import {
  useAccountState,
  useDeleteAccount,
  useSignOut,
  useUpdateDisplayName,
} from "../../../../src/lib/queries.ts";
import { deviceKind } from "../device.ts";

/**
 * Settings · Account: who is signed in, the display name, and the two ways
 * out — sign this browser out, or delete the account on the service.
 */
export function AccountScreen() {
  const account = useAccountState().data;
  const user = account?.onlineUser ?? null;
  if (user === null) return null;
  return (
    <div className="flex max-w-[640px] flex-col gap-24 px-16 py-24 sm:px-40 sm:py-32">
      <Identity user={user} />
      <DisplayName user={user} />
      <DangerZone />
    </div>
  );
}

function Identity({ user }: { user: OnlineUser }) {
  const { t } = useTranslation("account");
  const { t: tFriends } = useTranslation("friends");
  const providers = useProviderNames();
  const device = deviceKind();
  // The badge goes under the name where the row is narrow: beside it on a
  // phone, it left the name and the sentence a few letters.
  return (
    <div data-testid="account-identity" className="flex flex-wrap items-center gap-x-16 gap-y-8">
      <Avatar name={user.displayName} src={user.avatarUrl} size="lg" status="online" device={device} />
      <span className="flex min-w-0 flex-1 basis-192 flex-col gap-2">
        <span data-testid="account-name" className="text-display-md text-fg [overflow-wrap:anywhere]">
          {user.displayName}
        </span>
        <span className="text-body-sm text-fg-muted [overflow-wrap:anywhere]">{providers.line(user.provider, user.providerName)}</span>
        <span className="text-body-sm text-fg-success">
          {tFriends(device === "phone" ? "status.onlineFromPhone" : "status.onlineInBrowser")}
        </span>
      </span>
      <Badge tone="success" icon={<Check size={12} />}>
        {t("card.linked", { provider: providers.label(user.provider) })}
      </Badge>
    </div>
  );
}

/** The display name, saved with its button: the service may refuse a name that is taken. */
function DisplayName({ user }: { user: OnlineUser }) {
  const { t } = useTranslation("account");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const rename = useUpdateDisplayName();
  const [value, setValue] = useState(user.displayName);
  const [saved, setSaved] = useState(false);

  useEffect(() => setValue(user.displayName), [user.displayName]);

  const changed = value.trim() !== user.displayName;
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed) return;
        setSaved(false);
        rename.mutate(value.trim(), { onSuccess: () => setSaved(true) });
      }}
    >
      <label htmlFor="display-name" className="text-label-xs text-fg-muted">
        {t("displayName.label")}
      </label>
      <div className="flex gap-8">
        <Input
          id="display-name"
          value={value}
          maxLength={24}
          autoComplete="nickname"
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
          }}
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={!changed || rename.isPending}>
          {rename.isPending ? tCommon("states.saving") : tCommon("actions.save")}
        </Button>
      </div>
      <p className="text-body-sm text-fg-muted">
        {rename.error != null ? (
          <span className="text-fg-danger">{errorText(rename.error)}</span>
        ) : saved ? (
          t("displayName.saved")
        ) : (
          t("displayName.rules")
        )}
      </p>
    </form>
  );
}

function DangerZone() {
  const { t } = useTranslation("account");
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const signOut = useSignOut();
  const deleteAccount = useDeleteAccount();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div data-testid="danger-zone" className="rounded-md border border-line-danger bg-danger-subtle p-12">
      <h3 className="flex items-center gap-8 text-body-md-medium text-fg">
        <AlertTriangle size={16} className="text-fg-danger" />
        {t("danger.title")}
      </h3>
      {error !== null ? (
        <p role="alert" className="pt-8 text-body-sm text-fg-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-12 pt-12">
        <span className="flex min-w-0 flex-1 basis-192 flex-col">
          <span className="text-body-sm-medium text-fg">{t("danger.signOut")}</span>
          <span className="text-body-sm text-fg-muted">{tWeb("account.signOutText")}</span>
        </span>
        <Button
          wrap
          icon={<LogOut size={16} />}
          disabled={signOut.isPending}
          onClick={() => {
            setError(null);
            signOut.mutate(undefined, { onError: (failure) => setError(errorText(failure)) });
          }}
        >
          {signOut.isPending ? t("danger.signingOut") : t("danger.signOut")}
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-12 pt-12">
        <span className="flex min-w-0 flex-1 basis-192 flex-col">
          <span className="text-body-sm-medium text-fg">{t("danger.delete")}</span>
          <span className="text-body-sm text-fg-muted">{tWeb("account.deleteText")}</span>
        </span>
        <Button
          wrap
          variant="danger"
          icon={<Trash2 size={16} />}
          disabled={deleteAccount.isPending}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {t("danger.delete")}
        </Button>
      </div>

      {confirming ? (
        <Dialog
          variant="danger"
          title={t("danger.confirmTitle")}
          body={tWeb("account.deleteBody")}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)} disabled={deleteAccount.isPending}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={deleteAccount.isPending}
                onClick={() =>
                  deleteAccount.mutate(undefined, {
                    onSuccess: () => setConfirming(false),
                    onError: (failure) => {
                      setConfirming(false);
                      setError(errorText(failure));
                    },
                  })
                }
              >
                {deleteAccount.isPending ? tCommon("states.deleting") : t("danger.confirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

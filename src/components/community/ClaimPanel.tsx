import { Check, Copy, KeyRound, LogIn, ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Select } from "../ui";
import { Notice, Panel, PanelHead, useCopy } from "./bits";
import { useFailureText } from "./errors";
import { formatMoment, serverName } from "./format";
import { useCommunityApi, useCommunityPlatform } from "./platform";
import type { Community, CommunityClaim, CommunityServer } from "./types";
import { useAction } from "./useRemote";

/**
 * **Is this your server?** — the claim of a server of a community without an
 * owner, for a reader who does not organize it.
 *
 * Two ways, as before communities: a code the player puts into
 * `sv_hostname` and the service reads back over UDP, or a request an
 * administrator of JKNet approves. A proof makes the author the owner. A
 * claim still open from an earlier visit is picked up from `GET me`.
 */
export function ClaimPanel({
  servers,
  preferred,
  claims,
  onVerified,
}: {
  servers: CommunityServer[];
  /** The server picked in **Play**, offered first. */
  preferred: string | null;
  /** The reader's claims of this contract, from `GET me`. */
  claims: CommunityClaim[];
  /** The service confirmed the proof: the community the server is in now. */
  onVerified: (community: Community) => void;
}) {
  const { t, i18n } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const { copied, copy } = useCopy();
  const [serverId, setServerId] = useState(preferred ?? servers[0]?.id ?? "");
  const [claim, setClaim] = useState<CommunityClaim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!servers.some((server) => server.id === serverId)) setServerId(servers[0]?.id ?? "");
  }, [servers, serverId]);

  // The open claim of this server, from an earlier visit.
  const known = claims.find((item) => item.serverId === serverId && item.status === "pending") ?? null;
  const shown = claim !== null && claim.serverId === serverId ? claim : known;

  const ask = (manual: boolean) =>
    action.run(
      async () => {
        setError(null);
        setClaim(await api.claim(serverId, manual));
      },
      (reason) => setError(failure(reason)),
    );

  const verify = (current: CommunityClaim) =>
    action.run(
      async () => {
        setError(null);
        const verified = await api.verify(current.id);
        setClaim({ ...current, status: "approved" });
        setDone(true);
        onVerified(verified);
      },
      (reason) => setError(failure(reason)),
    );

  if (servers.length === 0) return null;

  return (
    <Panel labelledBy="community-claim">
      <PanelHead
        id="community-claim"
        title={
          <span className="inline-flex items-center gap-8">
            <ShieldQuestion size={16} className="text-fg-accent" aria-hidden="true" />
            {t("claim.title")}
          </span>
        }
      />
      <p className="text-body-sm text-fg-secondary">{t("claim.text")}</p>
      {servers.length > 1 ? (
        <div className="flex flex-col gap-6">
          <span className="text-body-sm-medium text-fg-secondary">{t("claim.server")}</span>
          <Select
            value={serverId}
            onChange={setServerId}
            ariaLabel={t("claim.server")}
            options={servers.map((server) => ({ value: server.id, label: `${serverName(server)} · ${server.address}` }))}
          />
        </div>
      ) : null}
      {!platform.signedIn ? (
        <div>
          <Button wrap icon={<LogIn size={16} />} onClick={platform.signIn}>
            {t("claim.signIn")}
          </Button>
        </div>
      ) : shown === null || shown.status === "rejected" ? (
        <div className="flex flex-wrap gap-8">
          <Button variant="primary" wrap icon={<KeyRound size={16} />} disabled={action.busy} onClick={() => void ask(false)}>
            {t("claim.getCode")}
          </Button>
          <Button wrap disabled={action.busy} onClick={() => void ask(true)}>
            {t("claim.manual")}
          </Button>
        </div>
      ) : shown.manual && shown.status === "pending" ? (
        <Notice tone="info">{t("claim.pendingManual")}</Notice>
      ) : shown.status === "pending" ? (
        <div className="flex flex-col gap-8 rounded-md border border-line bg-input p-12">
          <p className="text-body-sm text-fg-secondary">{t("claim.codeHint")}</p>
          <div className="flex min-w-0 items-center gap-8">
            <code className="min-w-0 flex-1 select-all text-mono-sm text-fg-accent [overflow-wrap:anywhere]">{shown.code}</code>
            <Button
              size="sm"
              icon={copied === shown.code ? <Check size={14} /> : <Copy size={14} />}
              aria-label={t("claim.copyCode")}
              title={t("claim.copyCode")}
              onClick={() => copy(shown.code)}
            />
          </div>
          <p className="text-body-sm text-fg-secondary">{t("claim.expires", { time: formatMoment(shown.expiresAt, i18n.language) })}</p>
          <div>
            <Button variant="primary" wrap disabled={action.busy} onClick={() => void verify(shown)}>
              {t("claim.verify")}
            </Button>
          </div>
        </div>
      ) : null}
      {shown?.status === "rejected" ? <Notice tone="danger">{t("claim.rejected")}</Notice> : null}
      {done ? <Notice tone="success">{t("claim.approved")}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Panel>
  );
}

import { Check, Copy, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { cn } from "../../../lib/format";
import { Badge, Button, Dialog, Input } from "../../ui";
import { failureOf } from "../api";
import { useCopy } from "../bits";
import { useFailureText } from "../errors";
import { formatMoment, GAME_NAMES, orderedServers, serverName } from "../format";
import { useCommunityApi, useCommunityPlatform } from "../platform";
import { useLiveStatuses } from "../ServerBlock";
import type { Community, CommunityClaim, CommunityServer, Game } from "../types";
import { useAction } from "../useRemote";
import type { ManageDraft } from "./model";
import { FieldNote, OrderButtons, Section, SectionNoticeLine, useProblemText, useSectionNotice } from "./parts";
import { addressProblem, LIMITS, type DraftProblems } from "./validate";

/** The steps of adding a server: its game, address and label, then its code. */
type Flow =
  | { step: "form"; game: Game; address: string; label: string; problem: string | null }
  | { step: "code"; server: CommunityServer; claim: CommunityClaim; problem: string | null; expired: boolean; done: boolean };

/**
 * **Servers**: the servers of the community in the order of the page, each
 * with its label, its address, what it says of itself now, its game and
 * whether it is verified; then **Add server**.
 *
 * Moving, adding, verifying and removing a server go to the service at once
 * through their own routes, and the screen takes the page they answer with.
 * The labels wait for **Save changes** with the rest of the form.
 *
 * Adding a server asks for its game, address and label. An organizer then
 * gets a code to put into `sv_hostname`, and **Verify** has the service read
 * it back; an administrator's server is verified at once.
 */
export function ServersSection({
  community,
  draft,
  problems,
  edit,
  onApplied,
}: {
  community: Community;
  draft: ManageDraft;
  problems: DraftProblems;
  edit: (patch: Partial<ManageDraft>) => void;
  onApplied: (community: Community) => void;
}) {
  const { t, i18n } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const problemText = useProblemText();
  const action = useAction();
  // Verifying has a lock of its own: the card says the service is reading the name, not that a row moves.
  const verifying = useAction();
  const [notice, setNotice] = useSectionNotice();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [removing, setRemoving] = useState<CommunityServer | null>(null);
  const admin = community.viewer?.isAdmin === true;
  const servers = orderedServers(community);
  const live = useLiveStatuses(servers);
  const full = servers.length >= LIMITS.servers;

  // A server that left the page takes its open steps with it.
  useEffect(() => {
    if (flow?.step === "code" && !community.servers.some((server) => server.id === flow.server.id)) setFlow(null);
  }, [community.servers, flow]);

  /** The sentence of a refusal of adding or verifying, in the screen's words where the service's are known. */
  const refusalText = (reason: unknown): string => {
    const { code, message } = failureOf(reason);
    if (code === "limit") return t("manage.servers.full");
    if (message.startsWith("This server is on the page already")) return t("manage.servers.onPage");
    if (message.startsWith("This server belongs to another community")) return t("manage.servers.taken");
    if (message.startsWith("Another community lists this server without proof")) return t("manage.servers.takenUnproven");
    if (message.startsWith("This address belongs to the JKNet relay")) return t("manage.servers.relay");
    if (message.startsWith("A public game-server IPv4 address")) return t("manage.servers.addressPrivate");
    if (message.startsWith("Add the exact verification code")) return t("manage.servers.codeMissing");
    if (message.startsWith("The verification code expired")) return t("manage.servers.codeExpired");
    if (message.startsWith("The response does not match the challenge")) return t("manage.servers.wrongGame");
    if (message.startsWith("This server is verified already")) return t("manage.servers.alreadyVerified");
    return failure(reason);
  };

  const move = (server: CommunityServer, to: number) =>
    action.run(
      async () => {
        setNotice(null);
        onApplied(await api.updateServer(community.id, server.id, { position: to }));
      },
      (reason) => setNotice({ tone: "danger", text: failure(reason) }),
    );

  const remove = (server: CommunityServer) =>
    action.run(
      async () => {
        setNotice(null);
        onApplied(await api.removeServer(community.id, server.id));
        setRemoving(null);
        setNotice({ tone: "success", text: t("manage.servers.removed", { name: serverName(server) }) });
      },
      (reason) => {
        setRemoving(null);
        setNotice({ tone: "danger", text: failure(reason) });
      },
    );

  const add = () => {
    if (flow?.step !== "form") return;
    const problem = addressProblem(flow.address);
    if (problem !== null) {
      setFlow({
        ...flow,
        problem:
          problem === "shape" ? t("manage.servers.addressShape") : problem === "port" ? t("manage.servers.addressPort") : t("manage.servers.addressPrivate"),
      });
      return;
    }
    const label = flow.label.trim();
    if (label.length > LIMITS.label) {
      setFlow({ ...flow, problem: problemText("tooLong", { max: LIMITS.label }) });
      return;
    }
    void action.run(
      async () => {
        setNotice(null);
        const added = await api.addServer(community.id, { game: flow.game, address: flow.address.trim(), ...(label !== "" ? { label } : {}) });
        onApplied(added.community);
        if (added.claim) {
          setFlow({ step: "code", server: added.server, claim: added.claim, problem: null, expired: false, done: false });
        } else {
          setFlow(null);
          setNotice({ tone: "success", text: t("manage.servers.addedDirect", { name: serverName(added.server) }) });
        }
      },
      (reason) => setFlow((current) => (current?.step === "form" ? { ...current, problem: refusalText(reason) } : current)),
    );
  };

  /** The code of a server waiting for one: the open claim of this account, or a new one. */
  const resume = (server: CommunityServer) =>
    action.run(
      async () => {
        setNotice(null);
        const now = new Date().toISOString();
        let claim: CommunityClaim | undefined;
        try {
          const me = await api.me();
          claim = me.serverClaims.find(
            (item) => item.serverId === server.id && item.status === "pending" && !item.manual && item.expiresAt > now,
          );
        } catch {
          claim = undefined;
        }
        claim ??= await api.claim(server.id, false);
        setFlow({ step: "code", server, claim, problem: null, expired: false, done: false });
      },
      (reason) => setNotice({ tone: "danger", text: refusalText(reason) }),
    );

  const newCode = () => {
    if (flow?.step !== "code") return;
    const server = flow.server;
    void verifying.run(
      async () => {
        const claim = await api.claim(server.id, false);
        setFlow({ step: "code", server, claim, problem: null, expired: false, done: false });
      },
      (reason) => setFlow((current) => (current?.step === "code" ? { ...current, problem: refusalText(reason) } : current)),
    );
  };

  const verify = () => {
    if (flow?.step !== "code") return;
    const claim = flow.claim;
    void verifying.run(
      async () => {
        const verified = await api.verify(claim.id);
        const { game: _game, address: _address, ...page } = verified;
        if (page.id === community.id) onApplied(page);
        setFlow((current) => (current?.step === "code" ? { ...current, problem: null, done: true } : current));
      },
      (reason) => {
        const text = refusalText(reason);
        const expired = failureOf(reason).message.startsWith("The verification code expired");
        setFlow((current) => (current?.step === "code" ? { ...current, problem: text, expired } : current));
      },
    );
  };

  return (
    <Section
      section="servers"
      title={t("manage.sections.servers")}
      count={t("manage.servers.count", { count: servers.length, max: LIMITS.servers })}
      lead={t("manage.servers.lead")}
    >
      <div className="flex min-w-0 flex-col gap-8">
        {servers.map((server, index) => {
          const view = live[server.id];
          const status = view?.status ?? null;
          const label = draft.labels[server.id] ?? server.label;
          const problem = problems.labels[server.id];
          const name = serverName(server);
          const last = servers.length <= 1 && !admin;
          const sub = !server.verified
            ? null
            : status
              ? t("manage.servers.liveSub", { map: status.map, players: status.players, max: status.maxPlayers })
              : view?.state === "off"
                ? t("manage.servers.offSub")
                : server.verifiedAt
                  ? t("manage.servers.verifiedSub", { date: formatMoment(server.verifiedAt, i18n.language) })
                  : null;
          const coding = flow?.step === "code" && flow.server.id === server.id;
          return (
            <div key={server.id} className="flex min-w-0 flex-col gap-6">
              {/* The arrows, the label and the remove button keep their places; what the
                  server is — address, game, verification, its line now — wraps in the
                  middle column, and under the label in a narrow column. */}
              <div className="grid min-h-52 min-w-0 grid-cols-[auto_168px_minmax(0,1fr)_auto] items-center gap-x-12 gap-y-8 rounded-md border border-line-subtle bg-input py-8 pr-8 pl-6 @max-[640px]/community:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className="@max-[640px]/community:row-span-2 @max-[640px]/community:self-start">
                  <OrderButtons
                    upLabel={t("manage.servers.up", { name })}
                    downLabel={t("manage.servers.down", { name })}
                    first={index === 0}
                    last={index === servers.length - 1}
                    disabled={action.busy}
                    onMove={(by) => void move(server, index + by)}
                  />
                </span>
                <Input
                  aria-label={t("manage.servers.label", { address: server.address })}
                  placeholder={t("manage.servers.labelPlaceholder")}
                  maxLength={LIMITS.label}
                  value={label}
                  invalid={problem !== undefined}
                  onChange={(event) => edit({ labels: { ...draft.labels, [server.id]: event.target.value } })}
                />
                <div className="flex min-w-0 flex-col gap-4 @max-[640px]/community:col-span-2 @max-[640px]/community:col-start-2 @max-[640px]/community:row-start-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-4">
                    <span className="min-w-0 truncate text-mono-sm text-fg" title={server.address}>
                      {server.address}
                    </span>
                    <Badge title={GAME_NAMES[server.game]}>{server.game === "jo" ? "JO" : "JA"}</Badge>
                    {server.verified ? (
                      <Badge tone="success" icon={<ShieldCheck size={12} />}>
                        {t("manage.servers.verified")}
                      </Badge>
                    ) : (
                      <Badge tone="warm">{t("manage.servers.pending")}</Badge>
                    )}
                  </span>
                  {sub ? <span className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">{sub}</span> : null}
                  {!server.verified && !coding ? (
                    <span>
                      <Button size="sm" wrap disabled={action.busy} onClick={() => void resume(server)}>
                        {t("manage.servers.confirm")}
                      </Button>
                    </span>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  icon={<Trash2 size={16} />}
                  aria-label={t("manage.servers.remove", { name })}
                  title={last ? t("manage.servers.removeLast") : t("manage.servers.remove", { name })}
                  disabled={last || action.busy}
                  className="@max-[640px]/community:col-start-3 @max-[640px]/community:row-start-1"
                  onClick={() => setRemoving(server)}
                />
              </div>
              {problem ? <FieldNote tone="bad">{problemText(problem, { max: LIMITS.label })}</FieldNote> : null}
            </div>
          );
        })}
        {servers.length === 0 ? <p className="text-body-sm text-fg-secondary">{t("manage.servers.none")}</p> : null}
      </div>

      {flow === null ? (
        <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
          <Button
            size="sm"
            wrap
            icon={<Plus size={14} />}
            disabled={full || action.busy}
            onClick={() => {
              setNotice(null);
              setFlow({ step: "form", game: community.games[0] ?? platform.game ?? "ja", address: "", label: "", problem: null });
            }}
          >
            {t("manage.servers.add")}
          </Button>
          <span className="text-body-sm text-fg-secondary">{full ? t("manage.servers.full") : t("manage.servers.addHint")}</span>
        </div>
      ) : flow.step === "form" ? (
        <AddForm flow={flow} admin={admin} busy={action.busy} onChange={(next) => setFlow(next)} onSubmit={add} onCancel={() => setFlow(null)} />
      ) : (
        <CodeCard
          flow={flow}
          community={community}
          hostname={live[flow.server.id]?.status?.hostnameRaw ?? null}
          busy={verifying.busy}
          onVerify={verify}
          onNewCode={newCode}
          onClose={() => setFlow(null)}
        />
      )}

      <SectionNoticeLine notice={notice} />

      {removing ? (
        <Dialog
          title={t("manage.servers.removeTitle", { name: serverName(removing) })}
          body={removing.verified ? t("manage.servers.removeText", { address: removing.address }) : t("manage.servers.removeTextPending", { address: removing.address })}
          variant="danger"
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button variant="ghost" wrap disabled={action.busy} onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" wrap disabled={action.busy} onClick={() => void remove(removing)}>
                {t("manage.servers.removeConfirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </Section>
  );
}

/** Step one of a new server: the game, the address and the label. */
function AddForm({
  flow,
  admin,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  flow: Extract<Flow, { step: "form" }>;
  admin: boolean;
  busy: boolean;
  onChange: (flow: Flow) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("community");
  const id = useId();
  return (
    <form
      className="flex min-w-0 flex-col gap-16 rounded-lg border border-line-strong bg-app p-16"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-center gap-12">
        <h3 id={`${id}-title`} className="min-w-0 flex-1 text-heading-sm text-fg">
          {t("manage.servers.newTitle")}
        </h3>
        <Button size="sm" variant="ghost" icon={<X size={16} />} aria-label={t("manage.servers.close")} title={t("manage.servers.close")} onClick={onCancel} />
      </div>
      <div className="grid grid-cols-[minmax(0,240px)_minmax(0,1fr)_minmax(0,1fr)] items-start gap-12 @max-[880px]/community:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-6">
          <span id={`${id}-game`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.servers.game")}
          </span>
          <div role="radiogroup" aria-labelledby={`${id}-game`} className="flex h-36 items-center gap-2 rounded-md border border-line bg-input p-2 pointer-coarse:h-44">
            {(["ja", "jo"] as const).map((game) => (
              <button
                key={game}
                type="button"
                role="radio"
                aria-checked={flow.game === game}
                onClick={() => onChange({ ...flow, game })}
                className={cn(
                  "h-full min-w-0 flex-1 cursor-pointer truncate rounded-sm px-8 text-body-sm-medium select-none",
                  flow.game === game ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
                )}
              >
                {GAME_NAMES[game]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <label htmlFor={`${id}-address`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.servers.address")}
          </label>
          <Input
            id={`${id}-address`}
            autoFocus
            inputMode="decimal"
            spellCheck={false}
            placeholder={t("manage.servers.addressPlaceholder")}
            value={flow.address}
            invalid={flow.problem !== null}
            aria-describedby={`${id}-hint`}
            onChange={(event) => onChange({ ...flow, address: event.target.value, problem: null })}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <label htmlFor={`${id}-label`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.servers.labelField")}
          </label>
          <Input
            id={`${id}-label`}
            maxLength={LIMITS.label}
            placeholder={t("manage.servers.labelFieldPlaceholder")}
            value={flow.label}
            onChange={(event) => onChange({ ...flow, label: event.target.value })}
          />
        </div>
      </div>
      {flow.problem ? (
        <p role="alert" className="text-body-sm text-fg-danger [overflow-wrap:anywhere]">
          {flow.problem}
        </p>
      ) : null}
      <p id={`${id}-hint`} className="text-body-sm text-fg-secondary">
        {admin ? `${t("manage.servers.addressHint")} ${t("manage.servers.adminNote")}` : t("manage.servers.addressHint")}
      </p>
      <div className="flex flex-wrap items-center gap-8">
        {admin ? (
          <Button type="submit" variant="primary" wrap icon={<ShieldCheck size={16} />} disabled={busy || flow.address.trim() === ""}>
            {t("manage.servers.addDirect")}
          </Button>
        ) : (
          <Button type="submit" variant="primary" wrap disabled={busy || flow.address.trim() === ""}>
            {t("manage.servers.getCode")}
          </Button>
        )}
        <Button variant="ghost" wrap onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Step two: the code for `sv_hostname`, **Verify**, and what came of it. */
function CodeCard({
  flow,
  community,
  hostname,
  busy,
  onVerify,
  onNewCode,
  onClose,
}: {
  flow: Extract<Flow, { step: "code" }>;
  community: Community;
  /** What the server calls itself now, when the host asked it. */
  hostname: string | null;
  busy: boolean;
  onVerify: () => void;
  onNewCode: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("community");
  const { copied, copy } = useCopy();
  const id = useId();
  const code = flow.claim.code;
  const example = `${hostname && hostname.trim() !== "" ? hostname.trim() : community.name} ${code}`;
  const name = serverName(flow.server);
  const codeClass = "rounded-xs bg-elevated px-6 py-1 text-mono-xs text-fg [overflow-wrap:anywhere]";
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-16 rounded-lg border border-line-strong bg-app p-16">
      <div className="flex flex-wrap items-center gap-12">
        <h3 id={`${id}-title`} className="min-w-0 flex-1 text-heading-sm text-fg [overflow-wrap:anywhere]">
          {t("manage.servers.verifyTitle", { name })}
        </h3>
        {flow.done ? (
          <Badge tone="success" icon={<ShieldCheck size={12} />}>
            {t("manage.servers.verified")}
          </Badge>
        ) : busy ? (
          <Badge>{t("manage.servers.checkingShort")}</Badge>
        ) : (
          <Badge tone="warm">{t("manage.servers.pending")}</Badge>
        )}
      </div>
      {!flow.done ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-12">
            <code className="min-w-0 rounded-sm border border-line-strong bg-input px-12 py-6 text-mono-sm tracking-[0.04em] text-fg-accent select-all [overflow-wrap:anywhere]">
              {code}
            </code>
            <Button size="sm" wrap icon={copied === code ? <Check size={14} /> : <Copy size={14} />} onClick={() => copy(code)}>
              {copied === code ? t("manage.servers.copied") : t("manage.servers.copyCode")}
            </Button>
            <span className="text-body-sm text-fg-secondary">{t("manage.servers.expires", { time: formatMoment(flow.claim.expiresAt, i18n.language) })}</span>
          </div>
          <ol className="flex flex-col gap-8">
            {[
              <Trans key="1" t={t} i18nKey="manage.servers.step1" values={{ example }} components={[<code className={codeClass} />, <code className={codeClass} />]} />,
              <Trans key="2" t={t} i18nKey="manage.servers.step2" components={[<b className="font-semibold text-fg" />]} />,
              <span key="3">{t("manage.servers.step3")}</span>,
            ].map((text, index) => (
              <li key={index} className="flex items-start gap-10 text-body-sm text-fg-secondary">
                <span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-elevated text-label-xs text-fg" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="min-w-0 pt-1">{text}</span>
              </li>
            ))}
          </ol>
          {flow.problem ? (
            <p role="alert" className="text-body-sm text-fg-danger [overflow-wrap:anywhere]">
              {flow.problem}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-8">
            {flow.expired ? (
              <Button variant="primary" wrap icon={<RefreshCw size={16} />} disabled={busy} onClick={onNewCode}>
                {t("manage.servers.newCode")}
              </Button>
            ) : (
              <Button variant="primary" wrap icon={<RefreshCw size={16} className={cn(busy && "animate-spin motion-reduce:animate-none")} />} disabled={busy} onClick={onVerify}>
                {busy ? t("manage.servers.checking") : t("manage.servers.verify")}
              </Button>
            )}
            <Button variant="ghost" wrap disabled={busy} onClick={onClose}>
              {t("manage.servers.later")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p role="status" className="flex items-start gap-10 rounded-md border border-success bg-success-subtle px-12 py-8 text-body-sm text-fg">
            <Check size={16} className="mt-1 shrink-0 text-fg-success" aria-hidden="true" />
            {t("manage.servers.done")}
          </p>
          <div>
            <Button wrap onClick={onClose}>
              {t("manage.servers.finish")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

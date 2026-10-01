/**
 * The page of an event, as the design's C1 draws it: the cover, the kind
 * and the countdown, the title and the community; **Add to calendar** and
 * **Share**; when and where in the reader's time zone and the organizer's;
 * the description; and on the right the organizer's tools, the answer with
 * its counts and places, and the requirements with **Prepare client** and
 * **Join** where the host can install and start the game.
 *
 * Organizers — the owner, the editors, the administrators of JKNet — also
 * see who answered, **Edit**, **Repeat in a week** and **Cancel event**,
 * which asks first. A cancelled event says so on top and keeps its page;
 * an organizer may bring it back until it starts.
 */

import {
  ArrowLeft,
  Ban,
  CalendarPlus,
  ChevronRight,
  Clock,
  ExternalLink,
  Layers,
  Link2,
  Map as MapIcon,
  Package,
  Pencil,
  Repeat,
  SearchX,
  Share2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Avatar, Badge, Button, Dialog, EmptyState } from "../ui";
import { isNotFound } from "../community/api";
import { CopyButton, Failure, LiveDot, Notice, Panel, PanelHead, useCopy } from "../community/bits";
import { CommunityMarkdown } from "../community/CommunityMarkdown";
import { useCommunityPlatform } from "../community/platform";
import { useLiveStatuses } from "../community/ServerBlock";
import { jkhubPage } from "../community/SideCards";
import type { CommunityServer } from "../community/types";
import { useAction, useRemote } from "../community/useRemote";
import { CommunityChip, EventCover, EventLink, KindBadge, RsvpControl, useEventFailureText, useNow } from "./bits";
import { isDeclined } from "./declined";
import { downloadText } from "./download";
import { FriendsGoing, usePlaceText } from "./EventItems";
import { useEventFormat } from "./format";
import { answersOpen, eventPhase, icsFileName, icsText, isFull, isTimeZone, offsetMinutes } from "./logic";
import { useEventsApi, useEventsPlatform } from "./platform";
import type { EventAttendee, EventDetails, RsvpStatus } from "./types";
import { useAnswer } from "./useAnswer";

/** The server an event is on, as the community screens' live status reads it. */
function serverOf(event: EventDetails): CommunityServer | null {
  if (event.address === null) return null;
  return {
    id: `event-${event.id}`,
    game: event.game,
    address: event.address,
    label: event.server?.label ?? "",
    position: 0,
    verified: true,
    verifiedAt: null,
  };
}

export function EventView({ id }: { id: string }) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const events = useEventsPlatform();
  const api = useEventsApi();
  const failure = useEventFailureText();
  const format = useEventFormat();
  const now = useNow(15_000);
  const account = platform.signedIn ? platform.accountId ?? "account" : "guest";

  const page = useRemote(`event:${id}:${account}`, () => api.get(id));
  const event = page.data;
  const viewer = event?.viewer ?? null;
  const organizer = platform.canManage && viewer !== null && (Boolean(viewer.role) || viewer.isAdmin === true);
  const attendees = useRemote(event && organizer ? `attendees:${id}:${event.counts.going}:${event.counts.maybe}` : null, () => api.attendees(id));
  const server = event ? serverOf(event) : null;
  const live = useLiveStatuses(server ? [server] : []);
  const liveView = server ? live[server.id] : undefined;

  const change = useAction();
  const [notice, setNotice] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const { copied, failed, copy } = useCopy();
  const placeText = usePlaceText();
  const { busyId, error: answerError, answer } = useAnswer((next) => page.set((current) => (current ? { ...current, ...next } : current)));

  useEffect(() => {
    setNotice(null);
    setConfirm(false);
  }, [id]);

  const back = (
    <EventLink
      route={{ view: "calendar" }}
      className="-ml-6 flex w-fit min-h-28 items-center gap-6 rounded-sm py-4 pr-10 pl-6 text-body-sm-medium text-fg-secondary hover:bg-hover-overlay hover:text-fg"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t("page.back")}
    </EventLink>
  );

  if (!event) {
    return (
      <div className="flex flex-col gap-16">
        {platform.embedded ? null : back}
        {page.error ? (
          isNotFound(page.error) ? (
            <EmptyState
              icon={<SearchX size={24} />}
              title={t("page.notFoundTitle")}
              text={t("page.notFound")}
              action={
                <Button wrap onClick={() => events.navigate({ view: "calendar" })}>
                  {t("page.back")}
                </Button>
              }
            />
          ) : (
            <Failure error={page.error} onRetry={page.reload} />
          )
        ) : (
          <p role="status" className="text-body-sm text-fg-muted">
            {t("common.loading")}
          </p>
        )}
      </div>
    );
  }

  const start = Date.parse(event.startsAt);
  const end = Date.parse(event.endsAt);
  const phase = eventPhase(event, now);
  const cancelled = phase === "cancelled";
  const answered = event.counts.going + event.counts.maybe;
  const place = placeText(event);
  const url = events.eventUrl(event.id);
  // The organizer's clock, only where it shows another time than the reader's.
  const organizerZone =
    event.timezone && isTimeZone(event.timezone) && offsetMinutes(start, event.timezone) !== offsetMinutes(start, format.zone) ? event.timezone : null;

  const setStatus = (status: "scheduled" | "cancelled") =>
    change.run(
      async () => {
        setNotice(null);
        const next = await api.update(event.id, { status, revision: event.revision });
        page.set(next);
        events.onChanged?.();
        setNotice({
          tone: status === "cancelled" ? "info" : "success",
          text:
            status === "cancelled"
              ? answered > 0
                ? t("organizer.cancelledNotice", { count: answered })
                : t("organizer.cancelledNoticeNone")
              : t("organizer.restoredNotice"),
        });
      },
      (reason) => setNotice({ tone: "danger", text: failure(reason) }),
    );

  const saveIcs = () =>
    change.run(
      async () => {
        setNotice(null);
        const text = icsText(event, {
          now: Date.now(),
          url,
          location: event.address === null ? t("place.offline") : place,
          description: [event.community.name, place, url].join("\n"),
        });
        const name = icsFileName(event);
        if (events.saveIcs) {
          const saved = await events.saveIcs(name, text);
          if (saved !== null) setNotice({ tone: "success", text: t("page.icsSaved", { file: saved }) });
        } else {
          downloadText(name, text);
          setNotice({ tone: "success", text: t("page.icsDownloaded", { file: name }) });
        }
      },
      (reason) => setNotice({ tone: "danger", text: t("page.icsFailed", { message: failure(reason) }) }),
    );

  const statusLine =
    phase === "cancelled"
      ? { tone: "text-fg-danger", text: t("page.cancelled") }
      : phase === "live"
        ? { tone: "text-fg-accent", text: t("page.liveUntil", { time: format.time(end) }) }
        : phase === "ended"
          ? { tone: "text-fg-secondary", text: t("page.ended") }
          : { tone: "text-fg-warm", text: t("page.startsIn", { time: format.duration(start - now) }) };

  const instructions =
    event.instructions.trim() !== "" ? (
      <div className="flex flex-col gap-4">
        <span className="text-label-xs text-fg-muted">{t("requirements.instructions")}</span>
        <CommunityMarkdown className="jkc-md-rules" text={event.instructions} />
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-16">
      {platform.embedded ? null : (
        <nav aria-label={t("page.path")} className="flex min-h-28 min-w-0 items-center gap-4 text-body-sm-medium text-fg-secondary">
          {back}
          <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-fg-disabled" />
          <span aria-current="page" className="min-w-0 truncate text-fg">
            {event.title}
          </span>
        </nav>
      )}

      {cancelled ? (
        <div role="status" className="flex flex-wrap items-center gap-12 rounded-md border border-line-danger bg-danger-subtle px-12 py-8">
          <Ban size={16} aria-hidden="true" className="shrink-0 text-fg-danger" />
          <span className="min-w-0 flex-1 text-body-sm text-fg">
            <strong className="font-semibold">{t("page.cancelledTitle")}</strong> {answered > 0 ? t("page.cancelledText", { count: answered }) : t("page.cancelledTextNone")}
          </span>
          {organizer && now < start ? (
            <Button size="sm" wrap disabled={change.busy} onClick={() => void setStatus("scheduled")}>
              {t("organizer.restore")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <EventCover event={event} dim={cancelled} className="h-168 rounded-lg border border-line" />

      <div className="flex flex-wrap items-end gap-x-24 gap-y-16">
        <div className="flex min-w-0 flex-1 basis-[420px] flex-col gap-8">
          <div className="flex flex-wrap items-center gap-8">
            <KindBadge kind={event.kind} />
            {phase === "upcoming" ? (
              <Badge tone="warm" icon={<Clock size={12} aria-hidden="true" />}>
                {t("page.countdown", { time: format.duration(start - now) })}
              </Badge>
            ) : null}
            {phase === "live" ? (
              <Badge tone="accent" icon={<LiveDot state="live" pulse />}>
                {t("page.live")}
              </Badge>
            ) : null}
            {phase === "ended" ? <Badge>{t("page.ended")}</Badge> : null}
            {cancelled ? <Badge tone="danger">{t("card.cancelled")}</Badge> : null}
          </div>
          <h1 className={cn("text-display-lg [overflow-wrap:anywhere]", cancelled ? "text-fg-secondary line-through decoration-2" : "text-fg")}>{event.title}</h1>
          <div className="flex flex-wrap items-center gap-8">
            <CommunityChip community={event.community} />
            {event.createdBy ? <span className="text-body-sm text-fg-secondary">{t("page.createdBy", { name: event.createdBy.displayName })}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-8">
          <Button wrap icon={<CalendarPlus size={16} />} disabled={change.busy} onClick={() => void saveIcs()}>
            {t("page.ics")}
          </Button>
          <div className="relative">
            <Button wrap icon={<Share2 size={16} />} aria-expanded={shareOpen} onClick={() => setShareOpen((value) => !value)}>
              {t("page.share")}
            </Button>
            {shareOpen ? (
              <div className="absolute top-[calc(100%+4px)] right-0 z-20 flex min-w-[240px] flex-col rounded-md border border-line-strong bg-elevated p-4 shadow-popover">
                <button
                  type="button"
                  className="flex min-h-32 cursor-pointer items-center gap-8 rounded-sm px-8 text-left text-body-sm text-fg select-none hover:bg-hover-overlay pointer-coarse:min-h-44"
                  onClick={() => {
                    copy(url);
                    setShareOpen(false);
                  }}
                >
                  <Link2 size={14} aria-hidden="true" />
                  {t("page.copyLink")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {copied === url ? <Notice tone="success">{t("page.linkCopied")}</Notice> : null}
      {failed === url ? <Notice tone="danger">{t("page.linkNotCopied", { url })}</Notice> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-24 @max-[960px]/community:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-16">
          <section aria-label={t("page.whenWhere")} className="grid grid-cols-2 rounded-lg border border-line bg-surface @max-[640px]/community:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-4 p-16">
              <span className="text-label-xs text-fg-muted">{t("page.when")}</span>
              <p className="pt-4 text-heading-md text-fg [overflow-wrap:anywhere]">{format.range(event.startsAt, event.endsAt)}</p>
              <p className="text-body-sm text-fg-secondary">{t("page.yourTime", { zone: format.zone, offset: format.offset(start) })}</p>
              {organizerZone ? (
                <p className="text-body-sm text-fg-secondary">
                  {t("page.organizerTime", { time: format.time(start, organizerZone), zone: organizerZone, offset: format.offset(start, organizerZone) })}
                </p>
              ) : null}
              <p className={cn("flex items-center gap-6 pt-8 text-body-sm-medium", statusLine.tone)}>
                {phase === "live" ? <LiveDot state="live" /> : phase === "cancelled" ? <Ban size={14} aria-hidden="true" /> : <Clock size={14} aria-hidden="true" />}
                {statusLine.text}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-4 border-l border-line-subtle p-16 @max-[640px]/community:border-t @max-[640px]/community:border-l-0">
              <span className="text-label-xs text-fg-muted">{t("page.where")}</span>
              {event.address === null ? (
                <>
                  <p className="pt-4 text-heading-md text-fg">{t("place.offline")}</p>
                  <p className="text-body-sm text-fg-secondary">{t("page.offlineNote")}</p>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-8 pt-4 text-heading-md text-fg [overflow-wrap:anywhere]">
                    {liveView ? (
                      <LiveDot
                        state={liveView.state}
                        label={liveView.state === "live" ? t("page.serverOnline") : liveView.state === "off" ? t("page.serverOffline") : t("page.serverUnknown")}
                      />
                    ) : null}
                    {event.server ? t("place.server", { name: event.server.label.trim() !== "" ? event.server.label : event.server.address }) : t("place.ownAddress")}
                  </p>
                  <div className="flex min-h-28 items-center gap-4">
                    <span className="text-mono-sm text-fg">{event.address}</span>
                    <CopyButton text={event.address} />
                  </div>
                  {liveView?.status ? (
                    <p className="flex flex-wrap items-center gap-6 text-body-sm text-fg-secondary">
                      <MapIcon size={14} aria-hidden="true" className="text-fg-muted" />
                      <span className="text-mono-xs text-fg">{liveView.status.map}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t("page.playersNow", { players: liveView.status.players, max: liveView.status.maxPlayers })}</span>
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </section>

          <Panel labelledBy="event-description">
            <PanelHead id="event-description" title={t("page.description")} />
            {event.description.trim() !== "" ? (
              <CommunityMarkdown text={event.description} />
            ) : (
              <p className="text-body-sm text-fg-secondary">{t("page.noDescription")}</p>
            )}
          </Panel>

          {organizer ? (
            <Attendees
              going={attendees.data?.going ?? []}
              maybe={attendees.data?.maybe ?? []}
              counts={event.counts}
              friendIds={new Set((viewer?.friendsGoing ?? []).map((friend) => friend.id))}
              me={platform.accountId}
              loading={attendees.loading && !attendees.data}
              error={attendees.error}
              onRetry={attendees.reload}
            />
          ) : null}
        </div>

        <aside aria-label={t("page.participation")} className="flex min-w-0 flex-col gap-16">
          {organizer ? (
            <Panel labelledBy="event-organizer">
              <PanelHead
                id="event-organizer"
                title={t("organizer.title")}
                end={<Badge tone="accent">{viewer?.isAdmin && !viewer.role ? t("organizer.admin") : t(`organizer.${viewer?.role === "owner" ? "owner" : "editor"}`)}</Badge>}
              />
              <p className="text-body-sm text-fg-secondary">
                {cancelled ? t("organizer.textCancelled") : answered > 0 ? t("organizer.text", { count: answered }) : t("organizer.textNone")}
              </p>
              <div className="flex flex-wrap gap-8">
                <Button size="sm" wrap icon={<Pencil size={14} />} onClick={() => events.navigate({ view: "edit", id: event.id })}>
                  {t("organizer.edit")}
                </Button>
                <Button size="sm" wrap icon={<Repeat size={14} />} onClick={() => events.navigate({ view: "new", communityId: event.communityId, copyOf: event.id })}>
                  {t("organizer.repeat")}
                </Button>
                {!cancelled && phase !== "ended" ? (
                  <Button size="sm" variant="ghost" wrap icon={<Ban size={14} className="text-fg-danger" />} disabled={change.busy} onClick={() => setConfirm(true)}>
                    <span className="text-fg-danger">{t("organizer.cancel")}</span>
                  </Button>
                ) : null}
              </div>
            </Panel>
          ) : null}

          <Panel labelledBy="event-answer">
            <PanelHead
              id="event-answer"
              title={t("rsvp.title")}
              end={
                <span className="text-body-sm text-fg-secondary">
                  {event.capacity !== null
                    ? t("rsvp.countsPlaces", { going: event.counts.going, count: event.capacity, maybe: event.counts.maybe })
                    : t("rsvp.counts", { going: event.counts.going, maybe: event.counts.maybe })}
                </span>
              }
            />
            {event.capacity !== null ? (
              <div
                role="img"
                aria-label={t("rsvp.capacityAria", { going: event.counts.going, count: event.capacity })}
                className="h-4 overflow-hidden rounded-full bg-elevated"
              >
                <span className="block h-full rounded-full bg-warm" style={{ width: `${Math.min(100, (event.counts.going / event.capacity) * 100)}%` }} />
              </div>
            ) : null}
            {platform.signedIn ? (
              <>
                <RsvpControl
                  event={event}
                  busy={busyId === event.id}
                  disabled={!answersOpen(event, now)}
                  onAnswer={(value: RsvpStatus | null) => answer(event, value)}
                />
                <p aria-live="polite" className={cn("text-body-sm", viewer?.rsvp === "going" && answersOpen(event, now) ? "text-fg-warm" : "text-fg-secondary")}>
                  {cancelled
                    ? t("rsvp.closedCancelled")
                    : phase === "ended"
                      ? t("rsvp.closedOver")
                      : isFull(event) && viewer?.rsvp !== "going"
                        ? t("rsvp.fullNote")
                        : t(`rsvp.note.${viewer?.rsvp ?? (isDeclined(event.id) ? "no" : "none")}`)}
                </p>
                {answerError?.id === event.id ? (
                  <p role="alert" className="text-body-sm text-fg-danger">
                    {answerError.text}
                  </p>
                ) : null}
                {(viewer?.friendsGoing.length ?? 0) > 0 ? (
                  <div className="flex items-center gap-10 border-t border-line-subtle pt-12">
                    <span className="flex">
                      {(viewer?.friendsGoing ?? []).slice(0, 4).map((friend, index) => (
                        <span key={friend.id} className={cn("rounded-full shadow-[0_0_0_2px_var(--color-bg-surface)]", index > 0 && "-ml-6")}>
                          <Avatar name={friend.displayName} src={friend.avatarUrl} size="sm" />
                        </span>
                      ))}
                    </span>
                    <FriendsGoing event={event} />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex flex-col items-start gap-12 rounded-md border border-dashed border-line-strong p-12">
                <p className="text-body-sm text-fg-secondary">{t("rsvp.signInText")}</p>
                <Button size="sm" variant="primary" wrap onClick={platform.signIn}>
                  {t("common.signIn")}
                </Button>
              </div>
            )}
          </Panel>

          <Panel labelledBy="event-requirements">
            <PanelHead id="event-requirements" title={t("requirements.title")} />
            {events.renderRequirements ? (
              events.renderRequirements({ event, now, instructions })
            ) : (
              <RequirementsList event={event} instructions={instructions} />
            )}
          </Panel>
        </aside>
      </div>

      {confirm ? (
        <Dialog
          variant="danger"
          title={t("organizer.confirmTitle")}
          body={answered > 0 ? t("organizer.confirmText", { title: event.title, count: answered }) : t("organizer.confirmTextNone", { title: event.title })}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button variant="ghost" wrap onClick={() => setConfirm(false)}>
                {t("organizer.confirmKeep")}
              </Button>
              <Button
                variant="danger"
                wrap
                disabled={change.busy}
                onClick={() => {
                  setConfirm(false);
                  void setStatus("cancelled");
                }}
              >
                {t("organizer.cancel")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The requirements where nothing can be installed: each file with a link to
 * JKHub, the bundle, what to do before the event and the host's note on
 * where the game is prepared.
 */
export function RequirementsList({ event, instructions }: { event: EventDetails; instructions: ReactNode }) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const { files, bundle } = event.requirements;
  return (
    <div className="flex flex-col gap-12">
      {files.length === 0 && bundle === null ? <p className="text-body-sm text-fg-secondary">{t("requirements.none")}</p> : null}
      {files.length > 0 || bundle ? (
        <ul className="flex flex-col gap-8">
          {files.map((file) => (
            <li key={file.jkhubId} className="flex min-h-48 min-w-0 items-center gap-10 rounded-md border border-line-subtle bg-input py-6 pr-8 pl-12">
              <Package size={16} aria-hidden="true" className="shrink-0 text-fg-secondary" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-sm-medium text-fg" title={file.title}>
                  {file.title}
                </span>
                <span className="text-body-sm text-fg-secondary">{t("requirements.file", { id: file.jkhubId })}</span>
              </span>
              <a
                href={jkhubPage(file.jkhubId)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(click) => {
                  click.preventDefault();
                  platform.openExternal(jkhubPage(file.jkhubId));
                }}
                aria-label={t("requirements.viewOf", { title: file.title })}
                title={t("requirements.view")}
                className="inline-flex size-28 shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg pointer-coarse:size-44"
              >
                <ExternalLink size={14} />
              </a>
            </li>
          ))}
          {bundle ? <BundleLine bundle={bundle} /> : null}
        </ul>
      ) : null}
      {instructions}
      {platform.playNote ?? <p className="text-body-sm text-fg-secondary">{t("requirements.launcherNote")}</p>}
    </div>
  );
}

/** The bundle an event asks for, with the button that opens it where the host can. */
export function BundleLine({ bundle }: { bundle: { id: string; name: string } }) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  return (
    <li className="flex min-h-48 min-w-0 items-center gap-10 rounded-md border border-line-subtle bg-input py-6 pr-8 pl-12">
      <Layers size={16} aria-hidden="true" className="shrink-0 text-fg-purple" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body-sm-medium text-fg" title={bundle.name}>
          {t("requirements.bundle", { name: bundle.name })}
        </span>
        <span className="text-body-sm text-fg-secondary">{t("requirements.bundleNote")}</span>
      </span>
      {platform.openBundle ? (
        <Button size="sm" wrap onClick={() => platform.openBundle?.(bundle.id)}>
          {t("requirements.openBundle")}
        </Button>
      ) : null}
    </li>
  );
}

/** Who answered, for the organizers: **Going** and **Maybe**, friends and the reader marked. */
function Attendees({
  going,
  maybe,
  counts,
  friendIds,
  me,
  loading,
  error,
  onRetry,
}: {
  going: EventAttendee[];
  maybe: EventAttendee[];
  counts: { going: number; maybe: number };
  friendIds: Set<string>;
  me: string | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTranslation("events");
  const [tab, setTab] = useState<"going" | "maybe">("going");
  const list = tab === "going" ? going : maybe;
  return (
    <Panel labelledBy="event-attendees">
      <PanelHead id="event-attendees" title={t("attendees.title")} end={<span className="text-body-sm text-fg-secondary">{t("attendees.note")}</span>} />
      <div role="tablist" aria-label={t("attendees.tabs")} className="inline-flex w-fit gap-2 rounded-sm border border-line bg-input p-2">
        {(["going", "maybe"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex min-h-26 cursor-pointer items-center gap-6 rounded-xs px-10 py-2 text-body-sm-medium select-none pointer-coarse:min-h-44",
              tab === id ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
            )}
          >
            {t(`rsvp.${id}`)}
            <span className="text-mono-xs tabular-nums">{counts[id]}</span>
          </button>
        ))}
      </div>
      {error ? <Failure error={error} onRetry={onRetry} /> : null}
      {loading ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {t("common.loading")}
        </p>
      ) : list.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t("attendees.empty")}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-x-16 gap-y-4 @max-[760px]/community:grid-cols-2 @max-[480px]/community:grid-cols-1">
          {list.map((attendee) => (
            <li key={attendee.user.id} className="flex min-h-32 min-w-0 items-center gap-8">
              <Avatar name={attendee.user.displayName} src={attendee.user.avatarUrl} size="sm" />
              <span className="min-w-0 truncate text-body-sm-medium text-fg" title={attendee.user.displayName}>
                {attendee.user.displayName}
              </span>
              {friendIds.has(attendee.user.id) ? <Badge tone="accent">{t("attendees.friend")}</Badge> : null}
              {attendee.user.id === me ? <Badge>{t("attendees.you")}</Badge> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}


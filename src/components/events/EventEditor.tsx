/**
 * The editor of an event, as the design's E1 draws it, for the organizers
 * of a community: a new event, a change of one, or a copy of one a week
 * later.
 *
 * On the left the form — the title and the kind; the start, the duration or
 * an end of its own and the organizer's time zone, with the start as two
 * other zones read it; where it takes place; the description in Markdown
 * and what to do before; the JKHub files, the bundle and the places. On the
 * right the cover and the card as players will see it, and the toast the
 * followers will get. The form checks itself the way the service will and
 * names what to fix; a refusal of the service lands on its field.
 *
 * A change sends only the fields that differ: the service checks every
 * field it is sent again.
 */

import {
  ArrowLeft,
  Bold,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Heading2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List as ListIcon,
  ListOrdered,
  LoaderCircle,
  Package,
  Quote,
  Search,
  Server,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Badge, Button, Combobox, Input, Select } from "../ui";
import { communityApi, isNotFound } from "../community/api";
import { CommunityLogo, Failure, Notice } from "../community/bits";
import { CommunityMarkdown } from "../community/CommunityMarkdown";
import { GAME_NAMES, orderedServers, serverName } from "../community/format";
import { PictureDropZone, usePictureRefusalText, usePictureUpload } from "../community/pictureUpload";
import { useCommunityPlatform } from "../community/platform";
import type { Community, CommunityServer, Game } from "../community/types";
import { useRemote } from "../community/useRemote";
import { eventFailureKind, type EventFailureKind } from "./api";
import { EventCover, KindBadge, useEventFailureText, useKindName, useNow } from "./bits";
import { capitalize, noonOf, useEventFormat } from "./format";
import {
  addMonths,
  checkDraft,
  dayKey,
  DURATIONS,
  draftBody,
  draftOf,
  draftPatch,
  formatOffset,
  isTimeZone,
  MAX_DESCRIPTION,
  MAX_FILES,
  MAX_INSTRUCTIONS,
  MAX_TITLE,
  monthGrid,
  monthOf,
  offsetMinutes,
  timeZoneNames,
  zonedToInstant,
  type DraftField,
  type EventDraft,
  type Month,
} from "./logic";
import { useEventsApi, useEventsPlatform, type JkhubPick } from "./platform";
import { EVENT_KINDS, type EventDetails } from "./types";

/** What the editor edits: a new event of a community, maybe a copy, or an event. */
export type EditorTarget = { mode: "new"; communityId: string; copyOf?: string } | { mode: "edit"; id: string };

/** Zones the helper line reads the start in, the first two that differ from the organizer's. */
const SAMPLE_ZONES = ["Europe/Moscow", "Europe/Berlin", "America/New_York", "Europe/London", "Asia/Tokyo", "UTC"];

/** The servers an event may be on: the ones everyone sees. */
function publicServers(community: Community): CommunityServer[] {
  return orderedServers(community).filter((server) => server.verified || (community.ownerId === null && server.id === community.id));
}

/** The servers the form offers: the ones everyone sees, and the server of the event it starts from. */
function serverChoices(community: Community, event: EventDetails | null): CommunityServer[] {
  const list = publicServers(community);
  if (event?.server && !list.some((server) => server.id === event.server?.id)) {
    list.push({ ...event.server, position: list.length, verified: false, verifiedAt: null });
  }
  return list;
}

/** A fresh draft: tomorrow at 19:00 in the organizer's zone, for three hours, on the first server. */
function freshDraft(community: Community, zone: string, now: number): EventDraft {
  const tomorrow = dayKey(now + 24 * 60 * 60 * 1000, zone);
  const servers = publicServers(community);
  return {
    title: "",
    kind: "tournament",
    day: tomorrow,
    time: "19:00",
    duration: 180,
    endDay: tomorrow,
    endTime: "22:00",
    timezone: zone,
    place: servers.length > 0 ? "server" : "offline",
    serverId: servers[0]?.id ?? "",
    address: "",
    game: community.games[0] ?? "ja",
    description: "",
    instructions: "",
    files: [],
    bundleId: null,
    capacity: "",
    cover: null,
    notify: true,
  };
}

export function EventEditor({ target }: { target: EditorTarget }) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const events = useEventsPlatform();
  const api = useEventsApi();
  const format = useEventFormat();
  const failure = useEventFailureText();
  const now = useNow(60_000);
  const account = platform.signedIn ? platform.accountId ?? "account" : "guest";

  const sourceId = target.mode === "edit" ? target.id : target.copyOf ?? null;
  const source = useRemote(sourceId ? `editor-event:${sourceId}:${account}` : null, () => api.get(sourceId as string));
  const communityId = target.mode === "new" ? target.communityId : source.data?.communityId ?? null;
  const community = useRemote(communityId ? `editor-community:${communityId}:${account}` : null, () =>
    communityApi(platform.request).get(communityId as string),
  );

  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [serviceError, setServiceError] = useState<{ kind: EventFailureKind; text: string } | null>(null);
  const [touched, setTouched] = useState(false);

  // The draft starts once what it starts from has arrived.
  useEffect(() => {
    if (draft !== null || !community.data) return;
    if (sourceId !== null && !source.data) return;
    if (source.data) setDraft(draftOf(source.data, target.mode === "new" ? 7 : 0, format.zone));
    else setDraft(freshDraft(community.data, format.zone, now));
  }, [community.data, source.data]);

  const loadError = community.error ?? source.error;
  if (loadError) {
    return (
      <div className="flex flex-col gap-16">
        <BackLink target={target} communityId={communityId} />
        {isNotFound(loadError) ? <Notice tone="danger">{t("editor.notFound")}</Notice> : <Failure error={loadError} onRetry={() => (community.error ? community.reload() : source.reload())} />}
      </div>
    );
  }
  if (!community.data || draft === null) {
    return (
      <p role="status" className="text-body-sm text-fg-muted">
        {t("common.loading")}
      </p>
    );
  }

  const page = community.data;
  const viewer = page.viewer;
  const organizer = platform.canManage && viewer !== null && (viewer.role !== null || viewer.isAdmin);
  if (!organizer) {
    return (
      <div className="flex flex-col gap-16">
        <BackLink target={target} communityId={page.id} />
        <div role="status" className="mx-auto mt-24 flex max-w-[520px] flex-col items-center gap-12 rounded-lg border border-dashed border-line px-32 py-40 text-center">
          <span className="flex size-48 items-center justify-center rounded-full bg-surface text-fg-secondary" aria-hidden="true">
            <ShieldAlert size={24} />
          </span>
          <p className="text-heading-sm text-fg">{t("editor.deniedTitle")}</p>
          <p className="text-body-sm text-fg-secondary">{t("editor.deniedText", { community: page.name })}</p>
          {!platform.signedIn ? (
            <Button size="sm" variant="primary" wrap onClick={platform.signIn}>
              {t("common.signIn")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const editing = target.mode === "edit" ? source.data ?? null : null;
  const originalStart = editing ? Date.parse(editing.startsAt) : null;
  const tentative = zonedToInstant(draft.day, draft.time, draft.timezone || "UTC");
  const moved = editing === null || tentative !== originalStart;
  const checked = checkDraft(draft, now, moved);
  const errors = checked.errors;
  const errorFields = Object.keys(errors) as DraftField[];
  const timeOk = errors.start === undefined && errors.end === undefined && errors.length === undefined;
  const show = (field: DraftField) => (touched || field !== "title" || draft.title !== "" ? errors[field] : undefined);
  const update = (patch: Partial<EventDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setServiceError(null);
  };

  const submit = async () => {
    setTouched(true);
    if (errorFields.length > 0 || checked.startsAt === null || checked.endsAt === null || saving) return;
    const body = draftBody(draft, checked.startsAt, checked.endsAt);
    setSaving(true);
    setServiceError(null);
    try {
      if (editing) {
        const patch = draftPatch(editing, body);
        if (Object.keys(patch).length > 0) await api.update(editing.id, { ...patch, revision: editing.revision });
        events.onChanged?.();
        events.navigate({ view: "event", id: editing.id });
      } else {
        const created = await api.create(page.id, body);
        events.onChanged?.();
        events.navigate({ view: "event", id: created.id });
      }
    } catch (reason) {
      setServiceError({ kind: eventFailureKind(reason), text: failure(reason) });
    } finally {
      setSaving(false);
    }
  };

  const loose = t as unknown as (key: string, values?: Record<string, unknown>) => string;
  const fieldOfService: Partial<Record<EventFailureKind, DraftField>> = {
    startsInPast: "start",
    tooFar: "start",
    length: "length",
    server: "server",
    address: "address",
    relay: "address",
    capacity: "capacity",
    timezone: "timezone",
    files: "files",
  };
  const serviceField = serviceError ? fieldOfService[serviceError.kind] ?? null : null;
  const fieldError = (field: DraftField): string | null => {
    if (serviceField === field && serviceError) return serviceError.text;
    const code = show(field);
    return code ? loose(`editor.errors.${field}.${code}`, errorValues(field)) : null;
  };
  const errorValues = (field: DraftField) =>
    field === "length" && tentative !== null
      ? { time: format.time(tentative, draft.timezone), day: format.day(tentative) }
      : {};

  const title = target.mode === "edit" ? t("editor.editTitle") : t("editor.newTitle");

  return (
    <div className="flex flex-col gap-16">
      <BackLink target={target} communityId={page.id} name={page.name} />
      <div className="flex flex-wrap items-end gap-16">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
            <h1 className="text-display-lg text-fg [overflow-wrap:anywhere]">
              {title} <span className="font-medium text-fg-secondary">{t("editor.of", { community: page.name })}</span>
            </h1>
            <Badge tone="accent">{viewer.isAdmin && viewer.role === null ? t("organizer.admin") : t(`organizer.${viewer.role === "owner" ? "owner" : "editor"}`)}</Badge>
          </div>
          <p className="text-body-md text-fg-secondary">{target.mode === "new" && target.copyOf ? t("editor.copySubtitle") : t("editor.subtitle")}</p>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_368px] items-start gap-24 @max-[960px]/community:grid-cols-1">
        <section aria-label={t("editor.form")} className="flex min-w-0 flex-col gap-16 rounded-lg border border-line bg-surface px-20 py-16">
          <Field label={t("editor.title")} htmlFor="event-title" counter={`${Array.from(draft.title).length} / ${MAX_TITLE}`} error={fieldError("title")}>
            <Input
              id="event-title"
              value={draft.title}
              maxLength={MAX_TITLE + 20}
              invalid={fieldError("title") !== null}
              placeholder={t("editor.titlePlaceholder")}
              onChange={(change) => update({ title: change.target.value })}
            />
          </Field>
          <KindChips value={draft.kind} onChange={(kind) => update({ kind })} />

          <Separator />

          <div className="grid grid-cols-2 gap-16 @max-[640px]/community:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-8">
              <span className="text-body-sm-medium text-fg" id="event-start-label">
                {t("editor.start")}
              </span>
              <div className="flex gap-8">
                <DatePicker
                  value={draft.day}
                  label={t("editor.startDate")}
                  invalid={fieldError("start") !== null}
                  minDay={editing ? null : dayKey(now, draft.timezone || format.zone)}
                  onChange={(day) => update(draft.duration === null ? { day } : { day, endDay: day })}
                />
                <TimeInput value={draft.time} label={t("editor.startTime")} invalid={fieldError("start") !== null} onChange={(time) => update({ time })} />
              </div>
            </div>
            {draft.duration !== null ? (
              <div className="flex min-w-0 flex-col gap-8">
                <span className="text-body-sm-medium text-fg">{t("editor.duration")}</span>
                <Select
                  className="w-full"
                  ariaLabel={t("editor.duration")}
                  value={String(draft.duration)}
                  options={[
                    ...DURATIONS.map((minutes) => ({
                      value: String(minutes),
                      label: durationLabel(t, minutes, format.locale),
                      hint: tentative !== null ? t("editor.until", { time: format.time(tentative + minutes * 60_000, draft.timezone) }) : undefined,
                    })),
                    { value: "custom", label: t("editor.customEnd") },
                  ]}
                  onChange={(value) => {
                    if (value === "custom") {
                      const end = tentative !== null ? tentative + (draft.duration ?? 180) * 60_000 : null;
                      update({
                        duration: null,
                        endDay: end !== null ? dayKey(end, draft.timezone || "UTC") : draft.day,
                        endTime: end !== null ? clockIn(end, draft.timezone) : draft.endTime,
                      });
                    } else update({ duration: Number(value) });
                  }}
                />
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-8">
                <span className="flex items-baseline justify-between gap-8 text-body-sm-medium text-fg">
                  {t("editor.end")}
                  <button type="button" className="cursor-pointer text-body-sm-medium text-fg-accent hover:underline" onClick={() => update({ duration: 180 })}>
                    {t("editor.backToDuration")}
                  </button>
                </span>
                <div className="flex gap-8">
                  <DatePicker
                    value={draft.endDay}
                    label={t("editor.endDate")}
                    invalid={fieldError("end") !== null || fieldError("length") !== null}
                    minDay={null}
                    onChange={(endDay) => update({ endDay })}
                  />
                  <TimeInput
                    value={draft.endTime}
                    label={t("editor.endTime")}
                    invalid={fieldError("end") !== null || fieldError("length") !== null}
                    onChange={(endTime) => update({ endTime })}
                  />
                </div>
              </div>
            )}
          </div>
          <FieldNote
            error={fieldError("start") ?? fieldError("end") ?? fieldError("length")}
            note={
              checked.endsAt !== null && checked.startsAt !== null
                ? t(draft.duration === null ? "editor.endsAtLength" : "editor.endsAt", {
                    time: format.time(checked.endsAt, draft.timezone),
                    day: format.day(checked.endsAt),
                    length: format.duration(checked.endsAt - checked.startsAt),
                  })
                : null
            }
          />

          <div className="flex flex-col gap-8">
            <span className="text-body-sm-medium text-fg">{t("editor.timezone")}</span>
            <Combobox
              className="w-[320px] max-w-full"
              ariaLabel={t("editor.timezone")}
              searchLabel={t("editor.timezoneSearch")}
              emptyText={t("editor.timezoneNone")}
              value={draft.timezone}
              options={zoneOptions(draft.timezone, tentative ?? now)}
              onChange={(timezone) => update({ timezone })}
            />
            <FieldNote error={fieldError("timezone")} note={zonesLine(t, format, tentative, draft.timezone)} />
          </div>

          <Separator />

          <WhereField draft={draft} servers={serverChoices(page, source.data ?? null)} update={update} error={fieldError("server") ?? fieldError("address")} />

          <Separator />

          <MarkdownField
            id="event-description"
            label={t("editor.description")}
            value={draft.description}
            max={MAX_DESCRIPTION}
            error={fieldError("description")}
            onChange={(description) => update({ description })}
          />
          <Field
            label={
              <>
                {t("editor.instructions")} <span className="font-normal text-fg-secondary">{t("editor.instructionsHint")}</span>
              </>
            }
            htmlFor="event-instructions"
            counter={`${format.number(Array.from(draft.instructions).length)} / ${format.number(MAX_INSTRUCTIONS)}`}
            error={fieldError("instructions")}
          >
            <textarea
              id="event-instructions"
              value={draft.instructions}
              onChange={(change) => update({ instructions: change.target.value })}
              rows={3}
              className="block w-full resize-y rounded-md border border-line bg-input px-12 py-8 text-body-sm text-fg outline-none focus:border-line-focus"
            />
          </Field>

          <Separator />

          <FilesField draft={draft} update={update} error={fieldError("files")} />

          <div className="grid grid-cols-2 gap-16 @max-[640px]/community:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-8">
              <span className="text-body-sm-medium text-fg">
                {t("editor.bundle")} <span className="font-normal text-fg-secondary">{t("editor.bundleHint")}</span>
              </span>
              <Select
                className="w-full"
                ariaLabel={t("editor.bundle")}
                value={draft.bundleId ?? ""}
                options={bundleOptions(t, page, editing ?? source.data ?? null)}
                onChange={(value) => update({ bundleId: value === "" ? null : value })}
              />
              <p className="text-body-sm text-fg-secondary">{t("editor.bundleHelp")}</p>
            </div>
            <Field
              label={
                <>
                  {t("editor.capacity")} <span className="font-normal text-fg-secondary">{t("editor.optional")}</span>
                </>
              }
              htmlFor="event-capacity"
              error={fieldError("capacity")}
              note={t("editor.capacityHelp")}
            >
              <Input
                id="event-capacity"
                inputMode="numeric"
                value={draft.capacity}
                maxLength={4}
                invalid={fieldError("capacity") !== null}
                placeholder={t("editor.capacityPlaceholder")}
                icon={<Users size={16} />}
                onChange={(change) => update({ capacity: change.target.value.replace(/[^\d]/g, "") })}
              />
            </Field>
          </div>
        </section>

        <aside aria-label={t("editor.side")} className="flex min-w-0 flex-col gap-24">
          <CoverField draft={draft} communityId={page.id} update={update} />
          <PreviewCard
            draft={draft}
            community={page}
            servers={serverChoices(page, source.data ?? null)}
            bundles={[page.bundle, source.data?.requirements.bundle ?? null]}
            startsAt={timeOk ? checked.startsAt : null}
            endsAt={timeOk ? checked.endsAt : null}
          />
          {target.mode === "new" ? (
            <div className="flex flex-col gap-8">
              <span className="text-body-sm-medium text-fg">
                {draft.notify ? t("editor.notifyPreview", { count: page.counts.followers }) : t("editor.notifyOff")}
              </span>
              {draft.notify ? (
                <div aria-hidden="true" className="flex gap-12 rounded-lg border border-line-accent bg-elevated p-12">
                  <CalendarDays size={16} className="mt-2 shrink-0 text-fg-accent" />
                  <div className="flex min-w-0 flex-col gap-2">
                    <p className="text-body-sm-medium text-fg">{t("notify.created", { community: page.name })}</p>
                    <p className="text-body-sm text-fg-secondary [overflow-wrap:anywhere]">
                      {t("notify.createdText", {
                        title: draft.title.trim() || t("editor.untitled"),
                        when: checked.startsAt !== null ? format.dayTime(checked.startsAt) : "—",
                      })}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-body-sm text-fg-secondary">{t("editor.notifyOffText")}</p>
              )}
            </div>
          ) : (
            <p className="text-body-sm text-fg-secondary">{t("editor.editNote")}</p>
          )}
        </aside>
      </div>

      {serviceError && serviceField === null ? <Notice tone="danger">{serviceError.text}</Notice> : null}

      <div className="flex flex-wrap items-center gap-16 border-t border-line-subtle pt-16">
        {target.mode === "new" ? (
          <label className="inline-flex cursor-pointer items-center gap-8 text-body-md-medium text-fg select-none">
            <input type="checkbox" className="peer sr-only" checked={draft.notify} onChange={(change) => update({ notify: change.target.checked })} />
            <span
              aria-hidden="true"
              className={cn(
                "flex size-18 items-center justify-center rounded-xs border peer-focus-visible:shadow-[0_0_0_2px_var(--color-border-focus)]",
                draft.notify ? "border-line-accent bg-accent text-fg-on-accent" : "border-line-strong bg-input",
              )}
            >
              {draft.notify ? <Check size={12} strokeWidth={3} /> : null}
            </span>
            {t("editor.notify", { followers: format.number(page.counts.followers) })}
          </label>
        ) : null}
        <span className="flex-1" />
        {touched && errorFields.length > 0 ? (
          <span role="status" className="text-body-sm text-fg-danger">
            {t("editor.fix", { fields: errorFields.map((field) => t(`editor.fields.${field}`)).join(", ") })}
          </span>
        ) : null}
        <Button
          variant="ghost"
          wrap
          onClick={() =>
            editing ? events.navigate({ view: "event", id: editing.id }) : platform.navigate({ view: "community", id: page.id, tab: "events" })
          }
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          size="lg"
          wrap
          disabled={saving || (touched && errorFields.length > 0)}
          icon={saving ? <LoaderCircle size={16} className="animate-spin" /> : undefined}
          onClick={() => void submit()}
        >
          {saving ? t(editing ? "editor.saving" : "editor.publishing") : t(editing ? "editor.save" : "editor.publish")}
        </Button>
      </div>
    </div>
  );
}

/** The way back: the event while it is changed, the community while one is created. */
function BackLink({ target, communityId, name }: { target: EditorTarget; communityId: string | null; name?: string }) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const events = useEventsPlatform();
  const className =
    "-ml-6 flex w-fit min-h-28 items-center gap-6 rounded-sm py-4 pr-10 pl-6 text-body-sm-medium text-fg-secondary hover:bg-hover-overlay hover:text-fg cursor-pointer";
  if (target.mode === "edit") {
    return (
      <button type="button" className={className} onClick={() => events.navigate({ view: "event", id: target.id })}>
        <ArrowLeft size={16} aria-hidden="true" />
        {t("editor.backToEvent")}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={() => (communityId ? platform.navigate({ view: "community", id: communityId, tab: "events" }) : events.navigate({ view: "calendar" }))}
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {name ?? t("editor.backToCommunity")}
    </button>
  );
}

function Separator() {
  return <div role="separator" className="-mx-20 h-px bg-line-subtle" />;
}

/** A labelled field with its counter, its note and its error. */
function Field({
  label,
  htmlFor,
  counter,
  error,
  note,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  counter?: string;
  error?: string | null;
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {/* The counter stands beside the label, not in it: the field's name stays its label. */}
      <div className="flex items-baseline justify-between gap-8">
        <label htmlFor={htmlFor} className="text-body-sm-medium text-fg">
          {label}
        </label>
        {counter ? <span className="shrink-0 text-mono-xs text-fg-secondary">{counter}</span> : null}
      </div>
      {children}
      <FieldNote error={error ?? null} note={note ?? null} />
    </div>
  );
}

function FieldNote({ error, note }: { error: string | null; note: string | null }) {
  if (error) {
    return (
      <p role="alert" className="text-body-sm text-fg-danger">
        {error}
      </p>
    );
  }
  return note ? <p className="text-body-sm text-fg-secondary">{note}</p> : null;
}

/** The six kinds as chips, one chosen. */
function KindChips({ value, onChange }: { value: string; onChange: (kind: string) => void }) {
  const { t } = useTranslation("events");
  const name = useKindName();
  return (
    <div className="flex flex-col gap-8">
      <span className="text-body-sm-medium text-fg" id="event-kind-label">
        {t("editor.kind")}
      </span>
      <div role="radiogroup" aria-labelledby="event-kind-label" className="flex flex-wrap gap-8">
        {EVENT_KINDS.map((kind) => {
          const on = kind === value;
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(kind)}
              className={cn(
                "inline-flex min-h-32 cursor-pointer items-center rounded-full border px-12 py-4 text-body-sm-medium select-none transition-colors pointer-coarse:min-h-44",
                on ? "border-line-accent bg-accent-subtle text-fg-accent" : "border-line bg-input text-fg-secondary hover:border-line-strong hover:text-fg",
              )}
            >
              {name(kind)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** `HH:MM` of a moment in a zone, `UTC` when the zone is empty. */
function clockIn(instant: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour.padStart(2, "0")}:${minute}`;
}

type Translate = ReturnType<typeof useTranslation<"events">>["t"];

function durationLabel(t: Translate, minutes: number, locale: string): string {
  if (minutes < 60) return t("editor.minutes", { count: minutes });
  const hours = minutes / 60;
  return t("editor.hours", { count: hours, value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(hours) });
}

function zoneOptions(selected: string, at: number) {
  return timeZoneNames([selected]).map((zone) => {
    let offset = "";
    try {
      offset = formatOffset(offsetMinutes(at, zone));
    } catch {
      offset = "";
    }
    return { value: zone, label: zone, hint: offset };
  });
}

/** `Players in Europe/Berlin see 18:00, in America/New_York — 12:00.` */
function zonesLine(t: Translate, format: ReturnType<typeof useEventFormat>, start: number | null, zone: string): string {
  if (start === null) return t("editor.zonesEmpty");
  let own = 0;
  try {
    own = offsetMinutes(start, zone || "UTC");
  } catch {
    return t("editor.zonesEmpty");
  }
  const others = SAMPLE_ZONES.filter((sample) => sample !== zone && offsetMinutes(start, sample) !== own).slice(0, 2);
  if (others.length < 2) return t("editor.zonesEmpty");
  const read = (sample: string) => {
    const sameDay = dayKey(start, sample) === dayKey(start, zone || "UTC");
    return sameDay ? format.time(start, sample) : t("editor.zoneOtherDay", { day: format.weekday(start).replace(/\.$/, ""), time: format.time(start, sample) });
  };
  return t("editor.zones", { first: others[0], firstTime: read(others[0]), second: others[1], secondTime: read(others[1]) });
}

/** The day of the start or the end, from a popover of one month. */
function DatePicker({
  value,
  label,
  invalid,
  minDay,
  onChange,
}: {
  value: string;
  label: string;
  invalid: boolean;
  minDay: string | null;
  onChange: (day: string) => void;
}) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Month>(() => monthOf(value));
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const grid = useMemo(() => monthGrid(month), [month]);
  const today = dayKey(Date.now(), format.zone);
  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${format.dayOfKey(value)}`}
        onClick={() => {
          setMonth(monthOf(value));
          setOpen((current) => !current);
        }}
        className={cn(
          "flex h-36 w-full min-w-0 cursor-pointer items-center gap-8 rounded-md border bg-input px-12 text-left text-body-md text-fg select-none pointer-coarse:h-44",
          invalid ? "border-line-danger" : open ? "border-line-focus" : "border-line hover:border-line-strong",
        )}
      >
        <CalendarDays size={16} aria-hidden="true" className="shrink-0 text-fg-muted" />
        <span className="truncate">{capitalize(new Intl.DateTimeFormat(format.locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "long" }).format(new Date(noonOf(value))), format.locale)}</span>
      </button>
      {open ? (
        <div role="dialog" aria-label={label} className="absolute top-[calc(100%+4px)] left-0 z-30 flex w-[272px] flex-col gap-8 rounded-md border border-line-strong bg-elevated p-12 shadow-popover">
          <div className="flex items-center justify-between gap-8">
            <span className="text-body-md-medium text-fg">{format.month(month)}</span>
            <span className="flex gap-2">
              <button type="button" aria-label={t("calendar.previous")} onClick={() => setMonth((current) => addMonths(current, -1))} className="flex size-28 cursor-pointer items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg">
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <button type="button" aria-label={t("calendar.next")} onClick={() => setMonth((current) => addMonths(current, 1))} className="flex size-28 cursor-pointer items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg">
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </span>
          </div>
          <div className="grid grid-cols-7 gap-2">
            {format.weekdays.map((name) => (
              <span key={name} aria-hidden="true" className="flex h-20 items-center justify-center text-label-xs text-fg-secondary">
                {name}
              </span>
            ))}
            {grid.map((day) => {
              const selected = day.key === value;
              const disabled = minDay !== null && day.key < minDay;
              return (
                <button
                  key={day.key}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  aria-label={format.dayOfKey(day.key)}
                  onClick={() => {
                    onChange(day.key);
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                  className={cn(
                    "flex h-32 cursor-pointer items-center justify-center rounded-sm text-mono-xs tabular-nums select-none",
                    selected ? "bg-accent font-semibold text-fg-on-accent" : day.inMonth ? "text-fg hover:bg-hover-overlay" : "text-fg-muted hover:bg-hover-overlay",
                    day.key === today && !selected && "shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
                    "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-fg-disabled",
                  )}
                >
                  {day.day}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A time of day, `HH:MM`, typed. */
function TimeInput({ value, label, invalid, onChange }: { value: string; label: string; invalid: boolean; onChange: (value: string) => void }) {
  return (
    <Input
      className="w-[104px] shrink-0"
      value={value}
      maxLength={5}
      inputMode="numeric"
      aria-label={label}
      invalid={invalid}
      icon={<Clock size={16} />}
      onChange={(change) => onChange(change.target.value.replace(/[^\d:]/g, "").slice(0, 5))}
    />
  );
}

/** Where the event takes place: a server of the community, an address, or outside the game. */
function WhereField({
  draft,
  servers,
  update,
  error,
}: {
  draft: EventDraft;
  servers: CommunityServer[];
  update: (patch: Partial<EventDraft>) => void;
  error: string | null;
}) {
  const { t } = useTranslation("events");
  const places: Array<{ id: EventDraft["place"]; label: string }> = [
    { id: "server", label: t("editor.whereServer") },
    { id: "address", label: t("editor.whereAddress") },
    { id: "offline", label: t("editor.whereOffline") },
  ];
  const gameSelect = (
    <Select
      className="w-[200px]"
      ariaLabel={t("editor.game")}
      value={draft.game}
      options={(["ja", "jo"] as Game[]).map((game) => ({ value: game, label: GAME_NAMES[game] }))}
      onChange={(value) => update({ game: value === "jo" ? "jo" : "ja" })}
    />
  );
  return (
    <div className="flex flex-col gap-8">
      <span className="text-body-sm-medium text-fg" id="event-where-label">
        {t("editor.where")}
      </span>
      <div role="radiogroup" aria-labelledby="event-where-label" className="flex flex-wrap items-center gap-x-24 gap-y-8">
        {places.map((place) => {
          const on = draft.place === place.id;
          return (
            <label key={place.id} className={cn("inline-flex cursor-pointer items-center gap-8 text-body-sm select-none", on ? "text-fg" : "text-fg-secondary")}>
              <input type="radio" name="event-where" className="peer sr-only" checked={on} onChange={() => update({ place: place.id })} />
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-16 items-center justify-center rounded-full border peer-focus-visible:shadow-[0_0_0_2px_var(--color-border-focus)]",
                  on ? "border-line-accent" : "border-line-strong",
                )}
              >
                {on ? <span className="size-8 rounded-full bg-accent" /> : null}
              </span>
              {place.label}
            </label>
          );
        })}
      </div>
      {draft.place === "server" ? (
        servers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-12">
            <Select
              className="w-[320px] max-w-full"
              ariaLabel={t("editor.server")}
              value={draft.serverId}
              placeholder={t("editor.pickServer")}
              options={servers.map((server) => ({ value: server.id, label: serverName(server), hint: server.address }))}
              onChange={(serverId) => update({ serverId })}
            />
            <span className="flex items-center gap-6 text-body-sm text-fg-secondary">
              <Server size={14} aria-hidden="true" className="text-fg-muted" />
              {GAME_NAMES[servers.find((server) => server.id === draft.serverId)?.game ?? "ja"]}
            </span>
          </div>
        ) : (
          <p className="text-body-sm text-fg-warm">{t("editor.noServers")}</p>
        )
      ) : null}
      {draft.place === "address" ? (
        <div className="flex flex-wrap items-center gap-12">
          <Input
            className="w-[320px] max-w-full"
            value={draft.address}
            maxLength={21}
            aria-label={t("editor.address")}
            placeholder={t("editor.addressPlaceholder")}
            invalid={error !== null}
            icon={<Server size={16} />}
            onChange={(change) => update({ address: change.target.value.trim() })}
          />
          {gameSelect}
        </div>
      ) : null}
      {draft.place === "offline" ? (
        <div className="flex flex-col gap-8">
          {gameSelect}
          <p className="text-body-sm text-fg-secondary">{t("editor.offlineHelp")}</p>
        </div>
      ) : null}
      <FieldNote error={error} note={draft.place === "address" ? t("editor.addressHelp") : null} />
    </div>
  );
}

/** The description: Markdown with a few buttons, and its preview. */
function MarkdownField({
  id,
  label,
  value,
  max,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const [preview, setPreview] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  /** Wraps the selection, or inserts a sample where the caret is. */
  const apply = (before: string, after: string, sample: string, line = false) => {
    const element = area.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const chosen = value.slice(start, end) || sample;
    const lead = line && start > 0 && value[start - 1] !== "\n" ? "\n" : "";
    const next = `${value.slice(0, start)}${lead}${before}${chosen}${after}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      if (!area.current) return;
      area.current.focus();
      const from = start + lead.length + before.length;
      area.current.setSelectionRange(from, from + chosen.length);
    });
  };
  const tools: Array<{ key: string; icon: ReactNode; label: string; run: () => void }> = [
    { key: "bold", icon: <Bold size={14} />, label: t("editor.md.bold"), run: () => apply("**", "**", t("editor.md.boldSample")) },
    { key: "italic", icon: <Italic size={14} />, label: t("editor.md.italic"), run: () => apply("*", "*", t("editor.md.italicSample")) },
    { key: "heading", icon: <Heading2 size={14} />, label: t("editor.md.heading"), run: () => apply("## ", "", t("editor.md.headingSample"), true) },
    { key: "list", icon: <ListIcon size={14} />, label: t("editor.md.list"), run: () => apply("- ", "", t("editor.md.listSample"), true) },
    { key: "ordered", icon: <ListOrdered size={14} />, label: t("editor.md.ordered"), run: () => apply("1. ", "", t("editor.md.listSample"), true) },
    { key: "quote", icon: <Quote size={14} />, label: t("editor.md.quote"), run: () => apply("> ", "", t("editor.md.quoteSample"), true) },
    { key: "link", icon: <LinkIcon size={14} />, label: t("editor.md.link"), run: () => apply("[", "](https://)", t("editor.md.linkSample")) },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <label htmlFor={id} className="text-body-sm-medium text-fg">
        {label}
      </label>
      <div className={cn("overflow-hidden rounded-md border bg-input focus-within:border-line-focus", error ? "border-line-danger" : "border-line")}>
        <div role="toolbar" aria-label={t("editor.md.toolbar")} className="flex min-h-36 flex-wrap items-center gap-2 border-b border-line-subtle py-2 pr-4 pl-6">
          {tools.map((tool, index) => (
            <span key={tool.key} className="flex items-center">
              {index === 3 ? <span aria-hidden="true" className="mx-4 h-16 w-px bg-line" /> : null}
              <button
                type="button"
                aria-label={tool.label}
                title={tool.label}
                disabled={preview}
                onClick={tool.run}
                className="flex size-28 cursor-pointer items-center justify-center rounded-sm text-fg-secondary select-none hover:bg-hover-overlay hover:text-fg disabled:cursor-not-allowed disabled:bg-transparent disabled:text-fg-disabled"
              >
                {tool.icon}
              </button>
            </span>
          ))}
          <span className="ml-auto px-8 text-mono-xs text-fg-secondary">
            {format.number(Array.from(value).length)} / {format.number(max)}
          </span>
          <span role="tablist" aria-label={t("editor.md.mode")} className="inline-flex gap-2 rounded-sm border border-line bg-surface p-2">
            {[false, true].map((mode) => (
              <button
                key={String(mode)}
                type="button"
                role="tab"
                aria-selected={preview === mode}
                onClick={() => setPreview(mode)}
                className={cn(
                  "min-h-22 cursor-pointer rounded-xs px-8 text-body-sm-medium select-none",
                  preview === mode ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary hover:text-fg",
                )}
              >
                {mode ? t("editor.md.preview") : t("editor.md.write")}
              </button>
            ))}
          </span>
        </div>
        {preview ? (
          <div className="min-h-[120px] px-12 py-8">
            {value.trim() !== "" ? <CommunityMarkdown text={value} /> : <p className="text-body-sm text-fg-muted">{t("editor.md.previewEmpty")}</p>}
          </div>
        ) : (
          <textarea
            id={id}
            ref={area}
            value={value}
            rows={6}
            onChange={(change) => onChange(change.target.value)}
            className="block min-h-[120px] w-full resize-y bg-transparent px-12 py-8 font-mono text-[13px] leading-[20px] text-fg outline-none"
          />
        )}
      </div>
      <FieldNote error={error} note={null} />
    </div>
  );
}

/** The JKHub files of the requirements: a search of JKHub and the files added. */
function FilesField({ draft, update, error }: { draft: EventDraft; update: (patch: Partial<EventDraft>) => void; error: string | null }) {
  const { t } = useTranslation("events");
  const events = useEventsPlatform();
  const failure = useEventFailureText();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JkhubPick[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const search = events.searchJkhub;
  const trimmed = query.trim();

  useEffect(() => {
    if (!search || trimmed.length < 2) {
      setResults(null);
      setSearchError(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      search(draft.game, trimmed).then(
        (found) => {
          if (alive) {
            setResults(found.slice(0, 8));
            setSearchError(null);
          }
        },
        (reason: unknown) => {
          if (alive) {
            setResults([]);
            setSearchError(failure(reason));
          }
        },
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [search, trimmed, draft.game, failure]);

  const added = new Set(draft.files.map((file) => file.jkhubId));
  const full = draft.files.length >= MAX_FILES;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <span className="flex items-baseline justify-between gap-8 text-body-sm-medium text-fg">
        <span>
          {t("editor.files")} <span className="font-normal text-fg-secondary">{t("editor.filesHint")}</span>
        </span>
        <span className="shrink-0 text-mono-xs text-fg-secondary">{t("editor.filesCount", { added: draft.files.length, max: MAX_FILES })}</span>
      </span>
      {search ? (
        <Input
          value={query}
          aria-label={t("editor.search")}
          placeholder={t("editor.search")}
          icon={<Search size={16} />}
          onChange={(change) => setQuery(change.target.value.slice(0, 80))}
          trailing={
            query !== "" ? (
              <button
                type="button"
                aria-label={t("editor.searchClear")}
                onClick={() => setQuery("")}
                className="flex size-24 cursor-pointer items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg"
              >
                <X size={14} />
              </button>
            ) : undefined
          }
        />
      ) : (
        <p className="text-body-sm text-fg-secondary">{t("editor.searchUnavailable")}</p>
      )}
      {results !== null ? (
        <div role="list" aria-label={t("editor.found")} className="flex flex-col overflow-hidden rounded-md border border-line-strong bg-elevated">
          {results.map((file) => {
            const has = added.has(file.jkhubId);
            return (
              <div key={file.jkhubId} role="listitem" className="flex min-h-40 items-center gap-10 border-t border-line first:border-t-0 py-4 pr-6 pl-10">
                <Package size={16} aria-hidden="true" className="shrink-0 text-fg-secondary" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body-sm-medium text-fg" title={file.title}>
                    {file.title}
                  </span>
                  <span className="text-body-sm text-fg-secondary">
                    {file.category ? t("editor.fileMeta", { category: file.category, id: file.jkhubId }) : t("requirements.file", { id: file.jkhubId })}
                  </span>
                </span>
                <Button
                  size="sm"
                  wrap
                  disabled={has || full}
                  onClick={() => update({ files: [...draft.files, { jkhubId: file.jkhubId, title: file.title.slice(0, 120) }] })}
                >
                  {has ? t("editor.added") : t("editor.add")}
                </Button>
              </div>
            );
          })}
          {results.length === 0 ? <p className="px-12 py-10 text-body-sm text-fg-secondary">{searchError ?? t("editor.searchEmpty", { query: trimmed })}</p> : null}
        </div>
      ) : null}
      <ul aria-label={t("editor.files")} className="flex flex-col gap-6">
        {draft.files.map((file) => (
          <li key={file.jkhubId} className="flex min-h-44 items-center gap-10 rounded-md border border-line-subtle bg-input py-6 pr-6 pl-10">
            <Package size={16} aria-hidden="true" className="shrink-0 text-fg-secondary" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body-sm-medium text-fg" title={file.title}>
                {file.title}
              </span>
              <span className="text-body-sm text-fg-secondary">{t("requirements.file", { id: file.jkhubId })}</span>
            </span>
            <button
              type="button"
              aria-label={t("editor.remove", { title: file.title })}
              title={t("editor.removeShort")}
              onClick={() => update({ files: draft.files.filter((other) => other.jkhubId !== file.jkhubId) })}
              className="flex size-28 cursor-pointer items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg pointer-coarse:size-44"
            >
              <X size={14} />
            </button>
          </li>
        ))}
        {draft.files.length === 0 ? (
          <li className="rounded-md border border-dashed border-line px-12 py-10 text-body-sm text-fg-secondary">{t("editor.noFiles")}</li>
        ) : null}
      </ul>
      <FieldNote error={error} note={null} />
    </div>
  );
}

function bundleOptions(t: Translate, community: Community, event: EventDetails | null) {
  const options = [{ value: "", label: t("editor.noBundle") }];
  const seen = new Set<string>();
  for (const bundle of [community.bundle, event?.requirements.bundle ?? null]) {
    if (bundle && !seen.has(bundle.id)) {
      seen.add(bundle.id);
      options.push({ value: bundle.id, label: bundle.name });
    }
  }
  return options;
}

/**
 * The cover: the picture with **Replace** and **Remove**, or the place to
 * choose one. It goes up the way the logo and the cover of a page do
 * (`usePictureUpload`): the launcher's dialog, or the website's file input,
 * and a file dropped on it the same way (`PictureDropZone`).
 */
function CoverField({ draft, communityId, update }: { draft: EventDraft; communityId: string; update: (patch: Partial<EventDraft>) => void }) {
  const { t } = useTranslation("events");
  const failure = useEventFailureText();
  const refusalText = usePictureRefusalText();
  const upload = usePictureUpload("cover", t("editor.cover"), (image) => update({ cover: image.sha256 }));
  const { busy, canUpload, choose } = upload;
  const error =
    upload.problem === null
      ? null
      : "refused" in upload.problem
        ? refusalText(upload.problem.refused)
        : t("editor.coverFailed", { message: failure(upload.problem.failed) });
  return (
    <div className="flex flex-col gap-8">
      <span className="text-body-sm-medium text-fg">
        {t("editor.cover")} <span className="font-normal text-fg-secondary">{t("editor.coverHint")}</span>
      </span>
      {draft.cover ? (
        <PictureDropZone upload={upload} className="rounded-lg">
          <EventCover event={{ cover: draft.cover, communityId }} className="h-[120px] rounded-lg border border-line" />
          <div className="absolute top-8 right-8 flex gap-6">
            {canUpload ? (
              <Button size="sm" wrap disabled={busy} className="border-transparent bg-scrim" onClick={choose}>
                {t("editor.coverReplace")}
              </Button>
            ) : null}
            <Button size="sm" wrap className="border-transparent bg-scrim" onClick={() => update({ cover: null })}>
              {t("editor.coverRemove")}
            </Button>
          </div>
          {busy ? (
            <span role="status" className="absolute bottom-8 left-8 flex items-center gap-6 rounded-md bg-scrim px-8 py-4 text-body-sm-medium text-fg">
              <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {t("editor.coverUploading")}
            </span>
          ) : null}
        </PictureDropZone>
      ) : canUpload ? (
        <PictureDropZone upload={upload} className="rounded-lg">
          <button
            type="button"
            disabled={busy}
            onClick={choose}
            className="flex h-[120px] w-full cursor-pointer flex-col items-center justify-center gap-6 rounded-lg border border-dashed border-line-strong bg-input px-16 text-center text-fg-secondary select-none hover:border-line-accent hover:text-fg"
          >
            {busy ? <LoaderCircle size={20} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={20} aria-hidden="true" />}
            <span className="text-body-sm-medium text-fg">{busy ? t("editor.coverUploading") : t("editor.coverPick")}</span>
            <span className="text-body-sm">{t("editor.coverPickText")}</span>
          </button>
        </PictureDropZone>
      ) : (
        <p className="text-body-sm text-fg-secondary">{t("editor.coverUnavailable")}</p>
      )}
      {error ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {error}
        </p>
      ) : null}
      {upload.fileInput}
    </div>
  );
}

/** The card as players will see it, from the draft. */
function PreviewCard({
  draft,
  community,
  servers,
  bundles,
  startsAt,
  endsAt,
}: {
  draft: EventDraft;
  community: Community;
  servers: CommunityServer[];
  bundles: Array<{ id: string; name: string } | null>;
  startsAt: number | null;
  endsAt: number | null;
}) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const server = servers.find((one) => one.id === draft.serverId) ?? null;
  const where =
    draft.place === "server"
      ? server
        ? server.label.trim() === ""
          ? t("place.server", { name: server.address })
          : t("place.serverAt", { name: server.label, address: server.address })
        : t("editor.pickServer")
      : draft.place === "address"
        ? draft.address.trim() !== ""
          ? t("place.address", { address: draft.address.trim() })
          : t("editor.address")
        : t("place.offline");
  const requirements: string[] = [];
  if (draft.files.length > 0) requirements.push(t("editor.previewFiles", { count: draft.files.length }));
  const bundle = bundles.find((one) => one?.id === draft.bundleId);
  if (draft.bundleId) requirements.push(t("editor.previewBundle", { name: bundle?.name ?? draft.bundleId }));
  const capacity = draft.capacity.trim();
  return (
    <div className="flex flex-col gap-8">
      <span className="text-body-sm-medium text-fg">{t("editor.previewTitle")}</span>
      <article aria-label={t("editor.previewTitle")} className="flex flex-col gap-12 overflow-hidden rounded-lg border border-line bg-surface p-16">
        <EventCover event={{ cover: draft.cover, communityId: community.id }} className="-mx-16 -mt-16 h-96" />
        <div className="flex min-w-0 items-center gap-8 text-body-sm-medium text-fg-secondary">
          <CommunityLogo card={community} size="sm" />
          <span className="truncate">{community.name}</span>
        </div>
        <div className="flex flex-col items-start gap-6">
          <span className={cn("text-heading-sm [overflow-wrap:anywhere]", draft.title.trim() ? "text-fg" : "text-fg-muted")}>
            {draft.title.trim() || t("editor.untitled")}
          </span>
          <KindBadge kind={draft.kind} />
        </div>
        <div className="flex flex-col gap-6 text-body-sm text-fg-secondary">
          <p className="flex items-start gap-8">
            <Clock size={14} aria-hidden="true" className="mt-2 shrink-0 text-fg-muted" />
            <span className="flex flex-col">
              <span className={cn("text-body-sm-medium", startsAt !== null && endsAt !== null ? "text-fg" : "text-fg-danger")}>
                {startsAt !== null && endsAt !== null
                  ? format.range(new Date(startsAt).toISOString(), new Date(endsAt).toISOString())
                  : t("editor.previewBadTime")}
              </span>
              {startsAt !== null && draft.timezone && isTimeZone(draft.timezone) && offsetMinutes(startsAt, draft.timezone) !== offsetMinutes(startsAt, format.zone) ? (
                <span>{t("editor.previewOrganizer", { time: format.time(startsAt, draft.timezone), zone: draft.timezone })}</span>
              ) : null}
            </span>
          </p>
          <p className="flex items-start gap-8">
            <Server size={14} aria-hidden="true" className="mt-2 shrink-0 text-fg-muted" />
            <span className="[overflow-wrap:anywhere]">{where}</span>
          </p>
          <p className="flex items-start gap-8">
            <Package size={14} aria-hidden="true" className="mt-2 shrink-0 text-fg-muted" />
            <span>{requirements.length > 0 ? requirements.join(" · ") : t("editor.previewNoRequirements")}</span>
          </p>
        </div>
        <div className="flex items-center justify-between gap-12 text-body-sm text-fg-secondary">
          <span>{capacity !== "" && /^\d+$/.test(capacity) ? t("counts.places", { going: 0, count: Number(capacity) }) : t("editor.previewNoLimit")}</span>
          <span aria-hidden="true" className="flex w-[176px] shrink-0 gap-2 rounded-md border border-line bg-input p-2">
            <span className="flex-1 rounded-sm py-4 text-center text-body-sm-medium text-fg-disabled">{t("rsvp.going")}</span>
            <span className="flex-1 rounded-sm py-4 text-center text-body-sm-medium text-fg-disabled">{t("rsvp.maybe")}</span>
          </span>
        </div>
      </article>
      <p className="text-body-sm text-fg-secondary">{t("editor.previewNote", { zone: format.zone })}</p>
    </div>
  );
}

import { AlertTriangle, ArrowLeft, Lock, LogIn, SearchX, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../lib/format";
import { Button, EmptyState } from "../../ui";
import { failureOf, isNotFound } from "../api";
import { Failure, RouteLink } from "../bits";
import { useFailureText } from "../errors";
import { MANAGE_SECTIONS, useCommunityApi, useCommunityPlatform, type ManageSection } from "../platform";
import type { Community } from "../types";
import { useAction, useRemote } from "../useRemote";
import { AdminSection } from "./AdminSection";
import { BundleSection } from "./BundleSection";
import { FilesSection } from "./FilesSection";
import { ImagesSection } from "./ImagesSection";
import { LinksSection } from "./LinksSection";
import { changed, formOf, formReducer, imagesPatch, isDirty, labelChanges, pagePatch, type ManageDraft } from "./model";
import { sectionId } from "./parts";
import { ProfileSection } from "./ProfileSection";
import { ServersSection } from "./ServersSection";
import { TagsSection } from "./TagsSection";
import { TeamSection } from "./TeamSection";
import { hasProblems, problemsOf, type DraftProblems } from "./validate";

/**
 * The management screen of a community, as the design's F1 draws it: a
 * column of sections with their navigation beside it, and the save bar at
 * the bottom of the window.
 *
 * Open to the organizers — the owner, the editors and the JKNet
 * administrators — of a host that manages (`canManage`). Anyone else gets a
 * note in place of the form, and a guest the way to sign in.
 */
export default function ManageScreen({ id, section }: { id: string; section?: ManageSection }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const account = platform.signedIn ? (platform.accountId ?? "account") : "guest";
  const page = useRemote(`manage:${id}:${account}`, () => api.get(id));
  const [deleted, setDeleted] = useState<string | null>(null);
  const community = page.data;

  const back = (
    <RouteLink
      route={{ view: "community", id, tab: "overview" }}
      className="-ml-6 flex w-fit min-h-28 items-center gap-6 rounded-sm py-4 pr-10 pl-6 text-body-sm-medium text-fg-secondary hover:bg-hover-overlay hover:text-fg"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t("manage.back")}
    </RouteLink>
  );

  if (deleted !== null) {
    return (
      <EmptyState
        icon={<Trash2 size={24} />}
        title={t("manage.deletedTitle", { name: deleted })}
        text={t("manage.deletedText")}
        action={
          <Button wrap onClick={() => platform.navigate({ view: "catalog", tab: "catalog" })}>
            {t("page.back")}
          </Button>
        }
      />
    );
  }

  if (!community) {
    return (
      <div className="flex flex-col gap-16">
        {back}
        {page.error ? (
          isNotFound(page.error) ? (
            <EmptyState
              icon={<SearchX size={24} />}
              title={t("page.notFoundTitle")}
              text={t("page.notFound")}
              action={
                <Button wrap onClick={() => platform.navigate({ view: "catalog", tab: "catalog" })}>
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

  const viewer = community.viewer;
  const organizer = viewer !== null && (viewer.role !== null || viewer.isAdmin);
  if (!platform.signedIn || !organizer || !platform.canManage) {
    const guest = !platform.signedIn;
    return (
      <div className="flex flex-col gap-16">
        {back}
        <EmptyState
          icon={guest ? <LogIn size={24} /> : <Lock size={24} />}
          title={guest ? t("manage.signInTitle") : t("manage.noAccessTitle")}
          text={guest ? t("manage.signInText") : t("manage.noAccessText")}
          action={
            guest ? (
              <Button variant="primary" wrap icon={<LogIn size={16} />} onClick={platform.signIn}>
                {t("common.signIn")}
              </Button>
            ) : (
              <Button wrap onClick={() => platform.navigate({ view: "community", id, tab: "overview" })}>
                {t("manage.backToPage")}
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <ManageBody
      key={community.id}
      community={community}
      section={section}
      back={back}
      setCommunity={page.set}
      onDeleted={() => setDeleted(community.name)}
    />
  );
}

/** How a section is named in the navigation. */
function useSectionLabel(): (section: ManageSection) => string {
  const { t } = useTranslation("community");
  return (section) => {
    switch (section) {
      case "profile":
        return t("manage.sections.profile");
      case "images":
        return t("manage.sections.images");
      case "links":
        return t("manage.sections.links");
      case "tags":
        return t("manage.sections.tags");
      case "files":
        return t("manage.sections.files");
      case "bundle":
        return t("manage.sections.bundle");
      case "servers":
        return t("manage.sections.servers");
      case "team":
        return t("manage.sections.team");
      case "admin":
        return t("manage.sections.admin");
    }
  };
}

/** The sections whose fields a check stopped. */
function troubled(problems: DraftProblems): Set<ManageSection> {
  const found = new Set<ManageSection>();
  if (problems.name || problems.tagline || problems.description || problems.rules) found.add("profile");
  if (problems.website || problems.discord || Object.keys(problems.links).length > 0) found.add("links");
  if (Object.keys(problems.files).length > 0) found.add("files");
  if (problems.bundle) found.add("bundle");
  if (Object.keys(problems.labels).length > 0) found.add("servers");
  return found;
}

/** The sections of the fields the form changed. */
function edited(base: ManageDraft, draft: ManageDraft): Set<ManageSection> {
  const found = new Set<ManageSection>();
  if (changed(base, draft, "name") || changed(base, draft, "tagline") || changed(base, draft, "description") || changed(base, draft, "rules")) {
    found.add("profile");
  }
  if (changed(base, draft, "logo") || changed(base, draft, "banner")) found.add("images");
  if (changed(base, draft, "website") || changed(base, draft, "discord") || changed(base, draft, "links")) found.add("links");
  if (changed(base, draft, "tags") || changed(base, draft, "languages") || changed(base, draft, "region")) found.add("tags");
  if (changed(base, draft, "files")) found.add("files");
  if (changed(base, draft, "bundleId")) found.add("bundle");
  if (labelChanges(base, draft).length > 0) found.add("servers");
  return found;
}

/**
 * How far from the top of the window a section counts as the one being read:
 * the title bar of the launcher, the sticky navigation's offset and a line of
 * the section itself.
 */
const SECTION_LINE = 140;

function scrollToSection(section: ManageSection) {
  const element = document.getElementById(sectionId(section));
  if (!element) return;
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
}

function ManageBody({
  community,
  section,
  back,
  setCommunity,
  onDeleted,
}: {
  community: Community;
  section?: ManageSection;
  back: ReactNode;
  setCommunity: (community: Community) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const sectionLabel = useSectionLabel();
  const [form, dispatch] = useReducer(formReducer, community, formOf);
  const [conflict, setConflict] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [active, setActive] = useState<ManageSection>(section ?? "profile");
  const save = useAction();
  const reload = useAction();
  const discord = useRemote(community.discord.trim() !== "" ? `manage-discord:${community.id}:${community.discord}` : null, () =>
    api.discord(community.id),
  );

  const admin = community.viewer?.isAdmin === true;
  const sections = MANAGE_SECTIONS.filter((item) => item !== "admin" || admin);
  const dirty = isDirty(form.base, form.draft);
  const problems = useMemo(() => problemsOf(form.base, form.draft), [form.base, form.draft]);
  const stopped = troubled(problems);
  const changedSections = edited(form.base, form.draft);
  const pending = community.servers.some((server) => !server.verified);

  const edit = useCallback((patch: Partial<ManageDraft>) => {
    setSaved(false);
    dispatch({ type: "edit", patch });
  }, []);

  /** A write of the screen answered with the page after it. */
  const applied = useCallback(
    (next: Community) => {
      setCommunity(next);
      dispatch({ type: "applied", community: next });
    },
    [setCommunity],
  );

  // The route named a section: the screen opens on it.
  useEffect(() => {
    if (!section) return;
    const frame = requestAnimationFrame(() => scrollToSection(section));
    return () => cancelAnimationFrame(frame);
  }, [section]);

  // The navigation follows the section at the top of the window. At the end
  // of the page the last sections never reach the top, and the one picked in
  // the navigation stays marked while it is in sight.
  const picked = useRef<ManageSection | null>(section ?? null);
  const sectionKey = sections.join(",");
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = (name: ManageSection) => document.getElementById(sectionId(name))?.getBoundingClientRect();
      let current = sections[0];
      for (const name of sections) {
        const rect = box(name);
        if (rect && rect.top <= SECTION_LINE) current = name;
      }
      const last = box(sections[sections.length - 1]);
      const chosen = picked.current ? box(picked.current) : undefined;
      if (last && chosen && last.bottom <= window.innerHeight && chosen.top < window.innerHeight && chosen.bottom > 0) {
        current = picked.current!;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    // A scroll of any box reaches a listener of the capture phase: the
    // launcher scrolls its <main>, the website the window.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [sectionKey]);

  const pick = (name: ManageSection) => {
    picked.current = name;
    setActive(name);
    scrollToSection(name);
  };

  const submit = () => {
    setSaveError(null);
    setConflict(false);
    setSaved(false);
    if (hasProblems(problems)) {
      setChecked(true);
      const first = sections.find((name) => stopped.has(name));
      if (first) pick(first);
      return;
    }
    setChecked(false);
    const { base, draft, revision } = form;
    const pagePart = pagePatch(base, draft, revision);
    const imagesPart = imagesPatch(base, draft);
    const labels = labelChanges(base, draft);
    void save.run(
      async () => {
        if (pagePart) {
          try {
            applied(await api.update(community.id, pagePart));
          } catch (reason) {
            if (failureOf(reason).code === "conflict") {
              setConflict(true);
              return;
            }
            throw reason;
          }
        }
        if (imagesPart) applied(await api.images(community.id, imagesPart));
        for (const label of labels) {
          applied(await api.updateServer(community.id, label.serverId, { label: label.label === "" ? null : label.label }));
        }
        setSaved(true);
      },
      (reason) => setSaveError(failure(reason)),
    );
  };

  const reloadPage = () =>
    reload.run(
      async () => {
        const fresh = await api.get(community.id);
        setCommunity(fresh);
        dispatch({ type: "reset", community: fresh });
        setConflict(false);
        setSaveError(null);
        setChecked(false);
      },
      (reason) => setSaveError(failure(reason)),
    );

  return (
    <div className="flex min-h-full flex-col gap-8">
      {platform.embedded ? null : back}
      <div className="flex flex-wrap items-center gap-x-16 gap-y-12 pb-12">
        <h1 className="min-w-0 flex-1 basis-[360px] text-display-lg text-fg [overflow-wrap:anywhere]">
          {t("manage.title", { name: community.name })}
        </h1>
      </div>
      <div className="grid flex-1 grid-cols-[184px_minmax(0,1fr)] items-start gap-24 @max-[760px]/community:grid-cols-1 @max-[760px]/community:gap-12">
        <nav
          aria-label={t("manage.nav")}
          className="sticky top-24 flex flex-col gap-2 @max-[760px]/community:static @max-[760px]/community:-mx-4 @max-[760px]/community:flex-row @max-[760px]/community:overflow-x-auto @max-[760px]/community:px-4 @max-[760px]/community:pb-4 @max-[760px]/community:[scrollbar-width:thin]"
        >
          {sections.map((name) => {
            const dot = stopped.has(name) ? "danger" : name === "servers" && pending ? "warm" : changedSections.has(name) ? "accent" : null;
            const dotTitle =
              dot === "danger" ? t("manage.problemDot") : dot === "warm" ? t("manage.pendingDot") : dot === "accent" ? t("manage.unsavedDot") : undefined;
            return (
              <a
                key={name}
                href={`#${sectionId(name)}`}
                aria-current={active === name ? "location" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  pick(name);
                }}
                className={cn(
                  "flex min-h-32 shrink-0 items-center gap-8 rounded-md px-12 py-6 text-body-sm-medium select-none",
                  active === name ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
                )}
              >
                <span className="min-w-0 flex-1 @max-[760px]/community:whitespace-nowrap">{sectionLabel(name)}</span>
                {dot ? (
                  <span
                    role="img"
                    aria-label={dotTitle}
                    title={dotTitle}
                    className={cn("size-6 shrink-0 rounded-full", dot === "danger" ? "bg-danger" : dot === "warm" ? "bg-warm" : "bg-accent")}
                  />
                ) : null}
              </a>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-col gap-12">
          <ProfileSection draft={form.draft} problems={problems} edit={edit} />
          <ImagesSection community={community} base={form.base} draft={form.draft} edit={edit} />
          <LinksSection base={form.base} draft={form.draft} problems={problems} edit={edit} discord={discord} />
          <TagsSection draft={form.draft} edit={edit} />
          <FilesSection draft={form.draft} problems={problems} edit={edit} />
          <BundleSection community={community} base={form.base} draft={form.draft} problems={problems} edit={edit} />
          <ServersSection community={community} draft={form.draft} problems={problems} edit={edit} onApplied={applied} />
          <TeamSection
            community={community}
            onApplied={applied}
            onLeft={() => platform.navigate({ view: "community", id: community.id, tab: "overview" })}
            onAssignOwner={() => pick("admin")}
          />
          {admin ? <AdminSection community={community} onApplied={applied} onDeleted={onDeleted} /> : null}

          <div role="region" aria-label={t("manage.save.region")} className="sticky bottom-0 z-10 mt-auto flex flex-col gap-8 bg-app pt-12 pb-16">
            {conflict ? (
              <div role="alert" className="flex flex-wrap items-start gap-10 rounded-md border border-line-danger bg-danger-subtle px-12 py-8">
                <AlertTriangle size={16} className="mt-2 shrink-0 text-fg-danger" aria-hidden="true" />
                <p className="min-w-0 flex-1 basis-[240px] text-body-sm text-fg">{t("manage.save.conflict")}</p>
                <Button size="sm" wrap disabled={reload.busy} onClick={() => void reloadPage()}>
                  {t("manage.save.reload")}
                </Button>
              </div>
            ) : null}
            {checked && hasProblems(problems) ? (
              <p role="alert" className="rounded-md border border-line-danger bg-danger-subtle px-12 py-8 text-body-sm text-fg">
                {t("manage.save.problems")}
              </p>
            ) : null}
            {saveError ? (
              <p role="alert" className="rounded-md border border-line-danger bg-danger-subtle px-12 py-8 text-body-sm text-fg [overflow-wrap:anywhere]">
                {t("manage.save.failed", { reason: saveError })}
              </p>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-8 rounded-lg border border-line-strong bg-surface py-10 pr-12 pl-16 shadow-card">
              <span
                role="status"
                className={cn("flex min-w-0 flex-1 basis-[200px] items-center gap-8 text-body-sm-medium", dirty ? "text-fg-warm" : "text-fg-secondary")}
              >
                <span className="size-8 shrink-0 rounded-full bg-current" aria-hidden="true" />
                {save.busy ? t("manage.save.saving") : dirty ? t("manage.save.dirty") : saved ? t("manage.save.saved") : t("manage.save.clean")}
              </span>
              {/* The two buttons keep together at the end, on a line of their own when the state text needs the first. */}
              <span className="ml-auto flex flex-wrap justify-end gap-8">
                <Button
                  variant="ghost"
                  wrap
                  disabled={!dirty || save.busy}
                  onClick={() => {
                    dispatch({ type: "discard" });
                    setChecked(false);
                    setSaveError(null);
                    setConflict(false);
                  }}
                >
                  {t("manage.save.discard")}
                </Button>
                <Button variant="primary" wrap disabled={!dirty || save.busy} onClick={submit}>
                  {t("manage.save.save")}
                </Button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

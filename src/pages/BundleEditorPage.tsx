import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Eye,
  FileText,
  Files,
  FlaskConical,
  Info,
  Layers,
  Loader2,
  Upload,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { COMPONENT_TABS, ComponentEditor, type ComponentTab } from "../components/bundles/editor/ComponentEditor";
import { ComponentsSection } from "../components/bundles/editor/ComponentsSection";
import { ConfigsTab } from "../components/bundles/editor/ConfigsTab";
import { FilesTab } from "../components/bundles/editor/FilesTab";
import { OverviewSection } from "../components/bundles/editor/OverviewSection";
import { PreviewSection } from "../components/bundles/editor/PreviewSection";
import { PublishSection } from "../components/bundles/editor/PublishSection";
import { TestLocallyDialog } from "../components/bundles/editor/TestLocallyDialog";
import { EngineLogo } from "../components/EngineLogo";
import { useEngineName } from "../components/bundles/bundleFiles";
import { Page } from "../components/PageHeader";
import { Button, Dialog, EmptyState } from "../components/ui";
import { useErrorText } from "../i18n/errors";
import { bundleJobs, useBundlePublishJob } from "../lib/bundleJobs";
import { bundlesTabRoute } from "../lib/bundleRoutes";
import { cn } from "../lib/format";
import { useGameNames } from "../lib/game";
import { SHARED_SCOPE } from "../lib/ipc";
import {
  useAccountState,
  useBundleDraft,
  useDraftActions,
  useDraftIssues,
  useDraftSaveState,
  usePublishBundleDraft,
} from "../lib/queries";

/** The search parameters that keep the place in the editor across a reload. */
const SECTION_PARAM = "section";
const TAB_PARAM = "tab";

/** Where the editor is: a fixed section, or the page of one component. */
type Section =
  | { kind: "overview" }
  | { kind: "components" }
  | { kind: "component"; id: string }
  | { kind: "sharedFiles" }
  | { kind: "sharedConfigs" }
  | { kind: "preview" }
  | { kind: "publish" };

const FIXED: Record<string, Section> = {
  overview: { kind: "overview" },
  components: { kind: "components" },
  "shared-files": { kind: "sharedFiles" },
  "shared-configs": { kind: "sharedConfigs" },
  preview: { kind: "preview" },
  publish: { kind: "publish" },
};

function parseSection(value: string | null): Section {
  if (value === null) return { kind: "overview" };
  if (value.startsWith("component:")) return { kind: "component", id: value.slice("component:".length) };
  return FIXED[value] ?? { kind: "overview" };
}

function sectionParam(section: Section): string {
  switch (section.kind) {
    case "component":
      return `component:${section.id}`;
    case "sharedFiles":
      return "shared-files";
    case "sharedConfigs":
      return "shared-configs";
    default:
      return section.kind;
  }
}

/**
 * --- slice: bundles ---
 *
 * The editor of one draft, `#/bundles/drafts/<id>`.
 *
 * A page of its own with a navigation column on the left: the fixed
 * sections, then a line per component, then the shared parts, the preview
 * and the publish. Every edit is a command that writes the draft on disk and
 * answers with it, so the header says **Saved** after each and there is no
 * **Save** button; the header also holds **Test locally** and **Publish**,
 * which the **Publish** section repeats under the checks. The place in the
 * editor lives in the search parameters, so a reload lands on the same tab.
 */
export function BundleEditorPage() {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const { label: gameName } = useGameNames();
  const engineName = useEngineName();
  const account = useAccountState();
  const draftId = id === "" ? null : id;

  const draft = useBundleDraft(draftId);
  const actions = useDraftActions(id);
  const issues = useDraftIssues(draftId);
  const publish = usePublishBundleDraft();
  const job = useBundlePublishJob(draftId);

  const [search, setSearch] = useSearchParams();
  const section = parseSection(search.get(SECTION_PARAM));
  const tabParam = search.get(TAB_PARAM);
  const tab: ComponentTab = COMPONENT_TABS.includes(tabParam as ComponentTab) ? (tabParam as ComponentTab) : "engine";
  const go = (next: Section, nextTab?: ComponentTab) =>
    setSearch(
      (current) => {
        const params = new URLSearchParams(current);
        params.set(SECTION_PARAM, sectionParam(next));
        if (nextTab) params.set(TAB_PARAM, nextTab);
        else params.delete(TAB_PARAM);
        return params;
      },
      { replace: true },
    );

  const [testOpen, setTestOpen] = useState(false);
  const [signInPrompt, setSignInPrompt] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // What the header says about the edits: saving, saved, or not saved with
  // the reason. Read off the mutation cache, so a section does not have to
  // report and no press is missed.
  const saveState = useDraftSaveState(id);
  const saveError = saveState.error === null ? null : errorText(saveState.error);

  const signedIn = account.data?.onlineSignedIn === true;
  const blocked = issues.data === undefined || issues.data.errors.length > 0;
  const running = job?.phase === "running";

  const runPublish = () => {
    if (!draft.data) return;
    if (!signedIn) {
      setSignInPrompt(true);
      return;
    }
    setFailure(null);
    publish.mutate(draft.data.id, { onError: (e) => setFailure(errorText(e)) });
  };

  const openTest = () => {
    if (issues.data === undefined || issues.data.errors.length > 0) {
      go({ kind: "publish" });
      return;
    }
    setTestOpen(true);
  };

  if (draft.error) {
    return (
      <Page>
        <EmptyState
          icon={<AlertTriangle size={24} />}
          title={t("editor.notFoundTitle")}
          text={errorText(draft.error)}
          action={
            <Button icon={<ArrowLeft size={16} />} onClick={() => void navigate(bundlesTabRoute())}>
              {t("editor.back")}
            </Button>
          }
        />
      </Page>
    );
  }

  const record = draft.data;
  if (!record) {
    return (
      <Page>
        <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
      </Page>
    );
  }

  const current =
    section.kind === "component"
      ? (record.components.find((component) => component.id === section.id) ?? null)
      : null;

  return (
    <Page>
      {/* The head: the way back, the name, the state of the last edit, the two buttons. */}
      <div className="flex flex-wrap items-start gap-16 pb-24">
        <div className="flex-1 basis-[260px] min-w-0 flex flex-col gap-4">
          <button
            type="button"
            onClick={() => void navigate(bundlesTabRoute())}
            className="inline-flex items-center gap-4 text-body-sm text-fg-muted hover:text-fg cursor-pointer select-none self-start"
          >
            <ArrowLeft size={14} aria-hidden />
            {t("editor.back")}
          </button>
          <h1 className="text-display-lg text-fg truncate" title={record.name}>
            {record.name}
          </h1>
          <p className="flex flex-wrap items-center gap-8 text-body-md text-fg-secondary">
            <span>{gameName(record.game)}</span>
            <span aria-hidden="true">·</span>
            <span>{t("drafts.components", { count: record.components.length })}</span>
            {record.bundleId ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{t("editor.linkedShort")}</span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <SaveState saving={saveState.saving} saved={saveState.saved} error={saveError} />
          </p>
        </div>
        {/* --- slice: chat layout --- wraps like the buttons of `PageHeader`. */}
        <div className="flex flex-wrap items-center justify-end gap-8 pt-4 ml-auto">
          <Button icon={<FlaskConical size={16} />} disabled={blocked || running} onClick={openTest}>
            {t("editor.testLocally")}
          </Button>
          <Button
            variant="primary"
            icon={<Upload size={16} />}
            disabled={blocked || running}
            onClick={runPublish}
          >
            {running
              ? t("editor.publish.publishing")
              : record.bundleId
                ? t("editor.publishUpdate")
                : t("editor.publish.button")}
          </Button>
        </div>
      </div>

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      {/* --- slice: chat layout --- on a narrow page (the chat drawer pinned,
          `AppShell`) the navigation wraps above the section instead of
          taking 232 px beside it. */}
      <div className="flex items-start gap-24 @max-[760px]/page:flex-col @max-[760px]/page:items-stretch @max-[760px]/page:gap-16">
        {/* The navigation column: the same width and the same lines as the sidebar. */}
        <nav
          className="w-232 shrink-0 flex flex-col gap-4 @max-[760px]/page:w-auto @max-[760px]/page:flex-row @max-[760px]/page:flex-wrap"
          aria-label={t("editor.sections")}
        >
          <NavLine
            icon={<Info size={16} />}
            label={t("editor.nav.overview")}
            active={section.kind === "overview"}
            onClick={() => go({ kind: "overview" })}
          />
          <NavLine
            icon={<Layers size={16} />}
            label={t("editor.nav.components")}
            count={record.components.length}
            active={section.kind === "components"}
            onClick={() => go({ kind: "components" })}
          />
          {record.components.map((component) => (
            <NavLine
              key={component.id}
              icon={<EngineLogo engineId={component.engineId} name={engineName(component.engineId)} size={16} />}
              label={component.label}
              nested
              active={section.kind === "component" && section.id === component.id}
              onClick={() => go({ kind: "component", id: component.id }, tab)}
            />
          ))}
          <NavLine
            icon={<Files size={16} />}
            label={t("editor.nav.sharedFiles")}
            count={record.shared.files.length}
            active={section.kind === "sharedFiles"}
            onClick={() => go({ kind: "sharedFiles" })}
          />
          <NavLine
            icon={<FileText size={16} />}
            label={t("editor.nav.sharedConfigs")}
            count={record.shared.configs.length}
            active={section.kind === "sharedConfigs"}
            onClick={() => go({ kind: "sharedConfigs" })}
          />
          <NavLine
            icon={<Eye size={16} />}
            label={t("editor.nav.preview")}
            active={section.kind === "preview"}
            onClick={() => go({ kind: "preview" })}
          />
          <NavLine
            icon={<Upload size={16} />}
            label={t("editor.nav.publish")}
            count={issues.data ? issues.data.errors.length + issues.data.warnings.length : undefined}
            active={section.kind === "publish"}
            onClick={() => go({ kind: "publish" })}
          />
        </nav>

        {/* The sections that hold what is typed and not yet committed are
            keyed by the draft: a switch to another draft, whichever route
            it comes by, mounts them afresh rather than carrying a field or a
            pending commit of the description over. */}
        <div className="flex-1 min-w-0">
          {section.kind === "overview" ? (
            <OverviewSection key={record.id} draft={record} actions={actions} />
          ) : section.kind === "components" ? (
            <ComponentsSection
              key={record.id}
              draft={record}
              actions={actions}
              onOpen={(componentId) => go({ kind: "component", id: componentId }, "engine")}
            />
          ) : section.kind === "component" ? (
            current ? (
              <ComponentEditor
                key={`${record.id}:${current.id}`}
                draft={record}
                component={current}
                actions={actions}
                tab={tab}
                onTab={(next) => go(section, next)}
                onRemoved={() => go({ kind: "components" })}
              />
            ) : (
              <EmptyState
                icon={<AlertTriangle size={24} />}
                title={t("editor.componentGoneTitle")}
                text={t("editor.componentGoneText")}
                action={<Button onClick={() => go({ kind: "components" })}>{t("editor.nav.components")}</Button>}
              />
            )
          ) : section.kind === "sharedFiles" ? (
            <div className="flex flex-col gap-12">
              <h2 className="text-heading-sm text-fg">{t("editor.nav.sharedFiles")}</h2>
              <FilesTab key={`${record.id}:${SHARED_SCOPE}`} draft={record} scope={SHARED_SCOPE} actions={actions} />
            </div>
          ) : section.kind === "sharedConfigs" ? (
            <div className="flex flex-col gap-12">
              <h2 className="text-heading-sm text-fg">{t("editor.nav.sharedConfigs")}</h2>
              <ConfigsTab key={`${record.id}:${SHARED_SCOPE}`} draft={record} scope={SHARED_SCOPE} actions={actions} />
            </div>
          ) : section.kind === "preview" ? (
            <PreviewSection draft={record} />
          ) : (
            <PublishSection
              key={record.id}
              draft={record}
              actions={actions}
              issues={issues.data}
              loading={issues.isLoading}
              error={issues.error}
              job={job}
              signedIn={signedIn}
              onTest={() => setTestOpen(true)}
              onPublish={runPublish}
              onRetry={runPublish}
              onStartOver={() => bundleJobs.forgetPublish(record.id)}
            />
          )}
        </div>
      </div>

      {testOpen ? <TestLocallyDialog draft={record} onClose={() => setTestOpen(false)} /> : null}

      {signInPrompt ? (
        <Dialog
          title={t("publish.signInTitle")}
          body={t("publish.signInText")}
          onClose={() => setSignInPrompt(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setSignInPrompt(false)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="primary"
                // Straight to the Account card, the way the Friends screen
                // sends a signed-out player: the card is what signs in.
                onClick={() => void navigate("/settings?section=account")}
              >
                {t("publish.signIn")}
              </Button>
            </>
          }
        />
      ) : null}
    </Page>
  );
}

/** «Saving…», «Saved» or «Not saved: reason», in the subtitle of the page. */
function SaveState({ saving, saved, error }: { saving: boolean; saved: boolean; error: string | null }) {
  const { t } = useTranslation("bundles");
  if (saving) {
    return (
      <span className="inline-flex items-center gap-4 text-fg-muted">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        {t("editor.saving")}
      </span>
    );
  }
  if (error !== null) {
    return (
      <span role="alert" className="inline-flex items-center gap-4 text-fg-danger">
        <AlertTriangle size={14} aria-hidden />
        {t("editor.notSaved", { reason: error })}
      </span>
    );
  }
  if (saved) {
    return (
      <span role="status" className="inline-flex items-center gap-4 text-fg-success">
        <Check size={14} aria-hidden />
        {t("editor.saved")}
      </span>
    );
  }
  return <span className="text-fg-muted">{t("editor.autosave")}</span>;
}

/** One line of the navigation column, in the shape of the sidebar's `NavItem`. */
function NavLine({
  icon,
  label,
  count,
  nested = false,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  /** A component under **Components**: indented one step. */
  nested?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-12 h-36 px-12 rounded-md select-none cursor-pointer",
        "text-display-nav transition-colors duration-150 text-left",
        // --- slice: chat layout --- no indent where the lines wrap as a row.
        nested && "ml-20 @max-[760px]/page:ml-0",
        active ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
      )}
    >
      <span className={cn("shrink-0", active && "text-fg-accent")}>{icon}</span>
      <span className="flex-1 truncate" title={label}>
        {label}
      </span>
      {count === undefined ? null : <span className="text-mono-xs text-fg-muted">{count}</span>}
    </button>
  );
}

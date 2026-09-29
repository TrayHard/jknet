import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Search } from "lucide-react";
import type { ServerConfigDocument } from "../../lib/ipc";
import { GAMES } from "../../lib/ipc";
import { useGameNames } from "../../lib/game";
import { useServerConfigCheck } from "../../lib/queries";
import { MOD_CATALOG, serverConfigFieldSections, serverConfigFields, type ServerConfigField } from "../../lib/serverConfigCatalog";
import { removeServerConfigValue, serverConfigValues, setServerConfigValue } from "../../lib/serverConfig";
import { useErrorText } from "../../i18n/errors";
import { ConfigCodeEditor } from "../ConfigCodeEditor";
import { Tabs } from "../servers/Tabs";
import { Badge, Button, Input, Select, Toggle } from "../ui";

/** The same editor is used for library documents and configs received in chat. */
export function ServerConfigEditor({ draft, onChange }: {
  draft: ServerConfigDocument;
  onChange: (document: ServerConfigDocument) => void;
}) {
  const { t } = useTranslation("serverConfigs");
  const { t: tFields } = useTranslation("serverConfigFields");
  const errorText = useErrorText();
  const gameNames = useGameNames();
  const [mode, setMode] = useState<"fields" | "text">("fields");
  const [search, setSearch] = useState("");
  const [checkedDraft, setCheckedDraft] = useState(draft);
  useEffect(() => {
    const timer = window.setTimeout(() => setCheckedDraft(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const check = useServerConfigCheck(checkedDraft);
  const currentCheck = checkedDraft === draft ? check.data : undefined;
  const notices = currentCheck?.notices ?? [];
  const managed = [...new Set(notices.filter(notice => notice.kind === "managed_setting").map(notice => notice.name))];
  const rotation = [...new Set(notices.filter(notice => notice.kind === "map_rotation").map(notice => notice.name))];
  const unsupported = [...new Set(notices.filter(notice => notice.kind === "unsupported_command").map(notice => notice.name))];
  const fieldSections = serverConfigFieldSections(draft.game, draft.modId);
  const fields = serverConfigFields(draft.game, draft.modId);
  const localePrefix = `${draft.game}.${draft.modId}`;
  const directValues = useMemo(() => serverConfigValues(draft.text), [draft.text]);
  const values = useMemo(() => {
    const effective = new Map(directValues);
    if (!effective.has("map") && currentCheck?.settings.map) effective.set("map", currentCheck.settings.map);
    return effective;
  }, [currentCheck?.settings.map, directValues]);
  const mods = MOD_CATALOG.filter(mod => mod.games.includes(draft.game));
  const selectedMod = mods.find(mod => mod.id === draft.modId);
  const filterFields = (sectionFields: ServerConfigField[], prefix: string) => sectionFields.filter(field =>
    `${field.name} ${tFields(`${prefix}.labels.${field.name}` as never, { defaultValue: field.label })}`.toLowerCase().includes(search.toLowerCase()));
  const commonFields = filterFields(fieldSections.common, `${draft.game}.base`);
  const modFields = filterFields(fieldSections.mod, localePrefix);
  return (
    <div className="@container/server-config flex min-w-0 flex-col gap-16">
      <div className="flex flex-wrap items-end gap-16">
        <label className="flex min-w-0 flex-1 basis-240 flex-col gap-6 text-body-sm text-fg-secondary">
          {t("name")}
          <Input value={draft.name} maxLength={240} onChange={event => onChange({ ...draft, name: event.target.value })} />
        </label>
        <div className="flex min-w-0 flex-1 basis-180 flex-col gap-6">
          <span className="text-body-sm text-fg-secondary">{t("game")}</span>
          <Select ariaLabel={t("game")} value={draft.game} options={GAMES.map(game => ({ value: game, label: gameNames.label(game) }))}
            onChange={game => onChange({ ...draft, game: game as ServerConfigDocument["game"], modId: "base" })} />
        </div>
        <div className="flex min-w-0 flex-1 basis-180 flex-col gap-6">
          <span className="text-body-sm text-fg-secondary">{t("mod")}</span>
          <Select ariaLabel={t("mod")} value={draft.modId} options={mods.map(mod => ({ value: mod.id, label: mod.name }))}
            onChange={modId => onChange({ ...draft, modId })} />
        </div>
      </div>
      <p className="text-body-xs text-fg-muted">{t("modHint")}</p>
      {selectedMod?.version ? <p className="text-body-xs text-fg-muted">{t("schemaVersion", { version: selectedMod.version })}</p> : null}
      {notices.length ? (
        <section data-server-config-notices className="rounded-md border border-line bg-input p-12" aria-label={t("ignoredTitle")}>
          <h3 className="text-body-sm-medium text-fg">{t("ignoredTitle")}</h3>
          <p className="mt-4 text-body-xs text-fg-secondary">{t("ignoredHint")}</p>
          <div className="mt-8 flex flex-col gap-6 text-body-sm text-fg-secondary">
            {managed.length ? (
              <details>
                <summary className="cursor-pointer">{t("managedSummary", { count: managed.length })}</summary>
                <p className="mt-4 break-words font-mono text-body-xs text-fg-muted">{managed.join(", ")}</p>
              </details>
            ) : null}
            {rotation.length ? (
              <details>
                <summary className="cursor-pointer">{t("rotationSummary")}</summary>
                <p className="mt-4 break-words font-mono text-body-xs text-fg-muted">{rotation.join(", ")}</p>
              </details>
            ) : null}
            {unsupported.length ? (
              <details>
                <summary className="cursor-pointer">{t("unsupportedSummary", { count: unsupported.length })}</summary>
                <p className="mt-4 break-words font-mono text-body-xs text-fg-muted">{unsupported.join(", ")}</p>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}
      <Tabs value={mode} onChange={setMode} tabs={[{ id: "fields", label: t("fields") }, { id: "text", label: t("text") }]} />
      {mode === "fields" ? (
        <>
          <Input aria-label={t("search")} placeholder={t("search")} icon={<Search size={16} />} value={search} onChange={event => setSearch(event.target.value)} />
          <p className="text-body-xs text-fg-muted">{t("fieldsHint")}</p>
          {commonFields.length ? <FieldCategory title={t("commonSettingsTitle")} fields={commonFields} localePrefix={`${draft.game}.base`}
            values={values} directValues={directValues} draft={draft} onChange={onChange} /> : null}
          {modFields.length && selectedMod ? <FieldCategory title={t("modSettingsTitle", { mod: selectedMod.name })} fields={modFields} localePrefix={localePrefix}
            values={values} directValues={directValues} draft={draft} onChange={onChange} /> : null}
          {!commonFields.length && !modFields.length ? <p className="text-body-sm text-fg-muted">{t("noFields")}</p> : null}
        </>
      ) : (
        <ConfigCodeEditor value={draft.text} onChange={text => onChange({ ...draft, text })} ariaLabel={t("text")}
          marks={currentCheck?.issues} completions={fields.map(field => ({ label: field.name, detail: field.defaultValue }))} />
      )}
      {check.error ? <p role="alert" className="text-body-sm text-fg-danger">{errorText(check.error)}</p> : null}
      {currentCheck?.issues.length ? (
        <section className="rounded-md border border-line-warm bg-surface p-12" aria-label={t("issuesTitle")}>
          <h3 className="text-body-sm-medium text-fg-warm">{t("issuesTitle")}</h3>
          <p className="mt-4 text-body-xs text-fg-secondary">{t("issuesHint")}</p>
          <ul className="mt-8 flex list-disc flex-col gap-4 pl-20 text-body-sm text-fg-secondary">
            {currentCheck.issues.map((issue, index) => <li key={`${issue.line}:${index}`}>{t("issueLine", { line: issue.line, message: issue.message })}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function FieldCategory({ title, fields, localePrefix, values, directValues, draft, onChange }: {
  title: string;
  fields: ServerConfigField[];
  localePrefix: string;
  values: Map<string, string>;
  directValues: Map<string, string>;
  draft: ServerConfigDocument;
  onChange: (document: ServerConfigDocument) => void;
}) {
  const { t: tFields } = useTranslation("serverConfigFields");
  const headingId = `server-config-${localePrefix.replace(/\./g, "-")}`;
  const groups = [...new Set(fields.map(field => field.group))];
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
      <h3 id={headingId} className="text-heading-md text-fg">{title}</h3>
      {groups.map(group => (
        <section key={group} className="flex flex-col gap-12 rounded-md bg-input p-16">
          <h4 className="text-heading-sm text-fg">{tFields(`${localePrefix}.groups.${group}` as never, { defaultValue: group })}</h4>
          <div className="grid grid-cols-1 gap-16 @min-[760px]/server-config:grid-cols-2">
            {fields.filter(field => field.group === group).map(field => (
              <ServerField key={`${draft.game}:${draft.modId}:${field.name}`} field={field} localePrefix={localePrefix} value={values.get(field.name.toLowerCase())}
                derived={field.name === "map" && !directValues.has("map") && values.has("map")}
                onChange={value => onChange({ ...draft, text: setServerConfigValue(draft.text, field.name, value) })}
                onReset={() => onChange({ ...draft, text: removeServerConfigValue(draft.text, field.name) })} />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

function ServerField({ field, value, derived = false, onChange, onReset, localePrefix }: {
  field: ServerConfigField;
  value: string | undefined;
  derived?: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
  localePrefix: string;
}) {
  const { t } = useTranslation("serverConfigs");
  const { t: tFields } = useTranslation("serverConfigFields");
  const shown = value ?? field.defaultValue ?? "";
  const [input, setInput] = useState(shown);
  const [rejected, setRejected] = useState(false);
  useEffect(() => setInput(shown), [shown]);
  const label = tFields(`${localePrefix}.labels.${field.name}` as never, { defaultValue: field.label });
  const invalid = rejected || (field.type === "number" && input !== "" && (!Number.isFinite(Number(input)) ||
    (field.min !== undefined && Number(input) < field.min) || (field.max !== undefined && Number(input) > field.max)));
  const change = (next: string) => {
    if (/["\r\n\u0000]/.test(next)) { setRejected(true); return; }
    setRejected(false);
    setInput(next);
    onChange(next);
  };
  const mask = Number(shown) || 0;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center gap-8">
        <span className="flex-1 text-body-sm-medium text-fg">{label}</span>
        {value !== undefined && !derived ? (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} aria-label={t("resetField", { field: label })} title={t("resetField", { field: label })} onClick={onReset} />
        ) : <Badge>{t(derived ? "rotationValue" : "defaultValue")}</Badge>}
      </div>
      <code className="text-mono-xs text-fg-muted">{field.name}</code>
      {field.type === "boolean" ? (
        <Toggle label={label} checked={shown !== "0" && shown !== ""} onChange={checked => onChange(checked ? "1" : "0")} />
      ) : field.type === "select" ? (
        <Select ariaLabel={label} value={shown} options={[
          ...(field.options?.some(option => option.value === shown) ? [] : [{ value: shown, label: shown || t("notSet") }]),
          ...(field.options ?? []).map(option => ({ value: option.value, label: tFields(`${localePrefix}.options.${field.name}.${option.value}` as never, { defaultValue: option.label }) })),
        ]} onChange={onChange} />
      ) : field.type === "flags" ? (
        <div className="flex flex-col gap-6">
          <Input type="number" min={0} step={1} aria-label={label} value={shown} onChange={event => {
            const next = Number(event.target.value);
            if (Number.isSafeInteger(next) && next >= 0) onChange(String(next));
          }} />
          {(field.flags ?? []).map(flag => {
            const checked = Math.floor(mask / flag.value) % 2 === 1;
            return <label key={flag.value} className="flex items-center gap-8 text-body-xs text-fg-secondary">
              <input type="checkbox" checked={checked} onChange={() => onChange(String(checked ? mask - flag.value : mask + flag.value))} />
              {tFields(`${localePrefix}.flags.${field.name}.${flag.value}` as never, { defaultValue: flag.label })}
            </label>;
          })}
        </div>
      ) : (
        <Input type={field.type === "number" ? "number" : "text"} min={field.min} max={field.max} aria-label={label} value={input} invalid={invalid} onChange={event => change(event.target.value)} />
      )}
      {invalid ? <p role="alert" className="text-body-xs text-fg-danger">{t("invalidField")}</p> : null}
      {field.description ? <p className="text-body-xs text-fg-muted">{tFields(`${localePrefix}.descriptions.${field.name}` as never, { defaultValue: field.description })}</p> : null}
    </div>
  );
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  Plus,
  Code2,
  SlidersHorizontal,
  FilePlus2,
} from "lucide-react";
import { Badge, Button, Input, Select } from "./ui";
import { ConfigCodeEditor } from "./ConfigCodeEditor";
import {
  catalog,
  configAssignments,
  CONFIG_TEMPLATES,
  scriptIssues,
  setConfigValue,
} from "../lib/configScript";
import { configBinds } from "../lib/quakeConfig";

export function ConfigStudio({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  const { t } = useTranslation("common");
  const [tab, setTab] = useState("settings"),
    [query, setQuery] = useState(""),
    [group, setGroup] = useState(""),
    [error, setError] = useState("");
  const assignments = configAssignments(value),
    issues = scriptIssues(value);
  const change = (name: string, next: string) => {
    try {
      if (assignments.get(name.toLowerCase()) !== next)
        onChange(setConfigValue(value, name, next));
      setError("");
    } catch {
      setError(t("configStudio.invalidValue"));
    }
  };
  const visible = catalog.filter(
    (c) =>
      (!group || c.group === group) &&
      (!query ||
        `${c.name} ${t(`configStudio.cvars.${c.name}`, { defaultValue: c.name })}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  return (
    <div className="min-w-0 flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        {[
          ["settings", SlidersHorizontal],
          ["script", Code2],
          ["templates", FilePlus2],
        ].map(([id, Icon]) => (
          <Button
            key={id as string}
            size="sm"
            variant={tab === id ? "primary" : "ghost"}
            icon={typeof Icon !== "string" ? <Icon size={14} /> : undefined}
            onClick={() => setTab(id as string)}
          >
            {t(`configStudio.${id}`, { defaultValue: String(id) })}
          </Button>
        ))}
        <div className="ml-auto flex gap-6">
          <Badge>
            {t("configStudio.settingCount", { count: assignments.size })}
          </Badge>
          <Badge>
            {t("configStudio.bindCount", { count: configBinds(value).length })}
          </Badge>
        </div>
      </div>
      {tab === "script" ? (
        <>
          <ConfigCodeEditor value={value} onChange={onChange} />
          <p className="text-body-xs text-fg-muted">
            {t("configStudio.shortcuts")}
          </p>
          <div className="flex flex-wrap gap-6">
            {[...assignments.keys()].map((name) => (
              <Badge key={name}>{name}</Badge>
            ))}
          </div>
          {issues.length ? (
            <details className="rounded-md border border-line-warm px-12 py-8">
              <summary className="cursor-pointer text-body-sm text-fg-warm">
                {t("configStudio.diagnostics", { count: issues.length })}
              </summary>
              <ul className="mt-8 flex flex-col gap-4 text-body-xs text-fg-secondary">
                {issues.map((issue, i) => (
                  <li key={i}>
                    {issue.line}:{" "}
                    {t(`configStudio.issue_${issue.kind}`, {
                      value: issue.value,
                    })}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
      {tab === "settings" ? (
        <>
          <div className="flex gap-8">
            <Input
              className="flex-1"
              icon={<Search size={14} />}
              aria-label={t("configStudio.search")}
              placeholder={t("configStudio.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select
              className="w-160"
              ariaLabel={t("configStudio.group")}
              value={group}
              onChange={setGroup}
              options={[
                { value: "", label: t("configStudio.all") },
                ...["input", "network", "graphics", "hud", "audio"].map(
                  (value) => ({
                    value,
                    label: t(`configStudio.group_${value}`, {
                      defaultValue: value,
                    }),
                  }),
                ),
              ]}
            />
          </div>
          <p className="text-body-xs text-fg-muted">
            {t("configStudio.defaultsHint")}
          </p>
          <div className="max-h-440 overflow-y-auto rounded-md border border-line divide-y divide-line">
            {visible.map((c) => {
              const current = assignments.get(c.name.toLowerCase());
              return (
                <div
                  key={c.name}
                  className="flex items-center gap-12 px-12 py-10"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-body-sm text-fg">
                      {t(`configStudio.cvars.${c.name}`, {
                        defaultValue: c.name,
                      })}
                    </p>
                    <p className="text-mono-xs text-fg-muted">
                      {c.name}{" "}
                      <span className="opacity-60">
                        ·{" "}
                        {t("configStudio.defaultValue", {
                          value: c.defaultValue,
                        })}
                      </span>
                    </p>
                  </div>
                  {current === undefined ? (
                    <Badge>{t("configStudio.inherited")}</Badge>
                  ) : (
                    <Badge tone="accent">{t("configStudio.override")}</Badge>
                  )}
                  <Input
                    key={`${c.name}-${current}`}
                    className="w-120"
                    aria-label={c.name}
                    defaultValue={current ?? c.defaultValue}
                    onBlur={(e) => {
                      if (e.target.value !== (current ?? c.defaultValue))
                        change(c.name, e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        change(c.name, e.currentTarget.value);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("configStudio.addSetting", { name: c.name })}
                    title={t("configStudio.addSetting", { name: c.name })}
                    onClick={() => change(c.name, c.defaultValue)}
                    icon={<Plus size={14} />}
                  />
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {tab === "templates" ? (
        <div className="grid grid-cols-2 gap-12">
          {Object.entries(CONFIG_TEMPLATES).map(([id, text]) => (
            <article
              key={id}
              className="flex flex-col gap-12 rounded-lg border border-line bg-input p-16"
            >
              <div>
                <h3 className="text-body-md text-fg">
                  {t(`configStudio.template_${id}`, { defaultValue: id })}
                </h3>
                <p className="text-body-xs text-fg-muted mt-4">
                  {t(`configStudio.templateHint_${id}`, { defaultValue: id })}
                </p>
              </div>
              <pre className="text-mono-xs text-fg-secondary whitespace-pre-wrap flex-1">
                {text}
              </pre>
              <div>
                <Button
                  size="sm"
                  icon={<Plus size={14} />}
                  onClick={() => onChange(`${value.trimEnd()}\n\n${text}`)}
                >
                  {t("configStudio.insertTemplate")}
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

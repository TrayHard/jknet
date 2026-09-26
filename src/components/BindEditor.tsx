import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfigActions, useProfiles } from "../lib/queries";
import { appendBind, configBinds, effectiveBinds, type BindSource } from "../lib/quakeConfig";
import type { ConfigDocument } from "../lib/ipc";
import { Badge, Button, Input, Select } from "./ui";
import { BindKeyboard } from "./BindKeyboard";
import { VstrChainPanel } from "./VstrChainPanel";
import { ColoredNickname } from "./client/ColoredNickname";
import { useErrorText } from "../i18n/errors";
import { runsVstr } from "../lib/vstrChain";
// --- slice: chat cards ---
import { Share2 } from "lucide-react";
import { bindCard } from "../lib/chat/cardDrafts";
import { useShareDialog } from "./chat/ShareToChatDialog";

export function BindEditor({
  text,
  onChange,
  clientId,
  configs,
  sources,
  loading,
  unavailable,
  unresolved,
  previewOnly,
}: {
  text: string;
  onChange: (text: string) => void;
  clientId: string;
  configs: ConfigDocument[];
  sources: BindSource[];
  loading: boolean;
  unavailable: boolean;
  unresolved: string[];
  previewOnly: boolean;
}) {
  const { t } = useTranslation("common"),
    errorText = useErrorText();
  const { t: tChat } = useTranslation("chat"),
    share = useShareDialog();
  const profiles = useProfiles(clientId),
    actions = useConfigActions();
  const [key, setKey] = useState("F1"),
    [mode, setMode] = useState("phrase"),
    [phrase, setPhrase] = useState(""),
    [channel, setChannel] = useState("say"),
    [command, setCommand] = useState(""),
    [profileId, setProfileId] = useState(""),
    [configId, setConfigId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [outlined, setOutlined] = useState<string[]>([]);
  const bindings = effectiveBinds(sources);
  const existing = bindings.find(binding => binding.key === key);
  const inherited = effectiveBinds(sources.filter(source => source.kind !== "edited")).find(binding => binding.key === key);
  const existingCommand = existing?.command ?? "";
  // The typed command wins over the key's binding, so the tree previews it before Set binding.
  const chainCommand = mode === "command" ? command.trim() || existingCommand : "";
  const showChain = runsVstr(chainCommand);
  useEffect(() => {
    setPhrase(""); setCommand(""); setProfileId(""); setConfigId(""); setError(null);
    if (/^say(?:_team)? /.test(existingCommand)) {
      setMode("phrase");
      setChannel(existingCommand.startsWith("say_team ") ? "say_team" : "say");
      setPhrase(existingCommand.replace(/^say(?:_team)? /, ""));
    } else { setMode(existingCommand ? "command" : "phrase"); setCommand(existingCommand); }
  }, [key, existingCommand]);
  const write = (command: string) => {
    try {
      onChange(appendBind(text, key, command));
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  const bind = () => {
    if (mode === "profile")
      actions.bind.mutate(
        { clientId, profileId, configId: configId || null },
        { onSuccess: write },
      );
    else write(mode === "phrase" ? `${channel} ${phrase}` : command);
  };
  const pick = (key: string) => {
    setKey(key);
  };
  return (
    <div className="flex flex-col gap-12">
      {loading || unavailable ? <p role="status" className="text-body-sm text-fg-warm">{t(loading ? "configs.loadingDefaults" : "configs.defaultsUnavailable")}</p> : null}
      {unresolved.length > 0 ? <p className="text-body-xs text-fg-warm">{t("configs.unresolvedDefaults", { sources: [...new Set(unresolved)].join(", ") })}</p> : null}
      {previewOnly ? <p className="text-body-xs text-fg-muted">{t("configs.bindPreviewHint")}</p> : null}
      <BindKeyboard value={key} bindings={bindings} onChange={pick} outlined={showChain ? outlined : []} />
      <div className="rounded-lg border border-line p-16 flex flex-col gap-12">
        <div className="flex flex-col gap-4 text-body-sm">
          <span className="flex flex-wrap items-center gap-x-8 text-fg-secondary">
            <span>{key}: <code className="text-fg">{existing?.command || t("configStudio.free")}</code></span>
            {/* --- slice: chat cards --- the binding of this key, as a bind card. */}
            {share.available && existing?.command ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={<Share2 size={14} />}
                onClick={() => share.open({ kind: "card", card: bindCard([{ key, command: existing.command }]) })}
              >
                {tChat("share.action")}
              </Button>
            ) : null}
          </span>
          {existing ? <span className="text-body-xs text-fg-muted break-all">{t("configs.bindingSource", { source: existing.source })}</span> : null}
          {existing?.kind === "layer" ? <span className="text-body-xs text-fg-warm">{t("configs.layerOverrideHint")}</span> : null}
        </div>
        <div className="flex flex-wrap gap-8">
          <Badge tone="accent" className="h-28">
            {key}
          </Badge>
          {(["phrase", "command", "profile"] as const).map((value) => (
            <Button
              type="button"
              size="sm"
              key={value}
              variant={mode === value ? "primary" : "ghost"}
              onClick={() => setMode(value)}
            >
              {t(`configs.bind_${value}`)}
            </Button>
          ))}
        </div>
        {mode === "phrase" ? (
          <>
            <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-12">
              <Select
                ariaLabel={t("configs.channel")}
                value={channel}
                onChange={setChannel}
                options={[
                  { value: "say", label: t("configs.say") },
                  { value: "say_team", label: t("configs.sayTeam") },
                ]}
              />
              <Input
                aria-label={t("configs.phrase")}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-6">
              {Array.from({ length: 8 }, (_, i) => (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  key={i}
                  aria-label={`^${i}`}
                  onClick={() => setPhrase((value) => `${value}^${i}`)}
                >
                  <ColoredNickname raw={`^${i}●`} placeholder="" />
                  {`^${i}`}
                </Button>
              ))}
            </div>
            <div className="rounded-md bg-input p-12 min-h-48 text-body-md">
              <ColoredNickname
                raw={phrase}
                placeholder={t("configs.phrasePreview")}
              />
            </div>
          </>
        ) : mode === "command" ? (
          <>
            <label className="text-body-sm text-fg-secondary">
              {t("configs.command")}
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </label>
            {showChain ? (
              <VstrChainPanel
                key={key}
                sources={sources}
                keyName={key}
                command={chainCommand}
                readOnly={false}
                onChange={onChange}
                onKeyChange={setKey}
                onOutline={setOutlined}
              />
            ) : null}
          </>
        ) : (
          <>
            <Select
              ariaLabel={t("configs.playerProfile")}
              value={profileId}
              onChange={setProfileId}
              options={(profiles.data?.profiles ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
            />
            <Select
              ariaLabel={t("configs.bindSet")}
              value={configId}
              onChange={setConfigId}
              options={[
                { value: "", label: t("configs.noBindSet") },
                ...configs.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            <p className="text-body-xs text-fg-muted">
              {t("configs.profileSnapshot")}
            </p>
          </>
        )}
        <div className="flex items-center gap-8">
          <Button
            type="button"
            variant="primary"
            disabled={
              !key.trim() ||
              actions.bind.isPending ||
              (mode === "profile" && !profileId) ||
              (mode === "phrase" && !phrase.trim()) ||
              (mode === "command" && !command.trim())
            }
            onClick={bind}
          >
            {t("configs.setBind")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => write("")}
            disabled={!existing}
          >
            {t("configs.unbind")}
          </Button>
          {inherited && <Button variant="ghost" onClick={() => write(inherited.command)} disabled={existing?.command === inherited.command}>{t("configs.restoreBind")}</Button>}
        </div>
        {error || actions.bind.error ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {errorText(error ?? actions.bind.error)}
          </p>
        ) : null}
      </div>
      <details>
      <summary className="cursor-pointer text-body-sm text-fg-secondary">{t("configs.documentBinds", { count: configBinds(text).length })}</summary>
      <div className="grid grid-cols-2 gap-8 mt-8">
        {configBinds(text).map((b) => (
          <div
            key={b.key}
            className="flex gap-8 items-center rounded-md border border-line p-8"
          >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setKey(b.key);
                if (/^say(?:_team)? /.test(b.command)) {
                  setMode("phrase");
                  setChannel(
                    b.command.startsWith("say_team ") ? "say_team" : "say",
                  );
                  setPhrase(b.command.replace(/^say(?:_team)? /, ""));
                } else {
                  setMode("command");
                  setCommand(b.command);
                }
              }}
            >
              {b.key}
            </Button>
            <span className="flex-1 min-w-0 break-words text-mono-xs text-fg-secondary">
              <ColoredNickname raw={b.command} placeholder="" />
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                try {
                  onChange(appendBind(text, b.key, ""));
                } catch (e) {
                  setError(e);
                }
              }}
            >
              {t("configs.unbind")}
            </Button>
          </div>
        ))}
      </div>
      </details>
      {share.dialog}
    </div>
  );
}

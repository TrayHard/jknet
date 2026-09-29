import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Download, FileText, Plus, Share2, Trash2, Upload } from "lucide-react";
import type { Game, ServerConfigDocument, ServerConfigImportFile } from "../../lib/ipc";
import { GAMES, serverConfigsIpc } from "../../lib/ipc";
import { useServerConfigActions, useServerConfigs } from "../../lib/queries";
import { useActiveGame, useGameNames } from "../../lib/game";
import { MOD_CATALOG } from "../../lib/serverConfigCatalog";
import { blankServerConfig, detectServerConfigMod, hasServerConfigHeader, parseServerConfigEnvelope, serverConfigEnvelope, serverConfigFilename, serverConfigSensitiveKeys,
  decodeServerConfigBytes, serverConfigDropProblem, serverConfigImportName, SERVER_CONFIG_IMPORT_MAX_BYTES, SERVER_CONFIG_MAX_BYTES,
  SERVER_CONFIG_NAME_MAX_BYTES } from "../../lib/serverConfig";
import { isTauri } from "../../lib/runtime";
import { configCard, fitsConfigCard } from "../../lib/chat/cardDrafts";
import { useErrorText } from "../../i18n/errors";
import { useUnsavedGuard } from "../client/UnsavedGuard";
import { useShareDialog } from "../chat/ShareToChatDialog";
import { ConfigCodeEditor } from "../ConfigCodeEditor";
import { Badge, Button, Dialog, Input, Select } from "../ui";
import { ServerConfigEditor } from "./ServerConfigEditor";

export function ServerConfigsPanel({ game: requestedGame, selectedId }: { game?: Game; selectedId?: string | null }) {
  const { t } = useTranslation("serverConfigs");
  const { t: tChat } = useTranslation("chat");
  const activeGame = useActiveGame();
  const [game, setGame] = useState(requestedGame ?? activeGame);
  const gameNames = useGameNames();
  const errorText = useErrorText();
  const book = useServerConfigs();
  const actions = useServerConfigActions();
  const guard = useUnsavedGuard();
  const share = useShareDialog();
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ServerConfigDocument | null>(null);
  const [baseline, setBaseline] = useState("");
  const [search, setSearch] = useState("");
  const [removing, setRemoving] = useState<ServerConfigDocument | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importName, setImportName] = useState("");
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const [dropState, setDropState] = useState<"ready" | "invalid" | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const openedId = useRef<string | null>(null);
  const readRequest = useRef(0);
  const dragDepth = useRef(0);
  const dirty = (draft !== null && JSON.stringify(draft) !== baseline) || (importing && (!!importText || !!importName));
  const documents = (book.data ?? []).filter(doc => doc.game === game);
  const filtered = documents.filter(doc => `${doc.name} ${MOD_CATALOG.find(mod => mod.id === doc.modId)?.name ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const encoded = draft ? serverConfigEnvelope(draft) : "";
  const sensitive = draft ? serverConfigSensitiveKeys(draft.text) : [];
  const nameBytes = draft ? new TextEncoder().encode(draft.name.trim()).length : 0;
  const textTooLarge = !!draft && new TextEncoder().encode(draft.text).length > SERVER_CONFIG_MAX_BYTES;
  const validName = !!draft?.name.trim() && nameBytes <= SERVER_CONFIG_NAME_MAX_BYTES && !/[\u0000-\u001f\u007f]/.test(draft.name);
  const shareable = !!draft?.text.trim() && validName && sensitive.length === 0 && !textTooLarge;
  const busy = actions.save.isPending || actions.remove.isPending || readingFile;
  const failure = book.error ?? actions.save.error ?? actions.remove.error;
  useEffect(() => {
    guard.setDirty(dirty);
    return () => guard.setDirty(false);
  }, [dirty, guard]);
  useEffect(() => {
    setGame(requestedGame ?? activeGame);
    setDraft(null);
    setSearch("");
    setLocalError("");
    setNotice("");
  }, [requestedGame, activeGame]);
  useEffect(() => {
    if (!selectedId || openedId.current === selectedId || !book.data) return;
    const document = book.data.find(doc => doc.id === selectedId);
    if (!document) return;
    openedId.current = selectedId;
    guard.ask(() => { setGame(document.game); setDraft({ ...document }); setBaseline(JSON.stringify(document)); });
  }, [selectedId, book.data, guard]);
  const edit = (document: ServerConfigDocument) => guard.ask(() => {
    setDraft({ ...document });
    setGame(document.game);
    setBaseline(document.id ? JSON.stringify(document) : "");
    setLocalError("");
    setNotice("");
  });
  const startImport = () => guard.ask(() => {
    readRequest.current += 1;
    setReadingFile(false);
    setDraft(null);
    setBaseline("");
    setImportText(""); setImportName(""); setLocalError(""); setImporting(true);
  });
  const closeImport = () => guard.ask(() => {
    readRequest.current += 1;
    setReadingFile(false);
    setImporting(false);
  });
  const offerImport = (file: ServerConfigImportFile) => {
    if (new TextEncoder().encode(file.text).length > SERVER_CONFIG_IMPORT_MAX_BYTES) {
      setLocalError(t("tooLarge"));
      return;
    }
    if (hasServerConfigHeader(file.text) && parseServerConfigEnvelope(file.text) === null) {
      setLocalError(t("invalidHeader"));
      return;
    }
    guard.ask(() => {
      setDraft(null);
      setBaseline("");
      setImportText(file.text.replace(/^\uFEFF/, ""));
      setImportName(serverConfigImportName(file.name));
      setLocalError("");
      setNotice("");
      setImporting(true);
    });
  };
  const readBrowserFile = (file: File) => {
    if (serverConfigDropProblem([file.name])) {
      setLocalError(t("dropOneCfg"));
      return;
    }
    if (file.size > SERVER_CONFIG_IMPORT_MAX_BYTES) {
      setLocalError(t("tooLarge"));
      return;
    }
    const request = ++readRequest.current;
    setReadingFile(true);
    void file.arrayBuffer().then(buffer => decodeServerConfigBytes(new Uint8Array(buffer))).then(text => {
      if (readRequest.current !== request) return;
      offerImport({ name: file.name, text });
    }).catch(() => {
      if (readRequest.current === request) setLocalError(t("readFailed"));
    }).finally(() => {
      if (readRequest.current === request) setReadingFile(false);
    });
  };
  const readNativeDrop = (paths: string[]) => {
    if (serverConfigDropProblem(paths)) {
      setLocalError(t("dropOneCfg"));
      return;
    }
    const request = ++readRequest.current;
    setReadingFile(true);
    void serverConfigsIpc.readFile(paths[0]).then(file => {
      if (readRequest.current !== request) return;
      offerImport(file);
    }).catch(() => {
      if (readRequest.current === request) setLocalError(t("readFailed"));
    }).finally(() => {
      if (readRequest.current === request) setReadingFile(false);
    });
  };
  const nativeDrop = useRef(readNativeDrop);
  useEffect(() => { nativeDrop.current = readNativeDrop; });
  useEffect(() => () => { readRequest.current += 1; }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === "enter") {
        setDropState(serverConfigDropProblem(event.payload.paths) ? "invalid" : "ready");
        return;
      }
      if (event.payload.type === "over") return;
      setDropState(null);
      if (event.payload.type === "drop") nativeDrop.current(event.payload.paths);
    }).then(stop => {
      if (cancelled) stop(); else unlisten = stop;
    }).catch(() => setLocalError(t("readFailed")));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  type FileDragEvent = {
    dataTransfer: DataTransfer;
    preventDefault(): void;
    stopPropagation(): void;
  };
  const hasDroppedFiles = (event: FileDragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");
  const onDragEnter = (event: FileDragEvent) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    const names = Array.from(event.dataTransfer.items).filter(item => item.kind === "file")
      .map(item => item.getAsFile()?.name).filter((name): name is string => !!name);
    setDropState(names.length && serverConfigDropProblem(names) ? "invalid" : "ready");
  };
  const onDragOver = (event: FileDragEvent) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: FileDragEvent) => {
    if (!hasDroppedFiles(event)) return;
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropState(null);
  };
  const onDrop = (event: FileDragEvent) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDropState(null);
    const files = Array.from(event.dataTransfer.files);
    if (serverConfigDropProblem(files.map(file => file.name))) {
      setLocalError(t("dropOneCfg"));
      return;
    }
    readBrowserFile(files[0]);
  };
  const browserDrop = useRef({ onDragEnter, onDragOver, onDragLeave, onDrop });
  browserDrop.current = { onDragEnter, onDragOver, onDragLeave, onDrop };
  useEffect(() => {
    if (isTauri()) return;
    const enter = (event: DragEvent) => { if (event.dataTransfer) browserDrop.current.onDragEnter(event as FileDragEvent); };
    const over = (event: DragEvent) => { if (event.dataTransfer) browserDrop.current.onDragOver(event as FileDragEvent); };
    const leave = (event: DragEvent) => { if (event.dataTransfer) browserDrop.current.onDragLeave(event as FileDragEvent); };
    const drop = (event: DragEvent) => { if (event.dataTransfer) browserDrop.current.onDrop(event as FileDragEvent); };
    document.addEventListener("dragenter", enter, true);
    document.addEventListener("dragover", over, true);
    document.addEventListener("dragleave", leave, true);
    document.addEventListener("drop", drop, true);
    return () => {
      document.removeEventListener("dragenter", enter, true);
      document.removeEventListener("dragover", over, true);
      document.removeEventListener("dragleave", leave, true);
      document.removeEventListener("drop", drop, true);
    };
  }, []);
  const importConfig = () => {
    if (new TextEncoder().encode(importText).length > SERVER_CONFIG_IMPORT_MAX_BYTES) {
      setLocalError(t("tooLarge")); return;
    }
    const imported = parseServerConfigEnvelope(importText);
    if (hasServerConfigHeader(importText) && imported === null) {
      setLocalError(t("invalidHeader")); return;
    }
    const text = importText.replace(/^\uFEFF/, "");
    const document = imported ? { ...imported, id: "" } : {
      ...blankServerConfig(game, importName.trim() || t("importedName")),
      modId: detectServerConfigMod(text, game), text,
    };
    setDraft(document);
    setGame(document.game);
    setBaseline("");
    setImporting(false);
    setLocalError("");
    setNotice("");
  };
  const copy = async () => {
    if (!shareable) return;
    try { await navigator.clipboard.writeText(encoded); setNotice(t("copied")); setLocalError(""); }
    catch { setLocalError(t("copyFailed")); }
  };
  const download = () => {
    if (!draft || !shareable) return;
    const url = URL.createObjectURL(new Blob([encoded], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = serverConfigFilename(draft.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div data-server-config-dropzone className="flex min-w-0 flex-col gap-20"
      onDragEnterCapture={onDragEnter} onDragOverCapture={onDragOver} onDragLeaveCapture={onDragLeave} onDropCapture={onDrop}>
      <div className="flex flex-wrap items-center gap-8">
        <Button variant="primary" icon={<Plus size={16} />} disabled={busy} onClick={() => edit(blankServerConfig(game))}>{t("create")}</Button>
        <Button icon={<Upload size={16} />} disabled={busy} onClick={startImport}>{t("import")}</Button>
        <Select ariaLabel={t("game")} value={game} options={GAMES.map(id => ({ value: id, label: gameNames.label(id) }))}
          onChange={next => guard.ask(() => { setGame(next as Game); setDraft(null); setSearch(""); guard.setDirty(false); })} />
      </div>
      <div className="flex flex-col gap-4 text-body-sm text-fg-secondary">
        <p>{t("intro")}</p>
        <p>{t("dropHint")}</p>
      </div>
      {failure ? <p role="alert" className="text-body-sm text-fg-danger">{errorText(failure)}</p> : null}
      {localError && !importing ? <p role="alert" className="text-body-sm text-fg-danger">{localError}</p> : null}
      {notice ? <p role="status" className="text-body-sm text-fg-success">{notice}</p> : null}
      {readingFile ? <p role="status" className="text-body-sm text-fg-muted">{t("readingFile")}</p> : null}
      {book.isLoading ? <p role="status" className="text-body-sm text-fg-muted">{t("loading")}</p> : null}
      {book.error ? <Button onClick={() => void book.refetch()}>{t("retry")}</Button> : null}
      {documents.length ? (
        <section aria-label={t("saved")} className="flex min-w-0 flex-col gap-12">
          <div className="flex items-center gap-8"><h2 className="text-heading-sm text-fg">{t("saved")}</h2><Badge>{documents.length}</Badge></div>
          <Input aria-label={t("searchConfigs")} placeholder={t("searchConfigs")} value={search} onChange={event => setSearch(event.target.value)} />
          <div className="flex max-h-256 flex-col gap-8 overflow-y-auto">
            {filtered.map(doc => (
              <div key={doc.id} className={`flex flex-wrap items-center gap-12 rounded-md border p-12 ${draft?.id === doc.id ? "border-line-accent bg-accent-subtle" : "border-line bg-surface"}`}>
                <button type="button" disabled={busy} aria-current={draft?.id === doc.id ? "true" : undefined} className="min-w-0 flex-1 break-words text-left text-body-md text-fg hover:text-fg-accent" onClick={() => edit(doc)}>{doc.name}</button>
                <Badge>{MOD_CATALOG.find(mod => mod.id === doc.modId)?.name ?? doc.modId}</Badge>
                <Button size="sm" variant="ghost" disabled={busy} icon={<Copy size={14} />} aria-label={t("duplicateNamed", { name: doc.name })} title={t("duplicate")} onClick={() => edit({ ...doc, id: "", name: t("copyName", { name: doc.name }) })} />
                <Button size="sm" variant="ghost" disabled={busy} icon={<Trash2 size={14} />} aria-label={t("removeNamed", { name: doc.name })} title={t("remove")} onClick={() => setRemoving(doc)} />
              </div>
            ))}
          </div>
          {!filtered.length ? <p className="text-body-sm text-fg-muted">{t("noResults")}</p> : null}
        </section>
      ) : !draft && !book.isLoading && !book.error ? (
        <section className="flex min-h-180 flex-col items-center justify-center gap-12 rounded-lg border border-dashed border-line bg-surface px-24 py-32 text-center">
          <FileText size={28} className="text-fg-muted" aria-hidden="true" />
          <h2 className="text-heading-md text-fg">{t("emptyTitle")}</h2>
          <p className="max-w-560 text-body-md text-fg-secondary">{t("empty")}</p>
        </section>
      ) : null}
      {draft ? (
        <section aria-label={t("editor")} className="flex min-w-0 flex-col gap-16 rounded-lg border border-line bg-surface p-16">
          <div className="flex flex-wrap items-center gap-8"><h2 className="text-heading-sm text-fg">{draft.name || t("untitled")}</h2><Badge>{gameNames.label(draft.game)}</Badge>{dirty ? <Badge>{t("unsaved")}</Badge> : null}</div>
          <fieldset disabled={busy} className="min-w-0"><ServerConfigEditor draft={draft} onChange={document => { if (busy) return; setDraft(document); setGame(document.game); setNotice(""); }} /></fieldset>
          {textTooLarge || nameBytes > SERVER_CONFIG_NAME_MAX_BYTES ? <p role="alert" className="text-body-sm text-fg-danger">{t(textTooLarge ? "tooLarge" : "nameTooLong")}</p> : null}
          {sensitive.length ? <p role="alert" className="text-body-sm text-fg-warm">{t("sensitive", { keys: sensitive.join(", ") })}</p> : null}
          {shareable && !fitsConfigCard(encoded) ? <p className="text-body-xs text-fg-muted">{tChat("pickers.config.tooLarge")}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-8 border-t border-line pt-12">
            <Button variant="ghost" icon={<Copy size={14} />} disabled={!shareable || busy} onClick={() => void copy()}>{t("copy")}</Button>
            <Button variant="ghost" icon={<Download size={14} />} disabled={!shareable || busy} onClick={download}>{t("export")}</Button>
            {share.available ? <Button variant="ghost" icon={<Share2 size={14} />} disabled={!shareable || !fitsConfigCard(encoded) || busy} onClick={() => share.open({ kind: "card", card: configCard({ name: draft.name, text: encoded }) })}>{tChat("share.action")}</Button> : null}
            <Button variant="ghost" disabled={busy} onClick={() => guard.ask(() => setDraft(null))}>{t("close")}</Button>
            <Button variant="primary" disabled={!validName || textTooLarge || busy || !dirty} onClick={() => actions.save.mutate(draft, { onSuccess: doc => {
              setDraft(doc); setBaseline(JSON.stringify(doc)); guard.setDirty(false); setNotice(t("savedNotice"));
            } })}>{t("save")}</Button>
          </div>
        </section>
      ) : null}
      {importing ? (
        <Dialog wide title={t("import")} body={t("importHint")} onClose={closeImport} actions={<>
          <Button variant="ghost" onClick={closeImport}>{t("close")}</Button>
          <Button variant="primary" disabled={!importText.trim()} onClick={importConfig}>{t("importOpen")}</Button>
        </>}>
          <div className="flex flex-col gap-12">
            <input ref={fileInput} type="file" accept=".cfg,text/plain" className="hidden" onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              readBrowserFile(file);
            }} />
            <Button icon={<Upload size={14} />} onClick={() => fileInput.current?.click()}>{t("chooseFile")}</Button>
            <Input aria-label={t("name")} placeholder={t("name")} value={importName} onChange={event => setImportName(event.target.value)} />
            <ConfigCodeEditor value={importText} onChange={setImportText} height={260} ariaLabel={t("paste")} completions={[]} />
            {localError ? <p role="alert" className="text-body-sm text-fg-danger">{localError}</p> : null}
          </div>
        </Dialog>
      ) : null}
      {removing ? <Dialog title={t("remove")} body={t("removeHint", { name: removing.name })} onClose={() => setRemoving(null)} actions={<>
        <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>{t("close")}</Button>
        <Button variant="danger" disabled={busy} onClick={() => actions.remove.mutate(removing.id, { onSuccess: () => {
          if (draft?.id === removing.id) { setDraft(null); guard.setDirty(false); }
          setRemoving(null);
        } })}>{t("remove")}</Button>
      </>}>
        {actions.remove.error ? <p role="alert" className="text-body-sm text-fg-danger">{errorText(actions.remove.error)}</p> : null}
      </Dialog> : null}
      {dropState ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay pointer-events-none" role="status" aria-live="polite">
          <div className={`flex flex-col items-center gap-8 rounded-xl border border-dashed bg-surface px-48 py-32 ${dropState === "ready" ? "border-line-accent" : "border-line-danger"}`}>
            <Upload size={28} className={dropState === "ready" ? "text-fg-accent" : "text-fg-danger"} aria-hidden="true" />
            <span className="text-heading-sm text-fg">{t(dropState === "ready" ? "dropTitle" : "dropOneCfg")}</span>
            <span className="text-body-sm text-fg-secondary">{t("dropRelease")}</span>
          </div>
        </div>
      ) : null}
      {share.dialog}
    </div>
  );
}

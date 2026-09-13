import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CommunityBrowser, type CommunityLabels } from "../components/community/CommunityBrowser";
import type { CommunityRequest, CommunityServer } from "../components/community/types";
import { communityIpc, jkhubIpc } from "../lib/ipc";
import { useAccountState, useClients, useRunningGame, useLaunchClient, useAddServerHistory } from "../lib/queries";
import { useErrorText } from "../i18n/errors";

const request: CommunityRequest = (method, path, body) => communityIpc.request(method, path, body);
export function CommunityPage() {
  const { t } = useTranslation("servers");
  const labels = t("community", { returnObjects: true }) as CommunityLabels;
  const account = useAccountState();
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [externalError, setExternalError] = useState("");
  const openExternal = useCallback((url: string) => { void openUrl(url).catch(error => setExternalError(String(error))); }, []);
  return <div className="flex-1 min-h-0 overflow-y-auto">{externalError && <p role="alert">{externalError}</p>}<CommunityBrowser
    request={request} labels={labels} signedIn={account.data?.onlineSignedIn ?? false} accountKey={account.data?.onlineUser?.id ?? ""}
    signIn={() => navigate("/settings")} pageId={id} navigate={page => navigate(page ? `/community/${page}` : "/community")}
    seed={params.has("address") ? { address: params.get("address")!, name: params.get("name") ?? "", game: params.get("game") === "jo" ? "jo" : "ja" } : undefined}
    openExternal={openExternal} renderInstall={server => <InstallRecommendations key={server.id + server.revision} server={server} labels={labels} />}
  /></div>;
}

function InstallRecommendations({ server, labels: l }: { server: CommunityServer; labels: CommunityLabels }) {
  const clients = useClients();
  const running = useRunningGame();
  const launch = useLaunchClient();
  const history = useAddServerHistory();
  const errorText = useErrorText();
  const choices = clients.data?.filter(c => c.game === server.game && c.engineInstalledAt) ?? [];
  const [chosen, setChosen] = useState("");
  const clientId = choices.some(c => c.id === chosen) ? chosen : choices[0]?.id ?? "";
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState("");
  const [done, setDone] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const cancel = useRef(false);
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; cancel.current = true; }; }, []);
  async function run(install: boolean, join: boolean) {
    if (locked.current || !clientId || running.data || running.isPending || running.isError) return;
    locked.current = true; cancel.current = false; setBusy(true); setError(""); setNotice("");
    let currentFile = "";
    try {
      if (install) {
        // Always recheck the entire list. The core compares every archive member,
        // so a removed file is restored and a partially installed pack is repaired.
        setDone([]);
        for (const file of server.recommendations) {
          if (cancel.current) break;
          setCurrent(file.title); currentFile = file.title;
          const detail = await jkhubIpc.file(file.jkhubId);
          if (detail.game !== server.game && detail.game !== "both") throw new Error(l.wrongGame);
          if (cancel.current) break;
          const result = await jkhubIpc.install(file.jkhubId, clientId, false, true);
          if (result.kind !== "installed") throw new Error(result.kind === "conflicts" ? l.conflicts : l.unsupported);
          if (alive.current) setDone(ids => [...ids, file.jkhubId]);
        }
      }
      if (cancel.current) { if (alive.current) setNotice(l.stopped); return; }
      if (install) setNotice(l.complete);
      if (join && alive.current) {
        await launch.mutateAsync({ clientId, connect: server.address });
        history.mutate({ address: server.address, clientId, game: server.game });
      }
    } catch (err) { if (alive.current) setError(`${currentFile ? currentFile + ": " : ""}${errorText(err)}`); }
    finally { locked.current = false; if (alive.current) { setBusy(false); setCurrent(""); } }
  }
  const disabled = busy || !clientId || !!running.data || running.isPending || running.isError;
  return <div className="community-install"><label>{l.client}<select value={clientId} disabled={busy} onChange={e => { setChosen(e.target.value); setDone([]); setError(""); setNotice(""); }}>{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    {!clientId && <p>{l.noClient}</p>}{running.data && <p>{l.running}</p>}{running.isError && <p role="alert">{errorText(running.error)}</p>}
    {!!server.recommendations.length && <><p>{l.installHint}</p><button disabled={disabled} onClick={() => void run(true, false)}>{error ? l.retry : l.installAll}</button><button className="community-primary" disabled={disabled} onClick={() => void run(true, true)}>{l.installJoin}</button></>}
    <button disabled={disabled} onClick={() => void run(false, true)}>{l.join}</button>
    {busy && <><p role="status">{l.installing}: {current} ({done.length}/{server.recommendations.length})</p><button onClick={() => { cancel.current = true; }}>{l.stop}</button></>}
    {!!done.length && <p>{l.installed}: {done.length}/{server.recommendations.length}</p>}
    {error && <p className="community-error" role="alert">{current && `${current}: `}{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}

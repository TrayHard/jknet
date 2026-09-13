import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, Copy, ExternalLink, Globe, Plus, ShieldCheck, Users } from "lucide-react";
import type en from "../../locales/en/servers.json";
import { jkhubId, type CommunityClaim, type CommunityMe, type CommunityRequest, type CommunityServer } from "./types";
import "./community.css";

export type CommunityLabels = { [K in keyof typeof en.community]: string };
interface Props {
  request: CommunityRequest; labels: CommunityLabels; signedIn: boolean; accountKey: string;
  signIn: () => void; pageId?: string; navigate: (id?: string) => void;
  seed?: { address: string; name: string; game: "ja" | "jo" };
  openExternal?: (url: string) => void;
  renderInstall?: (server: CommunityServer) => ReactNode;
}
interface ReviewItem { claim: CommunityClaim; server: CommunityServer; user: { displayName: string; id: string } }

export function CommunityBrowser({ request: transport, labels: l, signedIn, accountKey, signIn, pageId, navigate, seed, openExternal, renderInstall }: Props) {
  const [pages, setPages] = useState<CommunityServer[]>([]);
  const [page, setPage] = useState<CommunityServer>();
  const [me, setMe] = useState<CommunityMe>();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [game, setGame] = useState("");
  const [mine, setMine] = useState(false);
  const [adding, setAdding] = useState(!!seed);
  const [editing, setEditing] = useState(false);
  const [claim, setClaim] = useState<CommunityClaim>();
  const epoch = useRef(0);
  const locked = useRef(false);
  // A write can finish after navigation or an account change. Its response must
  // not replace the page the player opened in the meantime.
  const request: CommunityRequest = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const generation = epoch.current;
    const result = await transport<T>(method, path, body);
    if (generation !== epoch.current) throw new Error("The page changed while the request was running");
    return result;
  }, [transport]);
  const reset = () => setRefresh(n => n + 1);
  useEffect(() => {
    const run = ++epoch.current;
    locked.current = false; setBusy(false);
    setLoading(true); setError(""); setNotice(""); setMe(undefined); setReviews([]); setPage(undefined); setClaim(undefined); setEditing(false);
    Promise.all([
      pageId ? request<CommunityServer>("GET", `servers/${pageId}`) : request<{ servers: CommunityServer[] }>("GET", "servers"),
      signedIn ? request<CommunityMe>("GET", "me") : Promise.resolve(undefined),
    ]).then(async ([result, own]) => {
      if (epoch.current !== run) return;
      if ("servers" in result) setPages(result.servers); else setPage(result);
      setMe(own);
      setClaim(own?.claims.find(c => c.serverId === pageId));
      if (own?.isAdmin) {
        const data = await request<{ claims: ReviewItem[] }>("GET", "admin/claims");
        if (epoch.current === run) setReviews(data.claims);
      }
    }).catch(err => { if (epoch.current === run) setError(message(err)); })
      .finally(() => { if (epoch.current === run) setLoading(false); });
    return () => { epoch.current++; };
  }, [request, pageId, signedIn, accountKey, refresh]);

  async function action(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    const generation = epoch.current;
    try { await work(); } catch (err) { if (generation === epoch.current) setError(message(err)); }
    finally { if (generation === epoch.current) { locked.current = false; setBusy(false); } }
  }
  function external(url: string, title: string) {
    return <a className="community-link" href={url} target="_blank" rel="noopener noreferrer ugc" onClick={openExternal ? e => { e.preventDefault(); openExternal(url); } : undefined}>{title}<ExternalLink size={14} /></a>;
  }
  useEffect(() => {
    if (!pageId && seed?.address) {
      const existing = pages.find(s => s.address === seed.address && s.game === seed.game);
      if (existing) navigate(existing.id);
    }
  }, [pages, seed?.address, seed?.game, pageId]);
  const canEdit = !!page && !!me && (page.ownerId === me.userId || me.isAdmin);
  const visible = (mine ? me?.servers ?? [] : pages).filter(s => (!game || s.game === game) && `${s.name} ${s.address} ${s.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="community-app">
    <header className="community-heading">
      <div><span className="community-eyebrow"><Users size={14} />{l.brand}</span><h1>{page?.name ?? l.title}</h1><p>{page ? page.address : l.intro}</p></div>
      <div className="community-actions">{pageId && <button onClick={() => navigate()}><ArrowLeft size={16} />{l.back}</button>}<button onClick={reset} disabled={busy || loading}>{l.refresh}</button>{!signedIn && <button className="community-primary" onClick={signIn}>{l.signIn}</button>}</div>
    </header>
    {error && <div className="community-error" role="alert">{error}</div>}
    {notice && <div className="community-note" role="status">{notice}</div>}
    {loading ? <p role="status">{l.loading}</p> : (pageId && !page) ? null : (page) ? <>
      <div className="community-badges"><span>{page.game === "ja" ? "Jedi Academy" : "Jedi Outcast"}</span><span>{page.ownerId ? <><CheckCircle2 size={14} />{l.verified}</> : l.unverified}</span>{page.featured && <span><ShieldCheck size={14} />{l.featured}</span>}</div>
      <div className="community-detail-grid"><div className="community-content">
        <section className="community-panel"><h2>{l.about}</h2><p className="community-prose">{page.description || l.noDescription}</p><div className="community-actions">{page.website && external(page.website, l.website)}{page.discord && external(page.discord, "Discord")}</div></section>
        {page.rules && <section className="community-panel"><h2>{l.rules}</h2><p className="community-prose">{page.rules}</p></section>}
        <section className="community-panel"><div className="community-section-heading"><h2>{l.recommendations}</h2><span className="community-count">{page.recommendations.length}</span></div><p>{l.recommendationHint}</p>
          {page.recommendations.length ? <ul className="community-files">{page.recommendations.map((r, i) => <li key={r.jkhubId}><span className="community-file-number">{String(i + 1).padStart(2, "0")}</span><div><strong>{r.title}</strong><small>JKHub · #{r.jkhubId}</small></div>{external(`https://jkhub.org/files/file/${r.jkhubId}/`, l.viewFile)}</li>)}</ul> : <p>{l.noFiles}</p>}
        </section>
      </div><aside className="community-content">
        <section className="community-panel"><h2>{l.play}</h2><p>{l.persistent}</p><button onClick={() => void action(async () => { await navigator.clipboard.writeText(page.address); setNotice(l.copied); })}><Copy size={15} />{l.copyAddress}</button>{renderInstall?.(page) ?? <p>{l.launcherHint}</p>}</section>
        <section className="community-panel"><h2>{l.ownership}</h2>{canEdit ? <button onClick={() => setEditing(v => !v)}>{editing ? l.cancel : l.edit}</button> : (page.ownerId) ? <p>{l.ownerConfirmed}</p> : <>
          <p>{l.claimHint}</p>{signedIn ? <div className="community-stack"><button disabled={busy} onClick={() => void action(async () => { setClaim(await request("POST", `servers/${page.id}/claims`, { manual: false })); })}>{l.getCode}</button><button disabled={busy} onClick={() => void action(async () => { setClaim(await request("POST", `servers/${page.id}/claims`, { manual: true })); })}>{l.manual}</button></div> : <button onClick={signIn}>{l.signIn}</button>}
          {claim && <div className="community-claim">{claim.status === "pending" ? claim.manual ? <p>{l.pendingManual}</p> : <><p>{l.codeHint}</p><code>{claim.code}</code><small>{l.expires}: {new Date(claim.expiresAt).toLocaleString()}</small><button disabled={busy} onClick={() => void action(async () => { const updated = await request<CommunityServer>("POST", `claims/${claim.id}/verify`); setPage(updated); setClaim(undefined); setNotice(l.claimed); })}>{l.verify}</button></> : <p>{claim.status === "rejected" ? l.rejected : l.claimed}</p>}</div>}
        </>}</section>
      </aside></div>
      {editing && canEdit && <Editor key={page.id + page.revision} page={page} l={l} busy={busy} cancel={() => setEditing(false)} save={body => void action(async () => { setPage(await request("PUT", `servers/${page.id}`, body)); setEditing(false); setNotice(l.saved); })} />}
    </> : <>
      <div className="community-toolbar"><div className="community-tabs"><button aria-pressed={!mine} onClick={() => setMine(false)}>{l.all}</button>{signedIn && <button aria-pressed={mine} onClick={() => setMine(true)}>{l.mine}</button>}</div><label className="community-search"><span className="community-sr">{l.search}</span><input placeholder={l.search} value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label={l.game} value={game} onChange={e => setGame(e.target.value)}><option value="">{l.allGames}</option><option value="ja">Jedi Academy</option><option value="jo">Jedi Outcast</option></select><button className="community-primary" onClick={() => signedIn ? setAdding(v => !v) : signIn()}><Plus size={16} />{l.add}</button></div>
      {adding && signedIn && <form className="community-panel community-add" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void action(async () => { const created = await request<CommunityServer>("POST", "servers", Object.fromEntries(data)); setAdding(false); navigate(created.id); }); }}><h2>{l.add}</h2><label>{l.name}<input name="name" required maxLength={100} defaultValue={seed?.name} /></label><label>{l.address}<input name="address" required defaultValue={seed?.address} placeholder="server.example.com:29070" /></label><label>{l.game}<select name="game" defaultValue={seed?.game ?? "ja"}><option value="ja">Jedi Academy</option><option value="jo">Jedi Outcast</option></select></label><p>{l.addHint}</p><div className="community-actions"><button className="community-primary" disabled={busy}>{l.create}</button><button type="button" onClick={() => setAdding(false)}>{l.cancel}</button></div></form>}
      {visible.length ? <div className="community-cards">{visible.map(s => <button className="community-card" key={s.id} onClick={() => navigate(s.id)}><span className="community-card-icon"><Globe size={24} /></span><span className="community-card-game">{s.game === "ja" ? "Jedi Academy" : "Jedi Outcast"}</span><strong>{s.name}</strong><span className="community-card-description">{s.description || l.noDescription}</span><code>{s.address}</code><span className="community-card-footer">{s.featured ? <><ShieldCheck size={15} />{l.featured}</> : s.ownerId ? <><CheckCircle2 size={15} />{l.verified}</> : l.unverified}<span>{s.recommendations.length} · JKHub</span></span></button>)}</div> : <div className="community-empty"><Globe size={36} /><h2>{search || game ? l.noResults : l.empty}</h2><p>{l.emptyHint}</p></div>}
    </>}
    {me?.isAdmin && !loading && <section className="community-panel community-admin"><h2>{l.admin}</h2>{reviews.length === 0 ? <p>{l.noRequests}</p> : reviews.map(item => <div className="community-review" key={item.claim.id}><div><strong>{item.server.name}</strong><p>{item.server.address} · {item.user.displayName}</p><small>{item.user.id}</small></div><button onClick={() => navigate(item.server.id)}>{l.about}</button><button disabled={busy} onClick={() => void action(async () => { await request("POST", `admin/claims/${item.claim.id}`, { approve: true, featured: true }); reset(); })}>{l.approve}</button><button disabled={busy} onClick={() => void action(async () => { await request("POST", `admin/claims/${item.claim.id}`, { approve: false }); reset(); })}>{l.reject}</button></div>)}</section>}
  </div>;
}
function message(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}
function Editor({ page, l, busy, cancel, save }: { page: CommunityServer; l: CommunityLabels; busy: boolean; cancel: () => void; save: (body: unknown) => void }) {
  const [files, setFiles] = useState(page.recommendations.map(r => ({ title: r.title, link: `https://jkhub.org/files/file/${r.jkhubId}/` })));
  const [error, setError] = useState("");
  return <form className="community-panel community-editor" onSubmit={e => {
    e.preventDefault(); setError("");
    const recommendations = files.map(r => ({ title: r.title.trim(), jkhubId: jkhubId(r.link) }));
    if (recommendations.some(r => !r.title || !r.jkhubId) || new Set(recommendations.map(r => r.jkhubId)).size !== recommendations.length) { setError(l.invalidFiles); return; }
    save({ ...Object.fromEntries(new FormData(e.currentTarget)), recommendations, revision: page.revision });
  }}><h2>{l.edit}</h2>{error && <p role="alert" className="community-error">{error}</p>}<label>{l.name}<input name="name" required autoFocus maxLength={100} defaultValue={page.name} /></label><label>{l.about}<textarea name="description" rows={5} maxLength={6000} defaultValue={page.description} /></label><div className="community-form-columns"><label>{l.website}<input name="website" type="url" placeholder="https://" maxLength={500} defaultValue={page.website} /></label><label>Discord<input name="discord" type="url" placeholder={"https://discord.gg/" + "…"} maxLength={500} defaultValue={page.discord} /></label></div><label>{l.rules}<textarea name="rules" rows={3} maxLength={4000} defaultValue={page.rules} /></label><h3>{l.recommendations}</h3><p>{l.editFilesHint}</p>
    {files.map((file, i) => <div className="community-file-edit" key={i}><label>{l.fileTitle}<input required maxLength={120} value={file.title} onChange={e => setFiles(rows => rows.map((r, at) => at === i ? { ...r, title: e.target.value } : r))} /></label><label>{l.fileUrl}<input required value={file.link} onChange={e => setFiles(rows => rows.map((r, at) => at === i ? { ...r, link: e.target.value } : r))} /></label><button type="button" onClick={() => setFiles(rows => rows.filter((_, at) => at !== i))}>{l.remove}</button></div>)}
    <button type="button" disabled={files.length >= 30} onClick={() => setFiles(rows => [...rows, { title: "", link: "" }])}><Plus size={16} />{l.addFile}</button><div className="community-actions"><button className="community-primary" disabled={busy}>{busy ? l.saving : l.save}</button><button type="button" disabled={busy} onClick={cancel}>{l.cancel}</button></div>
  </form>;
}

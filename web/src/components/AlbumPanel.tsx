import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { parseLastfmUrl } from '../../../shared/rank.ts';
import { statsLine } from './AlbumTile.tsx';
import type { Album, AlbumDetail, Sort, Source } from '../types.ts';

type Props = { user: string; source: Source; a: Album; sort: Sort; from: number | undefined; to: number | undefined; onClose: () => void; onChange: () => void };

export default function AlbumPanel({ user, source, a, sort, from, to, onClose, onChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<AlbumDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState('');
  const [version, setVersion] = useState(0); // bumped after a match edit to refetch

  useEffect(() => { dialog.current!.showModal(); }, []);

  useEffect(() => {
    let stale = false;
    const q = new URLSearchParams({ key: a.key });
    if (source === 'lb') q.set('source', 'lb');
    if (from !== undefined) q.set('from', String(from));
    if (to !== undefined) q.set('to', String(to));
    setError('');
    fetch(`/api/grid/${encodeURIComponent(user)}/album?${q}`)
      .then((r) => r.json())
      .then((d: { message?: string; album?: AlbumDetail }) => {
        if (stale) return;
        if (d.album) setDetail(d.album);
        else setError(d.message ?? 'Failed to load album');
      })
      .catch((err: Error) => { if (!stale) setError(err.message); });
    return () => { stale = true; };
  }, [user, source, a.key, from, to, version]);

  async function match(played: string, track: string) {
    const res = await fetch(`/api/grid/${encodeURIComponent(user)}/match${source === 'lb' ? '?source=lb' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: a.key, played, track: track || null }),
    });
    if (!res.ok) { setError((await res.json()).message); return; }
    setVersion((v) => v + 1);
    onChange();
  }

  async function setOverride(artist: string | null, album: string | null) {
    const res = await fetch(`/api/grid/${encodeURIComponent(user)}/override${source === 'lb' ? '?source=lb' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: a.key, artist, album }),
    });
    if (!res.ok) { setFormError((await res.json()).message); return; }
    setFormError('');
    setEditing(false);
    setVersion((v) => v + 1);
    onChange();
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const artist = (f.get('artist') as string).trim();
    const album = (f.get('album') as string).trim();
    const url = parseLastfmUrl(album);
    return setOverride(url?.artist ?? artist, url?.album ?? album);
  }

  return (
    <dialog
      ref={dialog} className="panel" onClose={onClose}
      onClick={(e) => { if (e.target === dialog.current) dialog.current!.close(); }} // backdrop click
    >
      <div className="panel-head">
        {a.image ? <img className="panel-cover" src={a.image} alt="" /> : <div className="panel-cover placeholder">♪</div>}
        <div className="panel-title">
          <div className="album">{a.album}</div>
          <div className="artist">{a.artist}</div>
          <div className="stats">{statsLine(a, sort)}</div>
        </div>
        <button type="button" className="close" aria-label="Close" onClick={() => dialog.current!.close()}>×</button>
      </div>
      <div className="panel-body">
        {error && <p className="panel-error" role="alert">{error}</p>}
        {!detail && !error && <p className="stats">Loading…</p>}
        {detail && <>
          <ol className="tracks">
            {detail.tracks.map((t, i) => (
              <li key={i} className={t.plays ? '' : 'unplayed'}>
                <span className="num">{i + 1}</span>
                <span className="name">{t.name}</span>
                <span className="plays">{t.plays ? `×${t.plays}` : '—'}</span>
                <span className="last">{t.lastPlayed ? new Date(t.lastPlayed * 1000).toLocaleDateString() : '—'}</span>
              </li>
            ))}
          </ol>
          {detail.extra.length > 0 && (
            <section>
              <h3>Played, not on tracklist</h3>
              <ul className="extras">
                {detail.extra.map((x) => (
                  <li key={x.name}>
                    <span className="name">{x.name}</span>
                    <span className="plays">×{x.plays}</span>
                    {detail.editable ? (
                      <select value={x.track ?? ''} onChange={(e) => match(x.name, e.target.value)}>
                        <option value="">— no match —</option>
                        {detail.tracks.filter((t) => !t.plays || t.name === x.track).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                      </select>
                    ) : x.track && <span className="last">→ {x.track}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>}
      </div>
      <footer className="panel-foot">
        {detail?.override && (
          <div className="stats">
            Matched to Last.fm album: {detail.override.artist} – {detail.override.album}{' '}
            <button type="button" className="link" onClick={() => setOverride(null, null)}>Reset</button>
          </div>
        )}
        {detail?.editable && !editing && <button type="button" className="link" onClick={() => setEditing(true)}>Wrong album?</button>}
        {detail?.editable && editing && (
          <form className="override-form" onSubmit={submit}>
            <input name="artist" placeholder="Artist" defaultValue={detail.override?.artist ?? detail.artist} required />
            <input name="album" placeholder="Album (or Last.fm album URL)" defaultValue={detail.override?.album ?? detail.album} required />
            {formError && <p className="panel-error" role="alert">{formError}</p>}
            <button type="submit">Use this album</button>
          </form>
        )}
        <a href={a.url} target="_blank" rel="noopener">Open on {new URL(a.url).hostname.includes('musicbrainz') ? 'MusicBrainz' : 'Last.fm'} ↗</a>
      </footer>
    </dialog>
  );
}

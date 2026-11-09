import { useEffect, useRef, useState } from 'react';
import { statsLine } from './AlbumTile.tsx';
import type { Album, AlbumDetail, Sort } from '../types.ts';

type Props = { user: string; a: Album; sort: Sort; from: number | undefined; to: number | undefined; onClose: () => void; onChange: () => void };

export default function AlbumPanel({ user, a, sort, from, to, onClose, onChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<AlbumDetail | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0); // bumped after a match edit to refetch

  useEffect(() => { dialog.current!.showModal(); }, []);

  useEffect(() => {
    let stale = false;
    const q = new URLSearchParams({ key: a.key });
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
  }, [user, a.key, from, to, version]);

  async function match(played: string, track: string) {
    const res = await fetch(`/api/grid/${encodeURIComponent(user)}/match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: a.key, played, track: track || null }),
    });
    if (!res.ok) { setError((await res.json()).message); return; }
    setVersion((v) => v + 1);
    onChange();
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
          {detail.tracks.some((t) => !t.plays) && (
            <section>
              <h3>Not played</h3>
              <ul className="extras">{detail.tracks.filter((t) => !t.plays).map((t, i) => <li key={i}>{t.name}</li>)}</ul>
            </section>
          )}
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
        <a href={a.url} target="_blank" rel="noopener">Open on Last.fm ↗</a>
      </footer>
    </dialog>
  );
}

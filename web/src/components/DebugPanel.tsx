import { useEffect, useRef, useState } from 'react';
import type { DebugResponse } from '../types.ts';

const when = (uts: number | null) => (uts ? new Date(uts * 1000).toLocaleString() : '—');

export default function DebugPanel({ user, onClose }: { user: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<DebugResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { dialog.current!.showModal(); }, []);

  useEffect(() => {
    let stale = false;
    fetch(`/api/grid/${encodeURIComponent(user)}/debug?n=200`)
      .then((r) => r.json())
      .then((d: DebugResponse & { message?: string }) => {
        if (stale) return;
        if (d.meta) setData(d);
        else setError(d.message ?? 'Failed to load debug info');
      })
      .catch((err: Error) => { if (!stale) setError(err.message); });
    return () => { stale = true; };
  }, [user]);

  const m = data?.meta;
  return (
    <dialog
      ref={dialog} className="panel debug" onClose={onClose}
      onClick={(e) => { if (e.target === dialog.current) dialog.current!.close(); }} // backdrop click
    >
      <div className="panel-head">
        <div className="panel-title"><div className="album">Debug: {user}</div></div>
        <button type="button" className="close" aria-label="Close" onClick={() => dialog.current!.close()}>×</button>
      </div>
      <div className="panel-body">
        {error && <p className="panel-error" role="alert">{error}</p>}
        {!data && !error && <p className="stats">Loading…</p>}
        {data && m && <>
          <dl className="debug-meta">
            <dt>status</dt><dd>{m.status}</dd>
            {m.progress && <><dt>progress</dt><dd>{m.progress.phase} {m.progress.done}/{m.progress.total}</dd></>}
            {m.message && <><dt>message</dt><dd>{m.message}</dd></>}
            {m.code && <><dt>code</dt><dd>{m.code}</dd></>}
            <dt>lastUts</dt><dd>{when(m.lastUts)}</dd>
            <dt>from</dt><dd>{when(m.from)}</dd>
            <dt>to</dt><dd>{when(m.to)}</dd>
            <dt>page</dt><dd>{m.page}/{m.pages} (committed {m.end})</dd>
          </dl>
          <table className="debug-table">
            <thead><tr><th>Time</th><th>Artist</th><th>Album</th><th>Track</th><th>Reason</th></tr></thead>
            <tbody>
              {data.scrobbles.map((s, i) => (
                <tr key={i} className={s.reason === 'in grid' ? 'ok' : ''}>
                  <td>{when(s.uts)}</td><td>{s.artist}</td><td>{s.album}</td><td>{s.track}</td><td>{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
      </div>
    </dialog>
  );
}

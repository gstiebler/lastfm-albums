import type { Album, Sort } from '../types.ts';

export function statsLine(a: Album, sort: Sort) {
  return `${Math.round(a.pct * 100)}% · ${a.length} tracks · ${sort === 'recent' ? (a.completedAt ? new Date(a.completedAt * 1000).toLocaleDateString() : '—') : `×${a.full}`}`;
}

export default function AlbumTile({ a, sort, onOpen }: { a: Album; sort: Sort; onOpen: () => void }) {
  return (
    <button type="button" className="tile" onClick={onOpen}>
      {a.image
        ? <img className="cover" src={a.image} alt="" loading="lazy" />
        : <div className="cover placeholder">♪</div>}
      <div className="meta" title={`${a.album} — ${a.artist}`}>
        <div className="album">{a.album}</div>
        <div className="artist">{a.artist}</div>
        <div className="stats">{statsLine(a, sort)}</div>
      </div>
    </button>
  );
}

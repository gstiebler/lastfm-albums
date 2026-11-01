import type { Album } from '../types.ts';

export default function AlbumTile({ a }: { a: Album }) {
  return (
    <a className="tile" href={a.url} target="_blank" rel="noopener">
      {a.image
        ? <img className="cover" src={a.image} alt="" loading="lazy" />
        : <div className="cover placeholder">♪</div>}
      <div className="meta" title={`${a.album} — ${a.artist}`}>
        <div className="album">{a.album}</div>
        <div className="artist">{a.artist}</div>
        <div className="stats">{`${Math.round(a.pct * 100)}% · ${a.length} tracks · ×${a.full}`}</div>
      </div>
    </a>
  );
}

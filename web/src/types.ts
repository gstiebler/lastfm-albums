export type Track = { name: string; plays: number; lastPlayed: number | null };
export type Extra = { name: string; plays: number; track: string | null };
export type AlbumDetail = { artist: string; album: string; image: string; url: string; tracks: Track[]; extra: Extra[]; editable: boolean };

export type Album = {
  key: string;
  artist: string;
  album: string;
  heard: number;
  length: number;
  pct: number;
  full: number;
  completedAt: number;
  image: string;
  url: string;
};

export type Sort = 'plays' | 'recent' | 'artist';

export type Progress = { phase: 'scrobbles' | 'albums'; done: number; total: number };

export type GridResponse =
  | { status: 'running'; progress: Progress; albums?: Album[] }
  | { status: 'done'; albums: Album[] }
  | { status: 'error'; message: string; code?: number };

export type DebugScrobble = { uts: number; artist: string; album: string; track: string; pending: boolean; reason: string };
export type DebugMeta = {
  status: string | null; progress: Progress | null; message: string | null; code: number | null; user: string | null;
  lastUts: number | null; from: number | null; to: number | null; end: number | null; page: number | null; pages: number | null;
};
export type DebugResponse = { meta: DebugMeta; scrobbles: DebugScrobble[] };

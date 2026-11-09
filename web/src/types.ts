export type Track = { name: string; plays: number; lastPlayed: number | null };
export type AlbumDetail = { artist: string; album: string; image: string; url: string; tracks: Track[] };

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

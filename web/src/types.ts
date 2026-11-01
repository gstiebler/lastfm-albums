export type Album = {
  artist: string;
  album: string;
  heard: number;
  length: number;
  pct: number;
  full: number;
  image: string;
  url: string;
};

export type Progress = { phase: 'scrobbles' | 'albums'; done: number; total: number };

export type GridResponse =
  | { status: 'running'; progress: Progress }
  | { status: 'done'; albums: Album[] }
  | { status: 'error'; message: string; code?: number };

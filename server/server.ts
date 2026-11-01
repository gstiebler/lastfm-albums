import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRecentTracks, getAlbumInfo, getSession } from './lastfm.ts';
import type { Session, LastfmError } from './lastfm.ts';
import { aggregate, getTracklist, needsLookup, computeAlbum, sortAlbums } from './rank.ts';
import type { AlbumResult, Range, ScrobbleState } from './rank.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'cache');
const ALBUM_CONCURRENCY = 4;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2',
  '.json': 'application/json',
};

// Album cache entry (null = Last.fm doesn't know the album).
type AlbumCacheEntry = { tracks: string[]; image: string; url: string } | null;
type GridAlbum = AlbumResult & { image: string; url: string };
type Progress = { phase: 'scrobbles' | 'albums'; done: number; total: number };
type Job = {
  status: 'running' | 'done' | 'error';
  progress: Progress;
  state?: ScrobbleState; // loaded data kept after the job is done; GET ranks from it
  cache?: Record<string, AlbumCacheEntry>;
  message?: string;
  code?: number;
  private: boolean;
};

const YEAR = 365 * 24 * 3600;
const SESSIONS_FILE = path.join(CACHE, 'sessions.json');

const jobs = new Map<string, Job>(); // user.toLowerCase() -> Job

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

// Run fn over items with limited concurrency.
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

async function loadData(user: string, job: Job, sk?: string): Promise<{ state: ScrobbleState; cache: Record<string, AlbumCacheEntry> }> {
  const userFile = path.join(CACHE, 'users', `${user.toLowerCase()}.json`);
  const saved = await readJson<ScrobbleState | null>(userFile, null);
  const state: ScrobbleState = saved?.version === 2 ? saved : { version: 2, lastUts: 0, plays: {} }; // old format: refetch all

  job.progress = { phase: 'scrobbles', done: 0, total: 1 };
  const pending: Parameters<typeof aggregate>[1] = [];
  await getRecentTracks(user, state.lastUts ? state.lastUts + 1 : undefined, (tracks, page, total) => {
    pending.push(...tracks);
    job.progress = { phase: 'scrobbles', done: page, total };
  }, sk);
  aggregate(state, pending);
  await writeJson(userFile, state);

  const albumFile = path.join(CACHE, 'albums.json');
  const cache = await readJson<Record<string, AlbumCacheEntry>>(albumFile, {});
  const entries = Object.entries(state.plays).filter(([k, e]) => needsLookup(e) && !(k in cache));
  job.progress = { phase: 'albums', done: 0, total: entries.length };
  try {
    await pool(entries, ALBUM_CONCURRENCY, async ([key, e]) => {
      const info = await getAlbumInfo(e.artist, e.album);
      cache[key] = info && {
        tracks: getTracklist(info),
        image: info.image?.find((i) => i.size === 'extralarge')?.['#text'] || '',
        url: info.url,
      };
      job.progress.done++;
    });
  } finally {
    await writeJson(albumFile, cache);
  }

  return { state, cache };
}

function rankGrid({ state, cache }: { state: ScrobbleState; cache: Record<string, AlbumCacheEntry> }, range: Range): GridAlbum[] {
  const albums: GridAlbum[] = [];
  for (const [key, e] of Object.entries(state.plays)) {
    const info = cache[key];
    if (!info) continue;
    const r = computeAlbum(e, info.tracks, range);
    if (r) albums.push({ ...r, image: info.image, url: info.url });
  }
  return sortAlbums(albums);
}

const sessions = new Map(Object.entries(await readJson<Record<string, Session>>(SESSIONS_FILE, {}))); // sid -> {name, key}
const saveSessions = () => writeJson(SESSIONS_FILE, Object.fromEntries(sessions));

const getSid = (req: http.IncomingMessage) => req.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
function getSessionFor(req: http.IncomingMessage): Session | undefined {
  const sid = getSid(req);
  return sid === undefined ? undefined : sessions.get(sid);
}

function startJob(user: string, session?: Session): Job {
  const id = user.toLowerCase();
  const existing = jobs.get(id);
  const isOwner = session?.name.toLowerCase() === id;
  if (existing?.status === 'running' || (existing?.private && !isOwner)) return existing;
  const job: Job = { status: 'running', progress: { phase: 'scrobbles', done: 0, total: 1 }, private: isOwner };
  jobs.set(id, job);
  loadData(user, job, isOwner ? session!.key : undefined).then(
    (data) => Object.assign(job, { status: 'done', ...data }),
    (err: LastfmError) => Object.assign(job, { status: 'error', message: err.message, code: err.code }),
  );
  return job;
}

function send(res: http.ServerResponse, code: number, body: unknown, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function redirect(res: http.ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { pathname, searchParams } = new URL(req.url!, 'http://localhost');
  if (pathname === '/login') {
    const cb = `http://${req.headers.host}/callback`;
    return redirect(res, `https://www.last.fm/api/auth/?${new URLSearchParams({ api_key: process.env.LASTFM_API_KEY!, cb })}`);
  }
  if (pathname === '/callback') {
    const { name, key } = await getSession(searchParams.get('token')!);
    const sid = randomUUID();
    sessions.set(sid, { name, key });
    await saveSessions();
    return redirect(res, `/?user=${encodeURIComponent(name)}`, {
      'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${YEAR}`,
    });
  }
  if (pathname === '/api/me') return send(res, 200, { name: getSessionFor(req)?.name ?? null });
  if (pathname === '/logout' && req.method === 'POST') {
    sessions.delete(getSid(req)!);
    await saveSessions();
    res.writeHead(204, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    res.end();
    return;
  }
  const m = pathname.match(/^\/api\/grid\/([^/]+)$/);
  if (m) {
    const user = decodeURIComponent(m[1]);
    if (!/^[\w.-]{1,64}$/.test(user)) return send(res, 400, { status: 'error', message: 'Invalid username' });
    if (req.method === 'POST') return send(res, 200, { status: startJob(user, getSessionFor(req)).status });
    const job = jobs.get(user.toLowerCase());
    if (!job) return send(res, 404, { status: 'error', message: 'No job for this user' });
    if (job.private && getSessionFor(req)?.name.toLowerCase() !== user.toLowerCase()) {
      return send(res, 403, { status: 'error', message: 'This profile is private' });
    }
    const { status, progress, message, code } = job;
    if (status === 'running') return send(res, 200, { status, progress });
    if (status === 'error') return send(res, 200, { status, message, code });
    const range: Range = {};
    for (const k of ['from', 'to'] as const) {
      const v = searchParams.get(k);
      if (v) range[k] = Number(v);
      if (Number.isNaN(range[k])) return send(res, 400, { status: 'error', message: `Invalid ${k}` });
    }
    return send(res, 200, { status, albums: rankGrid({ state: job.state!, cache: job.cache! }, range) });
  }
  const file = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(DIST + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    send(res, 200, await readFile(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EISDIR') throw err;
    send(res, 404, 'Not found', 'text/plain');
  }
}

const port = Number(process.env.PORT) || 3000;
http.createServer((req, res) => {
  handle(req, res).catch((err: Error) => send(res, 500, { status: 'error', message: err.message }));
}).listen(port, () => console.log(`http://localhost:${port}`));

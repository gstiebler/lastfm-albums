import { useEffect, useRef, useState } from 'react';
import AlbumPanel from './components/AlbumPanel.tsx';
import AlbumTile from './components/AlbumTile.tsx';
import AuthStatus, { SignInLink } from './components/AuthStatus.tsx';
import type { Album, GridResponse, Progress, Sort } from './types.ts';

function progressText({ phase, done, total }: Progress) {
  return phase === 'scrobbles'
    ? `Fetching scrobbles: page ${done}/${total}`
    : `Looking up albums: ${done}/${total}`;
}

// Date input value (YYYY-MM-DD) -> unix seconds in local time; `to` is the last second of that day.
function toUts(date: string, endOfDay = false): number | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T00:00:00`);
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.getTime() / 1000 - (endOfDay ? 1 : 0);
}

async function api(user: string, method: 'GET' | 'POST', from = '', to = '', sort: Sort = 'plays'): Promise<GridResponse> {
  const q = new URLSearchParams();
  const f = toUts(from);
  const t = toUts(to, true);
  if (f !== undefined) q.set('from', String(f));
  if (t !== undefined) q.set('to', String(t));
  if (sort !== 'plays') q.set('sort', sort);
  const res = await fetch(`/api/grid/${encodeURIComponent(user)}?${q}`, { method });
  return res.json();
}

export default function App() {
  const params = new URLSearchParams(location.search);
  const initial = params.get('user') ?? '';
  const [input, setInput] = useState(initial);
  const [run, setRun] = useState({ user: initial, n: 0 }); // submitted username
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [sort, setSort] = useState<Sort>(params.get('sort') === 'recent' ? 'recent' : 'plays');
  const [ready, setReady] = useState(''); // user whose job is done
  const [status, setStatus] = useState('');
  const [error, setError] = useState<{ message: string; code?: number } | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [open, setOpen] = useState<Album | null>(null);
  const runId = useRef(0);
  const query = useRef({ from, to, sort }); // latest params for the poll loop
  query.current = { from, to, sort };

  // Poll the job for `user`; a change of `user` cancels the previous run.
  useEffect(() => {
    const { user } = run;
    if (!user) return;
    const id = ++runId.current;
    setAlbums([]);
    setError(null);
    setReady('');
    setStatus('Starting…');

    async function load() {
      await api(user, 'POST');
      while (id === runId.current) {
        const q = query.current;
        const data = await api(user, 'GET', q.from, q.to, q.sort);
        if (id !== runId.current) return;
        if (data.status === 'running') {
          setStatus(progressText(data.progress));
          if (data.albums) setAlbums(data.albums); // partial grid; keep the previous one until this arrives
        } else if (data.status === 'done') {
          setReady(user);
          return;
        } else {
          setStatus('');
          setError(data);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    load().catch((err: Error) => {
      if (id !== runId.current) return;
      setStatus('');
      setError({ message: err.message });
    });
    return () => { runId.current++; };
  }, [run]);

  // Keep the URL in sync with the inputs.
  useEffect(() => {
    if (!run.user) return;
    const q = new URLSearchParams({ user: run.user });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (sort !== 'plays') q.set('sort', sort);
    history.replaceState(null, '', `?${q}`);
  }, [run.user, from, to, sort]);

  // Once the job is done, (re-)rank on the server whenever the range changes.
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    api(ready, 'GET', from, to, sort).then((data) => {
      if (stale) return;
      if (data.status === 'done') {
        setStatus(`${data.albums.length} albums`);
        setAlbums(data.albums);
      } else if (data.status === 'error') {
        setStatus('');
        setError(data);
      }
    }).catch((err: Error) => {
      if (!stale) setError({ message: err.message });
    });
    return () => { stale = true; };
  }, [ready, from, to, sort]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setRun((r) => ({ user: input.trim(), n: r.n + 1 })); // n: resubmitting the same user re-runs
  }

  return (
    <>
      <header>
        <h1>Album Grid</h1>
        <AuthStatus />
        <form id="form" onSubmit={submit}>
          <input
            id="user" name="user" placeholder="Last.fm username" autoComplete="off" required
            value={input} onChange={(e) => setInput(e.target.value)}
          />
          <label>From <input type="date" name="from" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" name="to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
          <label>Sort
            <select name="sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="plays">Most plays</option>
              <option value="recent">Recently completed</option>
            </select>
          </label>
          <button type="submit">Show</button>
        </form>
        <p id="status" role="status">{status}</p>
        <p id="error" role="alert">
          {error && (error.code === 17
            ? <>This profile is private — <SignInLink /></>
            : error.message)}
        </p>
      </header>
      <main id="grid">
        {albums.map((a) => <AlbumTile key={a.key} a={a} sort={sort} onOpen={() => setOpen(a)} />)}
      </main>
      {open && <AlbumPanel user={run.user} a={open} sort={sort} from={toUts(from)} to={toUts(to, true)} onClose={() => setOpen(null)} />}
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import AlbumTile from './components/AlbumTile.tsx';
import AuthStatus, { SignInLink } from './components/AuthStatus.tsx';
import type { Album, GridResponse, Progress } from './types.ts';

function progressText({ phase, done, total }: Progress) {
  return phase === 'scrobbles'
    ? `Fetching scrobbles: page ${done}/${total}`
    : `Looking up albums: ${done}/${total}`;
}

async function api(user: string, method: 'GET' | 'POST'): Promise<GridResponse> {
  const res = await fetch(`/api/grid/${encodeURIComponent(user)}`, { method });
  return res.json();
}

export default function App() {
  const initial = new URLSearchParams(location.search).get('user') ?? '';
  const [input, setInput] = useState(initial);
  const [run, setRun] = useState({ user: initial, n: 0 }); // submitted username
  const [status, setStatus] = useState('');
  const [error, setError] = useState<{ message: string; code?: number } | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const runId = useRef(0);

  // Poll the job for `user`; a change of `user` cancels the previous run.
  useEffect(() => {
    const { user } = run;
    if (!user) return;
    const id = ++runId.current;
    setAlbums([]);
    setError(null);
    setStatus('Starting…');
    history.replaceState(null, '', `?user=${encodeURIComponent(user)}`);

    async function load() {
      await api(user, 'POST');
      while (id === runId.current) {
        const data = await api(user, 'GET');
        if (id !== runId.current) return;
        if (data.status === 'running') {
          setStatus(progressText(data.progress));
        } else if (data.status === 'done') {
          setStatus(`${data.albums.length} albums`);
          setAlbums(data.albums);
          return;
        } else {
          setStatus('');
          setError(data);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    load().catch((err: Error) => {
      if (id !== runId.current) return;
      setStatus('');
      setError({ message: err.message });
    });
    return () => { runId.current++; };
  }, [run]);

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
        {albums.map((a) => <AlbumTile key={a.url + a.album} a={a} />)}
      </main>
    </>
  );
}

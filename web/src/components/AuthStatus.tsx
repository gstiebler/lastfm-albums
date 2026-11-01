import { useEffect, useState } from 'react';

export function SignInLink() {
  return <a href="/login">Sign in with Last.fm</a>;
}

export default function AuthStatus() {
  const [name, setName] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    fetch('/api/me').then((r) => r.json()).then((d: { name: string | null }) => setName(d.name));
  }, []);

  async function signOut(e: React.MouseEvent) {
    e.preventDefault();
    await fetch('/logout', { method: 'POST' });
    location.reload();
  }

  return (
    <p id="auth">
      {name === undefined ? null : name === null
        ? <SignInLink />
        : <>Signed in as {name} · <a href="#" onClick={signOut}>Sign out</a></>}
    </p>
  );
}

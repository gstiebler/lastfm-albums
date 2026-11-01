import { getSession } from '../shared/lastfm.ts';
import type { Config, Session } from '../shared/lastfm.ts';
import { shared } from './env.ts';
import type { Env } from './env.ts';

export { UserDO } from './user.ts';
export { SharedDO } from './shared.ts';

const YEAR = 365 * 24 * 3600;
const cookie = (value: string, maxAge: number) => `sid=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function route(req: Request, env: Env): Promise<Response> {
  const { origin, pathname, searchParams } = new URL(req.url);
  const cfg: Config = { apiKey: env.LASTFM_API_KEY, secret: env.LASTFM_SHARED_SECRET };
  const sid = req.headers.get('Cookie')?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  const getSessionFor = async (): Promise<Session | null> => (sid ? shared(env).getSession(sid) : null);

  if (pathname === '/login') {
    const cb = `${origin}/callback`;
    return Response.redirect(`https://www.last.fm/api/auth/?${new URLSearchParams({ api_key: cfg.apiKey, cb })}`, 302);
  }
  if (pathname === '/callback') {
    const { name, key } = await getSession(cfg, searchParams.get('token')!);
    const newSid = crypto.randomUUID();
    await shared(env).putSession(newSid, name, key);
    return new Response(null, { status: 302, headers: { Location: `/?user=${encodeURIComponent(name)}`, 'Set-Cookie': cookie(newSid, YEAR) } });
  }
  if (pathname === '/api/me') return json({ name: (await getSessionFor())?.name ?? null });
  if (pathname === '/logout' && req.method === 'POST') {
    if (sid) await shared(env).deleteSession(sid);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie('', 0) } });
  }
  const m = pathname.match(/^\/api\/grid\/([^/]+)(\/album)?$/);
  if (m) {
    const user = decodeURIComponent(m[1]);
    if (!/^[\w.-]{1,64}$/.test(user)) return json({ status: 'error', message: 'Invalid username' }, 400);
    const stub = env.USER.get(env.USER.idFromName(user.toLowerCase()));
    const session = await getSessionFor();
    if (req.method === 'POST') return json(await stub.start(user, session));
    const q = { key: searchParams.get('key'), from: searchParams.get('from'), to: searchParams.get('to'), sort: searchParams.get('sort') };
    const { code, body } = await stub.read(session, Boolean(m[2]), q);
    return json(body, code);
  }
  return json({ status: 'error', message: 'Not found' }, 404);
}

export default {
  fetch: (req, env) => route(req, env).catch((err: Error) => json({ status: 'error', message: err.message }, 500)),
} satisfies ExportedHandler<Env>;

import type { UserDO } from './user.ts';
import type { SharedDO } from './shared.ts';

export type Env = {
  LASTFM_API_KEY: string;
  LASTFM_SHARED_SECRET: string;
  USER: DurableObjectNamespace<UserDO>;
  SHARED: DurableObjectNamespace<SharedDO>;
};

export const shared = (env: Env) => env.SHARED.get(env.SHARED.idFromName('shared'));

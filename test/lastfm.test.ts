import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sign, getRecentTracksPage } from '../shared/lastfm.ts';

test('sign: md5 of sorted key+value + secret, ignoring format and callback', () => {
  const expected = createHash('md5').update('api_keykmethodauth.getSessiontokents').digest('hex');
  const params = { token: 't', method: 'auth.getSession', api_key: 'k', format: 'json', callback: 'x' };
  assert.equal(sign(params, 's'), expected);
});

test('getRecentTracksPage wraps a lone track object in an array', async () => {
  const track = { name: 'T', artist: { '#text': 'A' }, album: { '#text': 'B' }, date: { uts: '1' } };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ recenttracks: { track, '@attr': { totalPages: '1' } } });
  try {
    const r = await getRecentTracksPage({ apiKey: 'k', secret: 's' }, 'u', 1, { to: 2 });
    assert.deepEqual(r, { tracks: [track], totalPages: 1 });
  } finally {
    globalThis.fetch = orig;
  }
});

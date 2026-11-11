import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sign, getRecentTracksPage, getAlbumInfo, baseAlbumName } from '../shared/lastfm.ts';

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

test('baseAlbumName strips edition suffixes', () => {
  assert.equal(baseAlbumName('Rendez-Vous (2015 Remaster)'), 'Rendez-Vous');
  assert.equal(baseAlbumName('Abbey Road [Deluxe] (Remastered)'), 'Abbey Road');
  assert.equal(baseAlbumName('Oxygène - Remastered 2014'), 'Oxygène');
  assert.equal(baseAlbumName('Rendez-Vous'), 'Rendez-Vous');
  assert.equal(baseAlbumName('(What\'s the Story)'), '(What\'s the Story)');
});

test('getAlbumInfo retries with base name when tracklist is empty', async () => {
  const orig = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = async (url) => {
    const album = new URL(String(url)).searchParams.get('album')!;
    asked.push(album);
    const tracks = album === 'X' ? { track: [{ name: 'a' }, { name: 'b' }] } : undefined;
    return Response.json({ album: { url: album, tracks } });
  };
  try {
    const info = await getAlbumInfo({ apiKey: 'k', secret: 's' }, 'A', 'X (2015 Remaster)');
    assert.deepEqual(asked, ['X (2015 Remaster)', 'X']);
    assert.equal(info!.url, 'X');
  } finally {
    globalThis.fetch = orig;
  }
});

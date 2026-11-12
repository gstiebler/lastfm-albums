import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getListensPage } from '../shared/listenbrainz.ts';
import { getRelease } from '../shared/musicbrainz.ts';

const cfg = { apiKey: 'k', secret: 's' };

async function mock<T>(handler: (url: URL) => Response, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => handler(new URL(String(url)));
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test('getListensPage parses listens, with and without mbid_mapping', async () => {
  const listens = [
    { listened_at: 300, track_metadata: { artist_name: 'A', track_name: 'T1', release_name: 'X', mbid_mapping: { recording_mbid: 'rec1', release_mbid: 'rel1' } } },
    { listened_at: 200, track_metadata: { artist_name: 'A', track_name: 'T2', release_name: 'X' } },
  ];
  let asked!: URL;
  const r = await mock((url) => { asked = url; return Response.json({ payload: { listens } }); }, () => getListensPage(cfg, 'me', { from: 101, maxTs: 400 }));
  assert.equal(asked.pathname, '/1/user/me/listens');
  assert.equal(asked.searchParams.get('max_ts'), '400');
  assert.equal(asked.searchParams.get('min_ts'), '100'); // min_ts is exclusive; from is inclusive
  assert.equal(asked.searchParams.get('count'), '1000');
  assert.equal(r.oldest, 200);
  assert.equal(r.last, true);
  assert.deepEqual(r.tracks[0], { artist: { '#text': 'A' }, album: { '#text': 'X' }, name: 'T1', date: { uts: '300' }, mbid: 'rec1', releaseMbid: 'rel1' });
  assert.equal(r.tracks[1].mbid, undefined);
  assert.equal(r.tracks[1].releaseMbid, undefined);
});

test('getListensPage: full page is not last, no min_ts without from', async () => {
  const listens = Array.from({ length: 1000 }, (_, i) => ({ listened_at: 5000 - i, track_metadata: { artist_name: 'A', track_name: 'T', release_name: 'X' } }));
  let asked!: URL;
  const r = await mock((url) => { asked = url; return Response.json({ payload: { listens } }); }, () => getListensPage(cfg, 'me', { maxTs: 6000 }));
  assert.equal(asked.searchParams.has('min_ts'), false);
  assert.equal(r.last, false);
  assert.equal(r.oldest, 4001);
});

test('getRelease parses tracks, recordings, cover and url', async () => {
  const release = {
    'cover-art-archive': { front: true },
    media: [
      { tracks: [{ title: 'One', recording: { id: 'r1' } }, { title: 'Two', recording: { id: 'r2' } }] },
      { tracks: [{ title: 'Three', recording: { id: 'r3' } }] },
    ],
  };
  const r = await mock(() => Response.json(release), () => getRelease(cfg, 'abc'));
  assert.deepEqual(r, {
    tracks: ['One', 'Two', 'Three'],
    recordings: ['r1', 'r2', 'r3'],
    image: 'https://coverartarchive.org/release/abc/front-250',
    url: 'https://musicbrainz.org/release/abc',
  });
});

test('getRelease: no front cover -> empty image; 404 -> null', async () => {
  const release = { 'cover-art-archive': { front: false }, media: [{ tracks: [{ title: 'One', recording: { id: 'r1' } }] }] };
  assert.equal((await mock(() => Response.json(release), () => getRelease(cfg, 'abc')))!.image, '');
  assert.equal(await mock(() => new Response('{}', { status: 404 }), () => getRelease(cfg, 'abc')), null);
});

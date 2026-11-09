import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName, normalizeTrack, albumKey, aggregate, getTracklist,
  needsLookup, computeAlbum, scrobbleReason, albumTracks, extraTracks, sortAlbums, MIN_DISTINCT_TRACKS,
} from '../shared/rank.ts';

const scrobble = (artist: string, album: string, name: string, uts: number, extra = {}) => ({
  artist: { '#text': artist }, album: { '#text': album }, name, date: { uts: String(uts) }, ...extra,
});

test('normalizeName lowercases and trims', () => {
  assert.equal(normalizeName('  Abbey ROAD '), 'abbey road');
});

test('normalizeTrack strips remaster suffixes', () => {
  assert.equal(normalizeTrack('Money - Remastered 2011'), 'money');
  assert.equal(normalizeTrack('Money - 2011 Remaster'), 'money');
  assert.equal(normalizeTrack('Money (Remastered)'), 'money');
  assert.equal(normalizeTrack('Money [2011 Remastered Version]'), 'money');
  assert.equal(normalizeTrack('Time'), 'time');
});

test('albumKey combines normalized artist and album', () => {
  assert.equal(albumKey(' Pink Floyd', 'THE WALL '), albumKey('pink floyd', 'the wall'));
  assert.notEqual(albumKey('a', 'b'), albumKey('a', 'c'));
});

test('aggregate counts plays, skips nowplaying and empty albums, lastUts includes empty albums', () => {
  const state = aggregate({ version: 2, lastUts: 0, plays: {} }, [
    scrobble('A', 'X', 'one', 100),
    scrobble('A', 'X', 'One - Remastered', 200),
    scrobble('A', 'X', 'two', 150),
    scrobble('A', '', 'single', 300),
    { artist: { '#text': 'A' }, album: { '#text': 'X' }, name: 'live', '@attr': { nowplaying: 'true' } },
  ]);
  assert.equal(state.lastUts, 300); // album-less scrobbles count, so a refresh doesn't refetch them
  const key = albumKey('A', 'X');
  assert.deepEqual(Object.keys(state.plays), [key]);
  assert.equal(state.plays[key].artist, 'A');
  assert.equal(state.plays[key].album, 'X');
  assert.equal(state.version, 2);
  assert.deepEqual(state.plays[key].tracks.one.times, [100, 200]);
  assert.deepEqual(state.plays[key].tracks.two.times, [150]);
  assert.equal(state.plays[key].tracks.live, undefined);
});

test('aggregate merges into existing state', () => {
  const s1 = aggregate({ version: 2, lastUts: 0, plays: {} }, [scrobble('A', 'X', 'one', 100)]);
  const s2 = aggregate(s1, [scrobble('A', 'X', 'one', 500)]);
  assert.equal(s2.lastUts, 500);
  assert.deepEqual(s2.plays[albumKey('A', 'X')].tracks.one.times, [100, 500]);
});

test('getTracklist handles array, single object, missing', () => {
  assert.deepEqual(getTracklist({ tracks: { track: [{ name: 'a' }, { name: 'b' }] } }), ['a', 'b']);
  assert.deepEqual(getTracklist({ tracks: { track: { name: 'a' } } }), ['a']);
  assert.deepEqual(getTracklist({ tracks: {} }), []);
  assert.deepEqual(getTracklist({}), []);
  assert.deepEqual(getTracklist(null), []);
});

// tracks: name -> number of plays (all at time 100) or explicit times
const entry = (tracks: Record<string, number | number[]>) => ({
  artist: 'A', album: 'X',
  tracks: Object.fromEntries(Object.entries(tracks).map(([k, p]) =>
    [k, { name: k, times: Array.isArray(p) ? p : Array(p).fill(100) }])),
});

test('needsLookup requires MIN_DISTINCT_TRACKS distinct played tracks', () => {
  assert.equal(MIN_DISTINCT_TRACKS, 3);
  assert.equal(needsLookup(entry({ a: 5, b: 5 })), false);
  assert.equal(needsLookup(entry({ a: 1, b: 1, c: 1 })), true);
});

test('computeAlbum: pct, length, full plays with normalized matching', () => {
  const e = entry({ a: 4, b: 2, c: 7, 'not on album': 9 });
  const r = computeAlbum(e, ['A', 'B - Remastered 2011', 'C', 'D']);
  assert.equal(r!.heard, 3);
  assert.equal(r!.length, 4);
  assert.equal(r!.pct, 0.75);
  assert.equal(r!.full, 2);
});

test('computeAlbum merges played tracks that normalize to same tracklist track', () => {
  const e = entry({ a: 1, b: 1, c: 1 });
  e.tracks.a2 = { name: 'A (Remastered)', times: [100, 100, 100] };
  const r = computeAlbum(e, ['a', 'b', 'c']);
  assert.equal(r!.heard, 3);
  assert.equal(r!.length, 3);
});

test('computeAlbum excludes: tracklist <=1, none, <3 distinct played', () => {
  const e = entry({ a: 1, b: 1, c: 1 });
  assert.equal(computeAlbum(e, ['a']), null);
  assert.equal(computeAlbum(e, []), null);
  assert.equal(computeAlbum(entry({ a: 1, b: 1 }), ['a', 'b', 'c']), null);
});

test('computeAlbum range: values', () => {
  const e = entry({ a: [10, 20, 30], b: [20, 30], c: [30], d: [5] });
  const r = computeAlbum(e, ['a', 'b', 'c', 'd', 'e'], { from: 15, to: 30 });
  assert.equal(r!.heard, 3);
  assert.equal(r!.length, 5);
  assert.equal(r!.pct, 0.6);
  assert.equal(r!.full, 1);
});

test('computeAlbum range: from/to inclusive, either bound optional', () => {
  const e = entry({ a: [10, 20], b: [20], c: [20, 30] });
  assert.equal(computeAlbum(e, ['a', 'b', 'c', 'd'], { from: 20, to: 20 })!.heard, 3);
  assert.equal(computeAlbum(e, ['a', 'b', 'c', 'd'], { to: 19 }), null);
  assert.equal(computeAlbum(e, ['a', 'b', 'c', 'd'], { from: 21 }), null);
});

test('computeAlbum range: min-distinct rule applies to in-range plays', () => {
  const e = entry({ a: [10, 50], b: [10, 50], c: [10] });
  assert.equal(computeAlbum(e, ['a', 'b', 'c'], {})!.heard, 3);
  assert.equal(computeAlbum(e, ['a', 'b', 'c'], { from: 40 }), null);
});

test('computeAlbum: unbounded range equals no range', () => {
  const e = entry({ a: [1, 2, 3], b: [4, 5], c: [6], x: [7] });
  const tl = ['a', 'b', 'c', 'd'];
  assert.deepEqual(computeAlbum(e, tl, {}), computeAlbum(e, tl));
  assert.equal(computeAlbum(e, tl)!.full, 1);
  assert.equal(computeAlbum(e, tl)!.heard, 3);
});

test('sortAlbums: pct desc, then length desc, then full desc', () => {
  const a = { album: 'a', artist: 'x', heard: 0, pct: 1, length: 10, full: 1, completedAt: 0 };
  const b = { album: 'b', artist: 'x', heard: 0, pct: 1, length: 12, full: 1, completedAt: 0 };
  const c = { album: 'c', artist: 'x', heard: 0, pct: 1, length: 12, full: 5, completedAt: 0 };
  const d = { album: 'd', artist: 'x', heard: 0, pct: 0.5, length: 20, full: 9, completedAt: 0 };
  assert.deepEqual(sortAlbums([a, d, b, c]).map((x) => x.album), ['c', 'b', 'a', 'd']);
});

test('sortAlbums: full ties fall back to artist/album order and do not mutate input', () => {
  const a = { album: 'b', artist: 'x', heard: 0, pct: 1, length: 5, full: 1, completedAt: 0 };
  const b = { album: 'a', artist: 'x', heard: 0, pct: 1, length: 5, full: 1, completedAt: 0 };
  const input = [a, b];
  assert.deepEqual(sortAlbums(input).map((x) => x.album), ['a', 'b']);
  assert.equal(input[0], a);
});

test('computeAlbum completedAt: min over matched tracks of last in-range play', () => {
  const e = entry({ a: [10, 90], b: [50, 60], c: [30, 200], x: [1] });
  const tl = ['a', 'b', 'c', 'd'];
  assert.equal(computeAlbum(e, tl)!.completedAt, 60); // a:90 b:60 c:200 -> 60; x unmatched
  assert.equal(computeAlbum(e, tl, { to: 100 })!.completedAt, 30); // a:90 b:60 c:30
  assert.equal(computeAlbum(e, tl, { from: 40, to: 100 }), null); // only a, b in range
});

test('computeAlbum completedAt: ignores out-of-range and unmatched plays', () => {
  const e = entry({ a: [10, 20], b: [20, 25], c: [20, 300], x: [5] });
  assert.equal(computeAlbum(e, ['a', 'b', 'c', 'd'], { from: 15, to: 100 })!.completedAt, 20);
});

test('sortAlbums recent: pct first, then completedAt desc, then artist/album', () => {
  const al = (album: string, pct: number, completedAt: number) =>
    ({ album, artist: 'x', heard: 0, pct, length: 5, full: 1, completedAt });
  const input = [al('old', 1, 100), al('low', 0.5, 999), al('new', 1, 300), al('tieB', 1, 200), al('tieA', 1, 200)];
  assert.deepEqual(sortAlbums(input, 'recent').map((x) => x.album), ['new', 'tieA', 'tieB', 'old', 'low']);
  // default stays 'plays': ties on pct/length/full -> artist/album order
  assert.deepEqual(sortAlbums(input).map((x) => x.album), ['new', 'old', 'tieA', 'tieB', 'low']);
});

test('albumTracks: tracklist order, plays and lastPlayed, unplayed -> 0/null', () => {
  const e = entry({ b: [10, 40], a: [20], x: [5] });
  assert.deepEqual(albumTracks(e, ['A', 'B', 'C']), [
    { name: 'A', plays: 1, lastPlayed: 20 },
    { name: 'B', plays: 2, lastPlayed: 40 },
    { name: 'C', plays: 0, lastPlayed: null },
  ]);
});

test('albumTracks: matches by normalized name incl. remaster suffix', () => {
  const e = entry({ a: [10] });
  e.tracks.b2 = { name: 'B (Remastered)', times: [30, 50] };
  assert.deepEqual(albumTracks(e, ['a', 'B - Remastered 2011']).map((t) => t.plays), [1, 0]);
  e.tracks.b = { name: 'b', times: [30, 50] };
  assert.deepEqual(albumTracks(e, ['a', 'B - Remastered 2011'])[1], { name: 'B - Remastered 2011', plays: 2, lastPlayed: 50 });
});

test('albumTracks: range filters plays inclusively', () => {
  const e = entry({ a: [10, 20, 30], b: [5] });
  assert.deepEqual(albumTracks(e, ['a', 'b'], { from: 20, to: 30 }), [
    { name: 'a', plays: 2, lastPlayed: 30 },
    { name: 'b', plays: 0, lastPlayed: null },
  ]);
  assert.equal(albumTracks(e, ['a'], { to: 10 })[0].lastPlayed, 10);
});

test('albumTracks: duplicate normalized names appear once (first occurrence)', () => {
  const e = entry({ a: [10] });
  assert.deepEqual(albumTracks(e, ['A', 'b', 'a (Remastered)']), [
    { name: 'A', plays: 1, lastPlayed: 10 },
    { name: 'b', plays: 0, lastPlayed: null },
  ]);
});

test('sortAlbums artist: groups by summed heard, plays order within, normalized names, name tiebreak', () => {
  const al = (artist: string, album: string, heard: number, pct: number) =>
    ({ artist, album, heard, pct, length: 10, full: 1, completedAt: 0 });
  const input = [al('X', 'x1', 5, 0.5), al('Y', 'y1', 10, 1), al('x', 'x2', 4, 0.9)];
  assert.deepEqual(sortAlbums(input, 'artist').map((a) => a.album), ['y1', 'x2', 'x1']);
  const g = sortAlbums([al('Foo', 'a', 1, 1), al('Bar', 'b', 1, 1), al('foo ', 'c', 1, 0.5)], 'artist');
  assert.deepEqual(g.map((a) => a.album), ['a', 'c', 'b']); // foo=2 beats bar=1
  const tie = sortAlbums([al('b', '1', 3, 1), al('a', '2', 3, 1)], 'artist');
  assert.deepEqual(tie.map((a) => a.album), ['2', '1']); // equal scores -> name
});

test('normalizeTrack: accents, case, whitespace, punctuation', () => {
  assert.equal(normalizeTrack('Café'), normalizeTrack('Cafe'));
  assert.equal(normalizeTrack('  Hello   World '), 'hello world');
  assert.equal(normalizeTrack("Don't Stop"), normalizeTrack('Dont Stop'));
  assert.equal(normalizeTrack('Rock & Roll'), 'rock and roll');
  assert.equal(normalizeTrack('Rock And Roll'), 'rock and roll');
  assert.equal(normalizeTrack('Hey, You!'), 'hey you');
});

test('normalizeTrack: strips feat/ft/with suffixes', () => {
  for (const s of ['Song (feat. X)', 'Song [ft. X]', 'Song (featuring X)', 'Song (with X)', 'Song - feat. X', 'Song feat. X', 'Song ft. X', 'Song featuring X', 'Song (Remastered 2011) (feat. X)']) {
    assert.equal(normalizeTrack(s), 'song', s);
  }
});

test('normalizeTrack: kept distinct', () => {
  const base = normalizeTrack('Song');
  for (const s of ['Song (Live)', 'Song - Remix', 'Song - Mono']) assert.notEqual(normalizeTrack(s), base, s);
  assert.equal(normalizeTrack('Dancing with Myself'), 'dancing with myself');
});

test('normalizeTrack: idempotent, never empty', () => {
  for (const s of ['Café (feat. X)', "Don't Stop - Remastered 2011", 'Rock & Roll', 'Song (Live)', 'Money [2011 Remaster]', '???', '...', 'Song feat. A (with B)']) {
    assert.equal(normalizeTrack(normalizeTrack(s)), normalizeTrack(s), s);
    assert.notEqual(normalizeTrack(s), '', s);
  }
  assert.equal(normalizeTrack('???'), '???');
});

test('computeAlbum with aliases: mapped track counts toward heard/full/completedAt', () => {
  const e = entry({ a: [10], b: [20], zzz: [30, 40] });
  assert.equal(computeAlbum(e, ['a', 'b', 'c'])!.heard, 2);
  const r = computeAlbum(e, ['a', 'b', 'c'], {}, { zzz: 'c' })!;
  assert.equal(r.heard, 3);
  assert.equal(r.full, 1);
  assert.equal(r.completedAt, 10);
});

test('computeAlbum with aliases: variants mapped to one song sum plays, no distinct inflation', () => {
  const e = entry({ a: [10], v1: [20], v2: [30] });
  assert.equal(computeAlbum(e, ['a', 'c', 'd'], {}, { v1: 'c', v2: 'c' }), null); // 2 distinct keys < 3
  const r = computeAlbum(entry({ a: [10], b: [15], v1: [20], v2: [30] }), ['a', 'b', 'c'], {}, { v1: 'c', v2: 'c' })!;
  assert.equal(r.heard, 3);
  assert.equal(albumTracks(entry({ v1: [20], v2: [30] }), ['c'], {}, { v1: 'c', v2: 'c' })[0].plays, 2);
});

test('computeAlbum: unmapped extra does not count', () => {
  const r = computeAlbum(entry({ a: [10], b: [20], x: [30], y: [40] }), ['a', 'b', 'c'])!;
  assert.equal(r.heard, 2);
});

test('albumTracks with aliases', () => {
  const e = entry({ a: [10], zzz: [30, 50] });
  assert.deepEqual(albumTracks(e, ['a', 'C'], {}, { zzz: 'c' }), [
    { name: 'a', plays: 1, lastPlayed: 10 },
    { name: 'C', plays: 2, lastPlayed: 50 },
  ]);
});

test('extraTracks: only non-tracklist, respects range, fills mapped track, sorted by plays', () => {
  const e = entry({ a: [10], x: [5], y: [20, 30], z: [100] });
  assert.deepEqual(extraTracks(e, ['A', 'B']), [
    { name: 'y', plays: 2, track: null },
    { name: 'x', plays: 1, track: null },
    { name: 'z', plays: 1, track: null },
  ]);
  assert.deepEqual(extraTracks(e, ['A', 'B'], { from: 15, to: 50 }), [{ name: 'y', plays: 2, track: null }]);
  assert.deepEqual(extraTracks(e, ['A', 'B'], { from: 15, to: 50 }, { y: 'b' }), [{ name: 'y', plays: 2, track: 'B' }]);
});

test('scrobbleReason covers each branch', () => {
  const few = entry({ a: [1], b: [2] });
  const many = entry({ a: [1], b: [2], c: [3] });
  const info = { tracks: ['A', 'B', 'C'] };
  assert.equal(scrobbleReason('', undefined, undefined, false, 'a', {}), 'no album tag');
  assert.equal(scrobbleReason('x', few, undefined, false, 'a', {}), 'fewer than 3 distinct tracks (2)');
  assert.equal(scrobbleReason('x', many, undefined, false, 'a', {}), 'album lookup pending');
  assert.equal(scrobbleReason('x', many, null, true, 'a', {}), 'album not found on Last.fm');
  assert.equal(scrobbleReason('x', many, { tracks: ['A'] }, true, 'a', {}), 'empty tracklist');
  assert.equal(scrobbleReason('x', many, info, true, 'z', {}), 'track not on tracklist');
  assert.equal(scrobbleReason('x', many, info, true, 'z', { z: 'a' }), 'in grid');
  assert.equal(scrobbleReason('x', many, info, true, 'A (Remastered)', {}), 'in grid');
});

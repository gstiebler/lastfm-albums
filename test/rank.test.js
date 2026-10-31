import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName, normalizeTrack, albumKey, aggregate, getTracklist,
  needsLookup, computeAlbum, sortAlbums, MIN_DISTINCT_TRACKS,
} from '../src/rank.js';

const scrobble = (artist, album, name, uts, extra = {}) => ({
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

test('aggregate counts plays, skips nowplaying and empty albums, tracks lastUts', () => {
  const state = aggregate({ lastUts: 0, plays: {} }, [
    scrobble('A', 'X', 'one', 100),
    scrobble('A', 'X', 'One - Remastered', 200),
    scrobble('A', 'X', 'two', 150),
    scrobble('A', '', 'single', 300),
    { artist: { '#text': 'A' }, album: { '#text': 'X' }, name: 'live', '@attr': { nowplaying: 'true' } },
  ]);
  assert.equal(state.lastUts, 200);
  const key = albumKey('A', 'X');
  assert.deepEqual(Object.keys(state.plays), [key]);
  assert.equal(state.plays[key].artist, 'A');
  assert.equal(state.plays[key].album, 'X');
  assert.equal(state.plays[key].tracks.one.plays, 2);
  assert.equal(state.plays[key].tracks.two.plays, 1);
  assert.equal(state.plays[key].tracks.live, undefined);
});

test('aggregate merges into existing state', () => {
  const s1 = aggregate({ lastUts: 0, plays: {} }, [scrobble('A', 'X', 'one', 100)]);
  const s2 = aggregate(s1, [scrobble('A', 'X', 'one', 500)]);
  assert.equal(s2.lastUts, 500);
  assert.equal(s2.plays[albumKey('A', 'X')].tracks.one.plays, 2);
});

test('getTracklist handles array, single object, missing', () => {
  assert.deepEqual(getTracklist({ tracks: { track: [{ name: 'a' }, { name: 'b' }] } }), ['a', 'b']);
  assert.deepEqual(getTracklist({ tracks: { track: { name: 'a' } } }), ['a']);
  assert.deepEqual(getTracklist({ tracks: {} }), []);
  assert.deepEqual(getTracklist({}), []);
  assert.deepEqual(getTracklist(null), []);
});

const entry = (tracks) => ({
  artist: 'A', album: 'X',
  tracks: Object.fromEntries(Object.entries(tracks).map(([k, p]) => [k, { name: k, plays: p }])),
});

test('needsLookup requires MIN_DISTINCT_TRACKS distinct played tracks', () => {
  assert.equal(MIN_DISTINCT_TRACKS, 3);
  assert.equal(needsLookup(entry({ a: 5, b: 5 })), false);
  assert.equal(needsLookup(entry({ a: 1, b: 1, c: 1 })), true);
});

test('computeAlbum: pct, length, full plays with normalized matching', () => {
  const e = entry({ a: 4, b: 2, c: 7, 'not on album': 9 });
  const r = computeAlbum(e, ['A', 'B - Remastered 2011', 'C', 'D']);
  assert.equal(r.heard, 3);
  assert.equal(r.length, 4);
  assert.equal(r.pct, 0.75);
  assert.equal(r.full, 2);
});

test('computeAlbum merges played tracks that normalize to same tracklist track', () => {
  const e = entry({ a: 1, b: 1, c: 1 });
  e.tracks.a2 = { name: 'A (Remastered)', plays: 3 };
  const r = computeAlbum(e, ['a', 'b', 'c']);
  assert.equal(r.heard, 3);
  assert.equal(r.length, 3);
});

test('computeAlbum excludes: tracklist <=1, none, <3 distinct played', () => {
  const e = entry({ a: 1, b: 1, c: 1 });
  assert.equal(computeAlbum(e, ['a']), null);
  assert.equal(computeAlbum(e, []), null);
  assert.equal(computeAlbum(entry({ a: 1, b: 1 }), ['a', 'b', 'c']), null);
});

test('sortAlbums: pct desc, then length desc, then full desc', () => {
  const a = { album: 'a', artist: 'x', pct: 1, length: 10, full: 1 };
  const b = { album: 'b', artist: 'x', pct: 1, length: 12, full: 1 };
  const c = { album: 'c', artist: 'x', pct: 1, length: 12, full: 5 };
  const d = { album: 'd', artist: 'x', pct: 0.5, length: 20, full: 9 };
  assert.deepEqual(sortAlbums([a, d, b, c]).map((x) => x.album), ['c', 'b', 'a', 'd']);
});

test('sortAlbums: full ties fall back to artist/album order and do not mutate input', () => {
  const a = { album: 'b', artist: 'x', pct: 1, length: 5, full: 1 };
  const b = { album: 'a', artist: 'x', pct: 1, length: 5, full: 1 };
  const input = [a, b];
  assert.deepEqual(sortAlbums(input).map((x) => x.album), ['a', 'b']);
  assert.equal(input[0], a);
});

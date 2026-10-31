import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sign } from '../src/lastfm.js';

test('sign: md5 of sorted key+value + secret, ignoring format and callback', () => {
  const expected = createHash('md5').update('api_keykmethodauth.getSessiontokents').digest('hex');
  const params = { token: 't', method: 'auth.getSession', api_key: 'k', format: 'json', callback: 'x' };
  assert.equal(sign(params, 's'), expected);
});

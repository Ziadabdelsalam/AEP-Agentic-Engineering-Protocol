import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePairingLink } from '../hub/public/pairing.js';

const ORIGIN = 'https://aep.example.com';

test('reads the full link that aep pair-browser prints', () => {
  assert.deepEqual(parsePairingLink(`${ORIGIN}/#pair/abc_1-2/s3cr-et_`, ORIGIN), { id: 'abc_1-2', secret: 's3cr-et_' });
});

test('copes with the spaces and line breaks that come with pasting', () => {
  assert.deepEqual(parsePairingLink(`  ${ORIGIN}/#pair/a/b\n`, ORIGIN), { id: 'a', secret: 'b' });
});

test('accepts the link without the address', () => {
  assert.deepEqual(parsePairingLink('#pair/a/b', ORIGIN), { id: 'a', secret: 'b' });
  assert.deepEqual(parsePairingLink('pair/a/b', ORIGIN), { id: 'a', secret: 'b' });
});

test('works on a local hub with a port', () => {
  assert.deepEqual(parsePairingLink('http://localhost:8787/#pair/a/b', 'http://localhost:8787'), { id: 'a', secret: 'b' });
});

test('refuses a link meant for a different hub', () => {
  assert.match(parsePairingLink('https://other.example.com/#pair/a/b', ORIGIN).error, /other\.example\.com/);
});

for (const bad of ['', 'hello', 'https://aep.example.com/', `${ORIGIN}/#pair/a`, `${ORIGIN}/#pair/a/b/c`, `${ORIGIN}/#pair/a/b c`, undefined]) {
  test(`refuses ${JSON.stringify(bad)}`, () => {
    assert.match(parsePairingLink(bad, ORIGIN).error, /pairing link/);
  });
}

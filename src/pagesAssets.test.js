import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetHandler, httpBucket, parseRange } from '../cloudflare/large-assets.js';

const bytes = new Uint8Array([1, 2, 3, 4, 5]);
const descriptor = { key: 'version/model.zip', sha256: 'abc123', size: bytes.length, contentType: 'application/zip', filename: 'model.zip' };
const handler = createAssetHandler({ '/model.zip': descriptor });

function fixture() {
  const reads = [];
  const env = {
    LARGE_ASSETS: { async get(key, options) {
      reads.push({ key, options });
      const range = options?.range;
      return { body: range ? bytes.slice(range.offset, range.offset + range.length) : bytes };
    } },
    ASSETS: { fetch: () => new Response('static page') },
  };
  const request = (headers = {}, method = 'GET') => new Request('https://example.com/model.zip', { method, headers });
  return { env, reads, request };
}

test('large assets stream intact with download headers, while ordinary routes remain static', async () => {
  const { env, reads, request } = fixture();
  const response = await handler.fetch(request(), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('Content-Type'), 'application/zip');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="model.zip"');
  assert.equal(response.headers.get('Content-Length'), '5');
  assert.equal(reads[0].key, descriptor.key);
  assert.equal(await (await handler.fetch(new Request('https://example.com/'), env, {})).text(), 'static page');
});

test('HEAD and conditional requests avoid downloading large objects', async () => {
  const { env, reads, request } = fixture();
  const head = await handler.fetch(request({}, 'HEAD'), env, {});
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '5');
  assert.equal(await head.text(), '');
  for (const value of ['"abc123"', 'W/"abc123"', '"other", "abc123"', '*']) {
    const response = await handler.fetch(request({ 'If-None-Match': value }), env, {});
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('Content-Length'), null);
  }
  assert.equal(reads.length, 0);
});

test('resumed downloads return exactly the requested bytes and respect If-Range', async () => {
  const { env, request } = fixture();
  const response = await handler.fetch(request({ Range: 'bytes=1-3' }), env, {});
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 1-3/5');
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(1, 4));
  const stale = await handler.fetch(request({ Range: 'bytes=1-', 'If-Range': '"old"' }), env, {});
  assert.equal(stale.status, 200);
  assert.deepEqual(new Uint8Array(await stale.arrayBuffer()), bytes);
});

test('invalid ranges and write requests cannot access the bucket', async () => {
  const { env, reads, request } = fixture();
  const response = await handler.fetch(request({ Range: 'bytes=5-' }), env, {});
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('Content-Range'), 'bytes */5');
  assert.equal((await handler.fetch(request({}, 'POST'), env, {})).status, 405);
  assert.equal(reads.length, 0);
  assert.deepEqual(parseRange('bytes=-2', 5), { offset: 3, length: 2 });
  assert.deepEqual(parseRange('bytes=2-999', 5), { offset: 2, length: 3 });
  assert.equal(parseRange('bytes=-0', 5), false);
  assert.equal(parseRange('bytes=3-1', 5), false);
  assert.equal(parseRange('bytes=1-2,3-4', 5), null);
  assert.equal(parseRange('invalid', 5), null);
});

test('missing or unavailable storage returns an error instead of an HTML success page', async () => {
  const { env, request } = fixture();
  env.LARGE_ASSETS.get = async () => null;
  assert.equal((await handler.fetch(request(), env, {})).status, 404);
  env.LARGE_ASSETS.get = async () => { throw new Error('Unavailable'); };
  const response = await handler.fetch(request(), env, {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '30');
});

test('httpBucket reads whole objects and ranges from the asset origin', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, init.headers.Range]);
    if (url.endsWith('/missing.zip')) return new Response(null, { status: 404 });
    return init.headers.Range ? new Response('bcd', { status: 206 }) : new Response('abcde', { status: 200 });
  };
  const bucket = httpBucket('https://assets.example.test/', fetcher);
  assert.equal(await new Response((await bucket.get('a b/model.zip')).body).text(), 'abcde');
  assert.equal(await new Response((await bucket.get('model.zip', { range: { offset: 1, length: 3 } })).body).text(), 'bcd');
  assert.equal(await bucket.get('missing.zip'), null);
  assert.deepEqual(calls, [
    ['https://assets.example.test/a%20b/model.zip', undefined],
    ['https://assets.example.test/model.zip', 'bytes=1-3'],
    ['https://assets.example.test/missing.zip', undefined],
  ]);
  const failing = httpBucket('https://assets.example.test', async () => new Response(null, { status: 200 }));
  await assert.rejects(failing.get('model.zip', { range: { offset: 0, length: 2 } }), /answered 200/);
});

// The large files live in the "colombo-atlas-assets" bucket on the VPS's Garage store, served
// read-only at LARGE_ASSETS_ORIGIN. An R2 binding named LARGE_ASSETS still takes precedence.
export const DEFAULT_LARGE_ASSETS_ORIGIN = 'https://colombo-assets.prabhavalabs.com';

// A bucket-like reader over HTTP: get(key, { range }) resolves to { body } or null when missing.
export function httpBucket(origin, fetcher = globalThis.fetch) {
  const base = origin.replace(/\/+$/, '');
  return {
    async get(key, options) {
      const url = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const range = options?.range;
      const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
      const response = await fetcher(url, { headers });
      if (response.status === 404) return null;
      if (!(range ? response.status === 206 : response.ok)) throw new Error(`Asset origin answered ${response.status}`);
      return { body: response.body };
    },
  };
}

// Only files listed by the build can be read from the bucket.
export function createAssetHandler(assets) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      const asset = assets[url.pathname];
      if (!asset) return env.ASSETS.fetch(request);
      if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      }

      const etag = `"${asset.sha256}"`;
      const headers = new Headers({
        'Content-Type': asset.contentType,
        'Content-Length': String(asset.size),
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'ETag': etag,
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
      });
      if (asset.filename) headers.set('Content-Disposition', `attachment; filename="${asset.filename}"`);
      const matches = request.headers.get('If-None-Match')?.split(',').some(value => {
        const candidate = value.trim().replace(/^W\//, '');
        return candidate === '*' || candidate === etag;
      });
      if (matches) {
        headers.delete('Content-Length');
        return new Response(null, { status: 304, headers });
      }
      if (request.method === 'HEAD') return new Response(null, { headers });

      const ifRange = request.headers.get('If-Range');
      const range = !ifRange || ifRange === etag
        ? parseRange(request.headers.get('Range'), asset.size) : null;
      if (range === false) {
        headers.set('Content-Range', `bytes */${asset.size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }

      try {
        const cache = globalThis.caches?.default;
        const cacheKey = new Request(`${url.origin}/__large-assets/${asset.sha256}`);
        if (!range && cache) {
          const cached = await cache.match(cacheKey);
          if (cached) return new Response(cached.body, { headers });
        }
        const bucket = env.LARGE_ASSETS ?? httpBucket(env.LARGE_ASSETS_ORIGIN || DEFAULT_LARGE_ASSETS_ORIGIN);
        const object = await bucket.get(asset.key, range ? { range } : undefined);
        if (!object) return new Response('Asset not found', { status: 404 });
        if (range) {
          headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`);
          headers.set('Content-Length', String(range.length));
        }
        const response = new Response(object.body, { status: range ? 206 : 200, headers });
        if (!range && cache) {
          const cached = response.clone();
          cached.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
          context.waitUntil(cache.put(cacheKey, cached).catch(() => {}));
        }
        return response;
      } catch {
        return new Response('Asset temporarily unavailable', { status: 503, headers: { 'Retry-After': '30' } });
      }
    },
  };
}

// Malformed or multipart ranges are ignored; unsatisfiable single ranges return 416.
export function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if ([start, end].some(n => n !== null && !Number.isSafeInteger(n))) return null;
  if (start === null) {
    if (!end || !size) return false;
    const length = Math.min(end, size);
    return { offset: size - length, length };
  }
  if (start >= size || (end !== null && end < start)) return false;
  return { offset: start, length: Math.min(end ?? size - 1, size - 1) - start + 1 };
}

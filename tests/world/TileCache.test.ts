// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { TileCache, TileFetchError } from '@/world/TileCache';

const TILE_BLOB = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const TILE_SIZE = 256;

type GlobalWithCaches = { caches?: CacheStorage };

function okResponse(): Response {
  return new Response(TILE_BLOB, { status: 200 });
}

function imageDecoder(): (blob: Blob) => Promise<ImageBitmap> {
  return async () => ({ width: TILE_SIZE, height: TILE_SIZE }) as ImageBitmap;
}

function pixelDecoder(): (
  blob: Blob,
) => Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  return async () => ({
    data: new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4).fill(128),
    width: TILE_SIZE,
    height: TILE_SIZE,
  });
}

/** Let every pending promise settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('TileCache', () => {
  it('fetches once and serves the second call from memory', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const cache = new TileCache({ fetchFn, decodeImage: imageDecoder(), decodePixels: pixelDecoder() });

    const first = await cache.getImage('https://tiles.test/a.png');
    const second = await cache.getImage('https://tiles.test/a.png');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.stats().memoryHits).toBe(1);
    expect(second).toBe(first);
    expect(cache.has('https://tiles.test/a.png')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('limits concurrency to the configured number', async () => {
    const release: (() => void)[] = [];
    const fetchFn = vi.fn(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      return okResponse();
    });
    const cache = new TileCache({
      concurrency: 2,
      fetchFn,
      decodeImage: imageDecoder(),
      decodePixels: pixelDecoder(),
    });

    const urls = ['a', 'b', 'c', 'd', 'e', 'f'].map((u) => `https://tiles.test/${u}.png`);
    const pending = urls.map((u) => cache.getImage(u));
    await flush();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(cache.stats().inFlight).toBe(2);
    expect(cache.stats().pending).toBe(4);

    let maxInFlight = 0;
    for (let i = 0; i < urls.length; i++) {
      const next = release.shift();
      if (next) next();
      await flush();
      maxInFlight = Math.max(maxInFlight, cache.stats().inFlight);
      expect(cache.stats().inFlight).toBeLessThanOrEqual(2);
    }

    await Promise.all(pending);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(cache.stats().inFlight).toBe(0);
    expect(cache.size).toBe(6);
  });

  it('runs lower priority numbers first', async () => {
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const key = String(url);
      started.push(key);
      await new Promise<void>((resolve) => gates.set(key, resolve));
      return okResponse();
    });
    const cache = new TileCache({
      concurrency: 1,
      fetchFn,
      decodeImage: imageDecoder(),
      decodePixels: pixelDecoder(),
    });

    const a = cache.getImage('a');
    await flush();
    expect(started).toEqual(['a']);

    const b = cache.getImage('b', 5);
    const c = cache.getImage('c', 1);
    const d = cache.getImage('d', 3);
    await flush();
    expect(started).toEqual(['a']);
    expect(cache.stats().pending).toBe(3);

    gates.get('a')?.();
    await flush();
    expect(started).toEqual(['a', 'c']);

    gates.get('c')?.();
    await flush();
    expect(started).toEqual(['a', 'c', 'd']);

    gates.get('d')?.();
    await flush();
    expect(started).toEqual(['a', 'c', 'd', 'b']);

    gates.get('b')?.();
    await Promise.all([a, b, c, d]);
    expect(started).toEqual(['a', 'c', 'd', 'b']);
  });

  it('rejects with TileFetchError carrying the HTTP status', async () => {
    const fetchFn = vi.fn(async () => new Response(TILE_BLOB, { status: 404 }));
    const cache = new TileCache({ fetchFn, decodeImage: imageDecoder(), decodePixels: pixelDecoder() });

    const err = await cache.getImage('https://tiles.test/missing.png').then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TileFetchError);
    expect((err as TileFetchError).status).toBe(404);
    expect((err as TileFetchError).url).toBe('https://tiles.test/missing.png');
    expect(cache.stats().failures).toBe(1);
  });

  it('rejects with status 0 on a network error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const cache = new TileCache({ fetchFn, decodeImage: imageDecoder(), decodePixels: pixelDecoder() });

    const err = await cache.getImage('https://tiles.test/offline.png').then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TileFetchError);
    expect((err as TileFetchError).status).toBe(0);
    expect(cache.stats().failures).toBe(1);
  });

  it('evicts least recently used beyond maxEntries and calls onEvict', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const cache = new TileCache({
      maxEntries: 2,
      fetchFn,
      decodeImage: imageDecoder(),
      decodePixels: pixelDecoder(),
    });
    const evicted: Array<{ url: string; value: ImageBitmap | Float32Array }> = [];
    cache.onEvict = (url, value) => {
      evicted.push({ url, value });
    };

    await cache.getImage('a');
    await cache.getImage('b');
    await cache.getImage('a'); // touch: 'a' is now the most recent
    await cache.getImage('c');

    expect(evicted.map((e) => e.url)).toEqual(['b']);
    expect(cache.size).toBe(2);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('works when caches is undefined', async () => {
    const g = globalThis as unknown as GlobalWithCaches;
    const saved = g.caches;
    delete g.caches;
    try {
      const fetchFn = vi.fn(async () => okResponse());
      const cache = new TileCache({
        fetchFn,
        decodeImage: imageDecoder(),
        decodePixels: pixelDecoder(),
      });

      const bitmap = await cache.getImage('https://tiles.test/a.png');
      expect(bitmap).toBeDefined();
      expect(cache.stats().storageHits).toBe(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      if (saved) g.caches = saved;
    }
  });

  it('uses Cache Storage when present', async () => {
    const store = new Map<string, Response>();
    const match = vi.fn(async (req: RequestInfo | URL) => store.get(String(req)));
    const put = vi.fn(async (req: RequestInfo | URL, res: Response) => {
      store.set(String(req), res);
    });
    const g = globalThis as unknown as GlobalWithCaches;
    const saved = g.caches;
    g.caches = { open: async () => ({ match, put }) } as unknown as CacheStorage;
    try {
      const firstFetch = vi.fn(async () => okResponse());
      const first = new TileCache({
        fetchFn: firstFetch,
        decodeImage: imageDecoder(),
        decodePixels: pixelDecoder(),
      });

      await first.getImage('https://tiles.test/a.png');
      expect(put).toHaveBeenCalledTimes(1);
      expect(match).toHaveBeenCalledTimes(1);

      const secondFetch = vi.fn(async () => okResponse());
      const second = new TileCache({
        fetchFn: secondFetch,
        decodeImage: imageDecoder(),
        decodePixels: pixelDecoder(),
      });

      const bitmap = await second.getImage('https://tiles.test/a.png');
      expect(bitmap).toBeDefined();
      expect(secondFetch).not.toHaveBeenCalled();
      expect(second.stats().storageHits).toBe(1);
      expect(second.stats().networkFetches).toBe(0);
    } finally {
      if (saved) g.caches = saved;
      else delete g.caches;
    }
  });

  it('cancel removes a queued request', async () => {
    const gates = new Map<string, () => void>();
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const key = String(url);
      await new Promise<void>((resolve) => gates.set(key, resolve));
      return okResponse();
    });
    const cache = new TileCache({
      concurrency: 1,
      fetchFn,
      decodeImage: imageDecoder(),
      decodePixels: pixelDecoder(),
    });

    const a = cache.getImage('a');
    await flush();
    const b = cache.getImage('b');
    await flush();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.stats().pending).toBe(1);

    cache.cancel('b');

    const err = await b.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TileFetchError);
    expect((err as TileFetchError).status).toBe(-1);
    expect((err as TileFetchError).url).toBe('b');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.stats().pending).toBe(0);

    gates.get('a')?.();
    await a;
  });

  it('decodes heights through decodePixels', async () => {
    const decodeImage = vi.fn(imageDecoder());
    const decodePixels = vi.fn(pixelDecoder());
    const fetchFn = vi.fn(async () => okResponse());
    const cache = new TileCache({ fetchFn, decodeImage, decodePixels });

    const heights = await cache.getHeights('https://tiles.test/elev.png');

    expect(heights).toBeInstanceOf(Float32Array);
    expect(heights.length).toBe(65536);
    expect(decodePixels).toHaveBeenCalledTimes(1);
    expect(decodeImage).not.toHaveBeenCalled();
    // Terrarium: r=128, g=128, b=128 -> 128 * 256 + 128 + 0.5 - 32768 = 128.5 m
    expect(heights[0]).toBeCloseTo(128.5, 3);
  });
});

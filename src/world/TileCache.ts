/**
 * Tile fetching for Boogie.
 *
 * A prioritised, concurrency-limited queue in front of an in-memory LRU, with
 * Cache Storage as a read-through/write-behind layer underneath. Every
 * browser seam (`fetch`, `caches`, `createImageBitmap`, `OffscreenCanvas`) is
 * injectable, so this module imports nothing from three.js and nothing from
 * the DOM at load time.
 */

import { decodeTerrarium } from './terrarium';

/** What a cached tile holds: a decoded image or a grid of heights. */
type Kind = 'image' | 'heights';

/**
 * A tile could not be fetched.
 *
 * `status` is the HTTP status code, 0 when the request never reached the
 * server, and -1 when the request was cancelled before it started.
 */
export class TileFetchError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`tile fetch failed (${status}): ${url}`);
    this.name = 'TileFetchError';
  }
}

export interface TileCacheOptions {
  /** Entries kept in the in-memory LRU, images and heights together. Default 512. */
  maxEntries?: number;
  /** Tiles fetched at the same time. Default 8. */
  concurrency?: number;
  /** Cache Storage bucket name. Default 'boogie-tiles-v1'. */
  cacheName?: string;
  /** Network fetch. Default the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Blob to image. Default `createImageBitmap`. */
  decodeImage?: (blob: Blob) => Promise<ImageBitmap>;
  /** Blob to raw pixels. Default ImageBitmap -> OffscreenCanvas -> getImageData. */
  decodePixels?: (blob: Blob) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>;
}

interface CacheEntry {
  kind: Kind;
  value: ImageBitmap | Float32Array;
}

interface QueueItem {
  kind: Kind;
  url: string;
  priority: number;
  /** Insertion order, so equal priorities keep their arrival order. */
  seq: number;
  resolve: (value: ImageBitmap | Float32Array) => void;
  reject: (error: unknown) => void;
}

export class TileCache {
  /** Called with every value that leaves the cache, so the caller can free it. */
  onEvict?: (url: string, value: ImageBitmap | Float32Array) => void;

  private readonly maxEntries: number;
  private readonly concurrency: number;
  private readonly cacheName: string;
  private readonly fetchFn: typeof fetch;
  private readonly decodeImageFn?: (blob: Blob) => Promise<ImageBitmap>;
  private readonly decodePixelsFn?: (
    blob: Blob,
  ) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>;

  /** The LRU: oldest key first, most recently used last. */
  private readonly lru = new Map<string, CacheEntry>();
  /** Requests waiting for a slot, ordered by priority when a slot frees up. */
  private readonly queue: QueueItem[] = [];
  /** Requests already made, so a repeat call joins the one in flight. */
  private readonly operations = new Map<string, Promise<ImageBitmap | Float32Array>>();
  /** Network reads in flight, shared by the image and the heights of a URL. */
  private readonly fetches = new Map<string, Promise<Blob>>();
  /** The opened Cache Storage bucket, `null` when there is none. */
  private storage: Cache | null | undefined = undefined;

  private running = 0;
  private seq = 0;
  private memoryHits = 0;
  private storageHits = 0;
  private networkFetches = 0;
  private failures = 0;

  constructor(opts: TileCacheOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? 512);
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.cacheName = opts.cacheName ?? 'boogie-tiles-v1';
    this.fetchFn =
      opts.fetchFn ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.decodeImageFn = opts.decodeImage;
    this.decodePixelsFn = opts.decodePixels;
  }

  /** The decoded image of a tile. Lower priority numbers are fetched first. */
  getImage(url: string, priority = 0): Promise<ImageBitmap> {
    return this.request('image', url, priority) as Promise<ImageBitmap>;
  }

  /** The heights of a Terrarium tile, in metres above mean sea level. */
  getHeights(url: string, priority = 0): Promise<Float32Array> {
    return this.request('heights', url, priority) as Promise<Float32Array>;
  }

  /** Drop a queued request that has not started yet. */
  cancel(url: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i];
      if (!item || item.url !== url) continue;
      this.queue.splice(i, 1);
      this.operations.delete(this.operationKey(item.kind, item.url));
      item.reject(new TileFetchError(url, -1));
    }
  }

  /** Whether the tile is in memory. */
  has(url: string): boolean {
    return this.lru.has(url);
  }

  /** How many tiles are in memory. */
  get size(): number {
    return this.lru.size;
  }

  stats(): {
    memoryHits: number;
    storageHits: number;
    networkFetches: number;
    failures: number;
    pending: number;
    inFlight: number;
  } {
    return {
      memoryHits: this.memoryHits,
      storageHits: this.storageHits,
      networkFetches: this.networkFetches,
      failures: this.failures,
      pending: this.queue.length,
      inFlight: this.running,
    };
  }

  private operationKey(kind: Kind, url: string): string {
    return `${kind}|${url}`;
  }

  private request(kind: Kind, url: string, priority: number): Promise<ImageBitmap | Float32Array> {
    const entry = this.lru.get(url);
    if (entry && entry.kind === kind) {
      this.touch(url);
      this.memoryHits++;
      return Promise.resolve(entry.value);
    }

    const key = this.operationKey(kind, url);
    const running = this.operations.get(key);
    if (running) return running;

    const promise = new Promise<ImageBitmap | Float32Array>((resolve, reject) => {
      this.queue.push({
        kind,
        url,
        priority,
        seq: this.seq++,
        resolve,
        reject,
      });
    });
    this.operations.set(key, promise);
    this.pump();
    return promise;
  }

  /** Start as many queued requests as the concurrency limit allows. */
  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const candidate = this.queue[i];
        const current = this.queue[best];
        if (!candidate || !current) continue;
        if (candidate.priority < current.priority ||
          (candidate.priority === current.priority && candidate.seq < current.seq)) {
          best = i;
        }
      }
      const item = this.queue.splice(best, 1)[0];
      if (!item) break;
      void this.run(item);
    }
  }

  private async run(item: QueueItem): Promise<void> {
    this.running++;
    try {
      const blob = await this.fetchBlob(item.url);
      const value =
        item.kind === 'image' ? await this.decodeImage(blob) : await this.decodeHeights(blob);
      this.store(item.url, item.kind, value);
      item.resolve(value);
    } catch (err) {
      this.failures++;
      item.reject(err instanceof TileFetchError ? err : new TileFetchError(item.url, 0));
    } finally {
      this.running--;
      this.operations.delete(this.operationKey(item.kind, item.url));
      this.pump();
    }
  }

  /** The bytes of a tile, from Cache Storage when possible, else from the network. */
  private fetchBlob(url: string): Promise<Blob> {
    const existing = this.fetches.get(url);
    if (existing) return existing;

    const promise = this.loadBlob(url);
    this.fetches.set(url, promise);
    const forget = (): void => {
      if (this.fetches.get(url) === promise) this.fetches.delete(url);
    };
    void promise.then(forget, forget);
    return promise;
  }

  private async loadBlob(url: string): Promise<Blob> {
    const cache = await this.openStorage();
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) {
          this.storageHits++;
          return await hit.blob();
        }
      } catch {
        // A broken cache entry is not fatal: fall through to the network.
      }
    }

    let response: Response;
    try {
      this.networkFetches++;
      response = await this.fetchFn(url);
    } catch {
      throw new TileFetchError(url, 0);
    }
    if (!response.ok) {
      throw new TileFetchError(url, response.status);
    }

    // Clone before the body is read, so the copy can still be stored.
    const copy = cache ? this.cloneResponse(response) : null;
    const blob = await response.blob();
    if (cache && copy) {
      try {
        await cache.put(url, copy);
      } catch {
        // Storing the tile is a convenience; failing to store it is not fatal.
      }
    }
    return blob;
  }

  private cloneResponse(response: Response): Response | null {
    try {
      return response.clone();
    } catch {
      return null;
    }
  }

  private async openStorage(): Promise<Cache | undefined> {
    if (this.storage !== undefined) return this.storage ?? undefined;
    const cacheStorage: CacheStorage | undefined = globalThis.caches;
    if (!cacheStorage) {
      this.storage = null;
      return undefined;
    }
    try {
      this.storage = await cacheStorage.open(this.cacheName);
    } catch {
      this.storage = null;
    }
    return this.storage ?? undefined;
  }

  private async decodeImage(blob: Blob): Promise<ImageBitmap> {
    if (this.decodeImageFn) return this.decodeImageFn(blob);
    return createImageBitmap(blob);
  }

  private async decodeHeights(blob: Blob): Promise<Float32Array> {
    let pixels: { data: Uint8ClampedArray; width: number; height: number };
    if (this.decodePixelsFn) {
      pixels = await this.decodePixelsFn(blob);
    } else {
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context to read the tile pixels');
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      pixels = { data: image.data, width: image.width, height: image.height };
    }
    return decodeTerrarium(pixels.data, pixels.width, pixels.height);
  }

  /**
   * Put a tile into the LRU and evict the least recently used ones.
   *
   * A URL holds one value, its image or its heights: imagery and elevation
   * come from different providers, so they never share a URL, and the two
   * share the `maxEntries` budget either way.
   */
  private store(url: string, kind: Kind, value: ImageBitmap | Float32Array): void {
    const previous = this.lru.get(url);
    if (previous) {
      this.lru.delete(url);
      this.notifyEvict(url, previous.value);
    }
    this.lru.set(url, { kind, value });

    while (this.lru.size > this.maxEntries) {
      let oldest: string | undefined;
      for (const key of this.lru.keys()) {
        oldest = key;
        break;
      }
      if (oldest === undefined) break;
      const entry = this.lru.get(oldest);
      this.lru.delete(oldest);
      if (entry) this.notifyEvict(oldest, entry.value);
    }
  }

  /** Move a tile to the most recently used end of the LRU. */
  private touch(url: string): void {
    const entry = this.lru.get(url);
    if (!entry) return;
    this.lru.delete(url);
    this.lru.set(url, entry);
  }

  private notifyEvict(url: string, value: ImageBitmap | Float32Array): void {
    const onEvict = this.onEvict;
    if (!onEvict) return;
    try {
      onEvict(url, value);
    } catch {
      // A failing consumer callback must not break the cache.
    }
  }
}

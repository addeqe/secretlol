import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateObservation } from './identity.ts';
import type { RetailClient, RetailPage, StoreScope } from './types.ts';
import { scopeKey, validateScope } from './types.ts';

const FORMAT_VERSION = 1;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCTS_PER_PAGE = 500;
const MAX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_READ_LIMIT = 64;

type CheckpointOptions = { now?: () => number; maxAgeMs?: number };
type Envelope = { version: 1; key: string; savedAt: string; page: RetailPage; checksum: string };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function pageKey(client: RetailClient, scope: StoreScope, categoryId: string, cursor?: string): string {
  return canonical([client.retailer, scopeKey(client.retailer, scope), categoryId, cursor ?? null]);
}

function normalizedScope(scope: StoreScope): StoreScope {
  return { storeId: scope.storeId, channel: scope.channel, ...(scope.slotId !== undefined ? { slotId: scope.slotId } : {}) };
}

function normalizedPage(page: RetailPage): RetailPage {
  return {
    categoryId: page.categoryId,
    scope: normalizedScope(page.scope),
    nextCursor: page.nextCursor,
    total: page.total,
    products: page.products.map(observation => ({
      retailer: observation.retailer,
      scope: normalizedScope(observation.scope),
      product: {
        id: observation.product.id,
        ean: observation.product.ean,
        name: observation.product.name,
        brand: observation.product.brand,
        categories: [...observation.product.categories],
        pack: observation.product.pack ? { ...observation.product.pack } : null,
        ingredientsText: observation.product.ingredientsText,
        ...(observation.product.url !== undefined ? { url: observation.product.url } : {}),
        ...(observation.product.imageUrl !== undefined ? { imageUrl: observation.product.imageUrl } : {}),
      },
      price: observation.price ? { ...observation.price } : null,
      availability: observation.availability,
      checkedAt: observation.checkedAt,
      expiresAt: observation.expiresAt,
      storeScopeVerified: observation.storeScopeVerified,
    })),
  };
}

function validatePage(client: RetailClient, requestedScope: StoreScope, categoryId: string,
  cursor: string | undefined, page: RetailPage, now: number): void {
  if (!page || !Array.isArray(page.products) || page.products.length > MAX_PRODUCTS_PER_PAGE
    || page.categoryId !== categoryId || !categoryId.trim()
    || !page.scope || scopeKey(client.retailer, page.scope) !== scopeKey(client.retailer, requestedScope)
    || page.total !== null && (!Number.isSafeInteger(page.total) || page.total < 0)
    || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 2000)
    || page.nextCursor === cursor
    || (!page.products.length && page.nextCursor !== null)) {
    throw new Error('invalid_checkpoint_page');
  }
  validateScope(page.scope);
  for (const observation of page.products) {
    validateObservation(observation, client.retailer, requestedScope);
    const checkedAt = Date.parse(observation.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > now) throw new Error('checkpoint_observation_from_future');
  }
}

function isFresh(page: RetailPage, savedAt: string, now: number, maxAgeMs: number): boolean {
  const saved = Date.parse(savedAt);
  if (!Number.isFinite(saved) || saved > now || now - saved > maxAgeMs) return false;
  if (page.products.length === 0) return page.total === 0;
  return page.products.every(observation => {
    const checked = Date.parse(observation.checkedAt);
    const expires = Date.parse(observation.expiresAt);
    return Number.isFinite(checked) && checked <= now && now - checked <= maxAgeMs
      && Number.isFinite(expires) && expires > now;
  });
}

async function cleanup(folder: string, now: number, maxAgeMs: number): Promise<void> {
  let names: string[];
  try { names = await readdir(folder); } catch { return; }
  let reads = 0;
  for (const name of names) {
    if (reads >= CLEANUP_READ_LIMIT) break;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    reads++;
    const path = join(folder, name);
    try {
      const info = await stat(path);
      if (info.size > MAX_PAGE_BYTES) { await rm(path, { force: true }); continue; }
      const raw = await readFile(path, 'utf8');
      const envelope: unknown = JSON.parse(raw);
      if (!isEnvelope(envelope) || !isFresh(envelope.page, envelope.savedAt, now, maxAgeMs)) {
        await rm(path, { force: true });
      }
    } catch {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<Envelope>;
  return envelope.version === FORMAT_VERSION && typeof envelope.key === 'string'
    && typeof envelope.savedAt === 'string' && typeof envelope.checksum === 'string'
    && !!envelope.page && typeof envelope.page === 'object';
}

async function readCheckpoint(path: string, key: string, client: RetailClient, scope: StoreScope,
  categoryId: string, cursor: string | undefined, now: number, maxAgeMs: number): Promise<RetailPage | null> {
  let raw: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PAGE_BYTES) return null;
    raw = await readFile(path, 'utf8');
  } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isEnvelope(parsed) || parsed.key !== key) return null;
  const envelope = parsed;
  const check = sha256(canonical({ version: envelope.version, key: envelope.key,
    savedAt: envelope.savedAt, page: envelope.page }));
  if (check !== envelope.checksum) return null;

  // A well-formed, checksummed page in the wrong scope is a validation failure, not stale data.
  const page = normalizedPage(envelope.page);
  validatePage(client, scope, categoryId, cursor, page, now);
  return isFresh(page, envelope.savedAt, now, maxAgeMs) ? page : null;
}

async function writeCheckpoint(path: string, key: string, page: RetailPage, now: number): Promise<void> {
  const savedAt = new Date(now).toISOString();
  const normalized = normalizedPage(page);
  const body = { version: FORMAT_VERSION, key, savedAt, page: normalized } as const;
  const envelope: Envelope = { ...body, checksum: sha256(canonical(body)) };
  const serialized = canonical(envelope);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAGE_BYTES) return;
  const temp = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(temp, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * Add a bounded, local page checkpoint around a retailer client. Only browse pages are
 * persisted; all other methods and properties continue to come from the original client.
 */
export function checkpointedClient(client: RetailClient, folder: string,
  options: CheckpointOptions = {}): RetailClient {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > MAX_MAX_AGE_MS) {
    throw new Error('invalid_checkpoint_max_age');
  }
  const browse = async (scope: StoreScope, categoryId: string, cursor?: string): Promise<RetailPage> => {
    validateScope(scope);
    if (typeof categoryId !== 'string' || !categoryId.trim() || categoryId.length > 500
      || cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2000)) {
      throw new Error('invalid_checkpoint_page_key');
    }
    const requestNow = now();
    const key = pageKey(client, scope, categoryId, cursor);
    const path = join(folder, `${sha256(key)}.json`);
    const cached = await readCheckpoint(path, key, client, scope, categoryId, cursor, requestNow, maxAgeMs);
    if (cached) return cached;

    const page = await client.browse(scope, categoryId, cursor);
    const responseNow = now();
    validatePage(client, scope, categoryId, cursor, page, responseNow);
    if (isFresh(page, new Date(responseNow).toISOString(), responseNow, maxAgeMs)) {
      const normalized = normalizedPage(page);
      if (normalized.products.every(o => Date.parse(o.checkedAt) <= responseNow
        && responseNow - Date.parse(o.checkedAt) <= maxAgeMs && Date.parse(o.expiresAt) > responseNow)) {
        await mkdir(folder, { recursive: true });
        await writeCheckpoint(path, key, normalized, responseNow);
        await cleanup(folder, responseNow, maxAgeMs);
      }
    }
    return page;
  };

  return new Proxy(client, {
    get(target, property) {
      if (property === 'browse') return browse;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

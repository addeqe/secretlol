import type { Entry } from '../src/types.ts';
import {catalogPageSql} from '../src/catalog-query.ts';
import { ingredientRoutes } from './ingredients.ts';
import { mealRoutes } from './meals.ts';
import { retailerRoutes, type RetailEnv } from './retailers.ts';
import { initializeCoopParserRuntime } from '../src/retailers/coop-parser-runtime.ts';
// Compile the small pure source parser before requests use the 10 ms CPU budget.
initializeCoopParserRuntime();
export type Env = { DB: D1Database; MEAL_DB?: D1Database; CATALOG_API_TOKEN: string; PRICE_MAX_AGE_HOURS?: string;
  GITHUB_REPOSITORY?: string; GITHUB_DISPATCH_TOKEN?: string; INGREDIENT_REVIEW_TOKEN?: string } & RetailEnv;
type Snapshot = { id: string; store_id: string; store_name: string; completed_at: string;
  started_at: string; product_count: number; report_json: string;oldest_observation_at?:string };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
} });
export function authorized(request: Request, secret: string) {
  const provided = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (provided.length !== secret.length) return false;
  let difference = 0;
  for (let i = 0; i < secret.length; i++) difference |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  return difference === 0;
}
export function expiresAt(entry: Pick<Entry, 'observedAt' | 'offers'>, ageHours = 24): string {
  let until = Date.parse(entry.observedAt) + ageHours * 3600000;
  // An offer may affect the listed price. Expire conservatively at its end.
  for (const offer of entry.offers as Array<{ validUntil?: unknown }>) {
    const expiry = typeof offer?.validUntil === 'number' ? offer.validUntil : NaN;
    if (Number.isFinite(expiry) && expiry > Date.parse(entry.observedAt)) until = Math.min(until, expiry);
  }
  return new Date(until).toISOString();
}
export function packPrice(entry: Entry, request: { unit?: unknown; packQuantity?: unknown }): number | null {
  if (entry.priceOre === null || entry.depositOre === null) return null;
  const unit = entry.priceUnit.replace(/\s/g, '').toLowerCase();
  if (/^kr\/(st|styck|förp|fp)$/.test(unit)) return entry.priceOre / 100;
  const quantity = request.packQuantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) return null;
  if (unit === 'kr/kg' && request.unit === 'g' || unit === 'kr/l' && request.unit === 'ml') {
    return Math.round(entry.priceOre * quantity / 1000) / 100;
  }
  return null;
}
async function requestJson(request: Request) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new Error('json_required');
  if (!request.body) throw new Error('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 150000) { await reader.cancel(); throw new Error('body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('invalid_json'); }
}
const validCode = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return json({ service: 'willys-catalog', ok: true });
  if (!env.CATALOG_API_TOKEN || env.CATALOG_API_TOKEN.length < 32) return json({ error: 'service_not_connected' }, 503);
  const reviewRoute=['/ingredients/review','/ingredients/refresh'].includes(url.pathname);
  if(reviewRoute&&(!env.INGREDIENT_REVIEW_TOKEN||env.INGREDIENT_REVIEW_TOKEN.length<32))return json({error:'review_not_connected'},503);
  if (!authorized(request, reviewRoute?env.INGREDIENT_REVIEW_TOKEN!:env.CATALOG_API_TOKEN)) return json({ error: 'unauthorized' }, 401);
  if(url.pathname.startsWith('/meal/'))return mealRoutes(request,env,requestJson);
  if(url.pathname==='/retailers'||url.pathname==='/retailers/openapi.json'||url.pathname==='/stores'||/^\/retailers\/(coop|ica)\/products$/.test(url.pathname))return retailerRoutes(request,env);
  let snapshot = await env.DB.prepare(`SELECT s.*,m.oldest_observation_at FROM snapshots s LEFT JOIN catalog_snapshot_storage m ON m.snapshot_id=s.id
    WHERE s.id=(SELECT value FROM catalog_state WHERE key='active_snapshot') AND s.status='complete'`).first<Snapshot>();
  if (!snapshot) return json({ error: 'catalogue_not_ready', message: 'Run the first catalogue sync.' }, 503);
  if(url.pathname==='/ingredients'||url.pathname.startsWith('/ingredients/'))return ingredientRoutes(request,env,snapshot,requestJson);
  const ageHours = Number(env.PRICE_MAX_AGE_HOURS ?? 24);
  if (!Number.isFinite(ageHours) || ageHours <= 0 || ageHours > 24) return json({ error: 'invalid_freshness_configuration' }, 503);
  if (url.pathname === '/status' && request.method === 'GET') {
    const oldest=snapshot.oldest_observation_at??(await env.DB.prepare(`SELECT MIN(observed_at) AS oldest
      FROM catalog_entries_read WHERE snapshot_id=?`).bind(snapshot.id).first<{oldest:string}>())?.oldest;
    return json({ store: { id: snapshot.store_id, name: snapshot.store_name }, products: snapshot.product_count,
      snapshotId: snapshot.id, lastSuccessfulSync: snapshot.completed_at, oldestObservation: oldest,
      fresh: !!oldest && Date.now() - Date.parse(oldest) < ageHours * 3600000,
      ...JSON.parse(snapshot.report_json) });
  }
  if (url.pathname === '/catalog' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json({ error: 'limit_must_be_1_to_100' }, 400);
    let after = '';
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
      let decoded: string;
      try { decoded = atob(cursor.replace(/-/g, '+').replace(/_/g, '/')); } catch { return json({ error: 'invalid_cursor' }, 400); }
      const separator = decoded.indexOf(':'); const id = decoded.slice(0, separator); after = decoded.slice(separator + 1);
      if (!/^[a-f0-9-]{36}$/i.test(id) || !validCode(after)) return json({ error: 'invalid_cursor' }, 400);
      const selected = await env.DB.prepare("SELECT * FROM snapshots WHERE id=? AND status='complete'").bind(id).first<Snapshot>();
      if (!selected) return json({ error: 'snapshot_expired', message: 'Restart pagination without a cursor.' }, 409);
      snapshot = selected;
    }
    const result = await env.DB.prepare(catalogPageSql()).bind(snapshot.id,after,limit+1,snapshot.id,after,limit+1,limit+1).all<{code:string;data_json:string}>();
    const entries = result.results.slice(0, limit).map(row => JSON.parse(row.data_json) as Entry);
    const products = entries.map(({ raw, priceHash, ...entry }) => ({ ...entry, expiresAt: expiresAt(entry, ageHours) }));
    const last = entries.at(-1);
    return json({ snapshotId: snapshot.id, storeId: snapshot.store_id, products,
      nextCursor: result.results.length > limit && last ? btoa(`${snapshot.id}:${last.code}`).replace(/\+/g, '-').replace(/\//g, '_') : null });
  }
  const productMatch = /^\/products\/([^/]+)$/.exec(url.pathname);
  if (productMatch && request.method === 'GET') {
    if (!validCode(productMatch[1])) return json({ error: 'invalid_code' }, 400);
    const row = await env.DB.prepare('SELECT data_json FROM catalog_entries_read WHERE snapshot_id=? AND code=?')
      .bind(snapshot.id, productMatch[1]).first<{ data_json: string }>();
    if (!row) return json({ error: 'product_not_found' }, 404);
    const entry = JSON.parse(row.data_json) as Entry;
    return json({ storeId: snapshot.store_id, ...entry, expiresAt: expiresAt(entry, ageHours) });
  }
  const historyMatch = /^\/history\/([^/]+)$/.exec(url.pathname);
  if (historyMatch && request.method === 'GET') {
    if (!validCode(historyMatch[1])) return json({ error: 'invalid_code' }, 400);
    const result = await env.DB.prepare(`SELECT observed_at AS observedAt, price_json FROM price_history
      WHERE store_id=? AND code=? ORDER BY observed_at DESC LIMIT 100`).bind(snapshot.store_id, historyMatch[1]).all<{ observedAt: string; price_json: string }>();
    return json({ storeId: snapshot.store_id, code: historyMatch[1], changes: result.results.map(({ price_json, ...row }) => ({ ...row, ...JSON.parse(price_json) })) });
  }
  if (url.pathname === '/prices/query' && request.method === 'POST') {
    const data = await requestJson(request);
    if (!data || data.currency !== 'SEK' || data.storeId !== snapshot.store_id || !Array.isArray(data.products)
      || data.products.length > 400 || data.products.some((p: any) => !p || !validCode(p.willysCode)
        || typeof p.productId !== 'string' || !p.productId || p.productId.length > 100)
      || new Set(data.products.map((p: any) => p.productId)).size !== data.products.length) {
      return json({ error: 'invalid_price_request', message: 'Use the configured store, SEK, and at most 400 unique product IDs with Willys codes.' }, 400);
    }
    const codes = [...new Set(data.products.map((p: any) => p.willysCode))];
    // Keep bulk lookups small enough for the free Worker's CPU allowance.
    const result = await env.DB.prepare(`SELECT code, json_remove(data_json, '$.raw', '$.sourcePricing', '$.price') AS data_json
      FROM catalog_entries_read WHERE snapshot_id=?
      AND code IN (SELECT value FROM json_each(?))`).bind(snapshot.id, JSON.stringify(codes)).all<{ code: string; data_json: string }>();
    const entries = new Map(result.results.map(row => [row.code, JSON.parse(row.data_json) as Entry]));
    const prices = [], unresolved = [];
    for (const product of data.products) {
      const entry = entries.get(product.willysCode);
      const price = entry ? packPrice(entry, product) : null;
      const expiry = entry ? expiresAt(entry, ageHours) : null;
      if (!entry || price === null || !expiry || Date.parse(expiry) <= Date.now() || Date.parse(entry.observedAt) > Date.now() + 60000) {
        unresolved.push({ productId: product.productId, reason: !entry ? 'unknown_code' : price === null ? 'pack_price_unresolved' : 'stale' }); continue;
      }
      prices.push({ productId: product.productId, storeId: snapshot.store_id, price, currency: 'SEK', source: 'snapshot',
        observedAt: entry.observedAt, expiresAt: expiry, available: entry.available, deposit: entry.depositOre! / 100 });
    }
    return json({ prices, unresolved });
  }
  return json({ error: 'route_not_found' }, 404);
}

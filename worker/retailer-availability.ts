import { DIETARY_POLICY_VERSION, ingredientPolicy } from '../src/dietary-policy.ts';
import { validateConnections, validateObservation } from '../src/retailers/identity.ts';
import type { ReviewedConnection } from '../src/retailers/identity.ts';
import type { ProductObservation, RetailPrice, RetailerId, RetailProduct, StoreScope } from '../src/retailers/types.ts';
import { productId, scopeKey, validateScope } from '../src/retailers/types.ts';
import { connectionHealth } from '../src/retailers/connection-health.ts';

export type RetailAvailabilityEnv = { COOP_DB?: D1Database; ICA_DB?: D1Database };
export type RetailManifest = { datasetId: string; inventoryHash: string; distinctIngredients: number };
export type RetailAvailability = { current: boolean; retailer: RetailerId; scope: StoreScope | null;
  runId: string | null; brokenNames: string[]; expiresAt: string | null };
export type RetailConnectionLink = { retailer: RetailerId; ingredientId: string; name: string; status: string;
  productId: string | null; referencePrice: RetailPrice | null; expiresAt: string | null };

type Run = { id: string; checked_at: string; expires_at: string; checked_ids_json: string };
type ConnectionRow = { ingredient_id: string; ingredient_name: string; status: string; document_json: string };
type CachedState = { availability: RetailAvailability; connections: ReviewedConnection[];
  observations: ProductObservation[];
  health: Map<string, { status: string; productId: string | null }>; expiresAtMs: number };
type DbMeta = Record<string, string>;
const stateCache = new WeakMap<object, Map<string, CachedState>>();
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const binding = (env: RetailAvailabilityEnv, retailer: RetailerId) => retailer === 'coop' ? env.COOP_DB : env.ICA_DB;

function reviewedProducts(connection: ReviewedConnection): RetailProduct[] {
  return connection.approvedProducts.map(approved => {
    const identity = JSON.parse(approved.identity) as unknown[];
    if (!Array.isArray(identity) || identity.length !== 7) throw new Error('invalid_reviewed_product_identity');
    const packValue = identity[5];
    if (packValue !== null && (!Array.isArray(packValue) || packValue.length !== 4)) throw new Error('invalid_reviewed_product_package');
    const pack = packValue === null ? null : {quantity:packValue[0] as number,
      unit:packValue[1] as 'g'|'ml'|'piece',approximate:packValue[2] as boolean,
      ...(packValue[3] === null ? {} : {drainedGrams:packValue[3] as number})};
    return { id: String(identity[0]), ean: identity[1] as string | null, name: String(identity[2]),
      brand: identity[3] as string | null, categories: identity[4] as string[],
      pack, ingredientsText: identity[6] as string | null };
  });
}

async function metadata(db: D1Database): Promise<DbMeta> {
  const result = await db.prepare('SELECT key,value FROM retail_meta').all<{ key: string; value: string }>();
  return Object.fromEntries(result.results.map(row => [row.key, row.value]));
}

function parseScope(value: string | undefined, retailer: RetailerId): StoreScope | null {
  if (!value) return null;
  try {
    const parts = JSON.parse(value) as unknown;
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== retailer
      || typeof parts[1] !== 'string' || !['pickup', 'delivery'].includes(String(parts[2]))
      || parts[3] !== null && typeof parts[3] !== 'string') return null;
    const scope: StoreScope = { storeId: parts[1], channel: parts[2] as StoreScope['channel'],
      ...(parts[3] ? { slotId: parts[3] as string } : {}) };
    validateScope(scope);
    return scopeKey(retailer, scope) === value ? scope : null;
  } catch { return null; }
}

function cacheFor(db: D1Database): Map<string, CachedState> {
  const key = db as object;
  let cache = stateCache.get(key);
  if (!cache) { cache = new Map(); stateCache.set(key, cache); }
  return cache;
}

function failure(retailer: RetailerId, scope: StoreScope | null = null, runId: string | null = null,
  brokenNames: string[] = []): RetailAvailability {
  return { current: false, retailer, scope, runId, brokenNames: [...new Set(brokenNames)].sort(), expiresAt: null };
}

async function assess(env: RetailAvailabilityEnv, manifest: RetailManifest, retailer: RetailerId,
  now: number): Promise<{ availability: RetailAvailability; state: CachedState | null }> {
  const db = binding(env, retailer);
  if (!db || !manifest || !isHash(manifest.datasetId) || !isHash(manifest.inventoryHash)
    || !Number.isSafeInteger(manifest.distinctIngredients) || manifest.distinctIngredients < 1) {
    return { availability: failure(retailer), state: null };
  }
  try {
    const meta = await metadata(db);
    if (meta.retailer !== retailer || meta.dataset_id !== manifest.datasetId
      || meta.inventory_hash !== manifest.inventoryHash || meta.policy_version !== DIETARY_POLICY_VERSION) {
      return { availability: failure(retailer), state: null };
    }
    const scope = parseScope(meta.reference_scope, retailer);
    if (!scope) return { availability: failure(retailer), state: null };
    const run = await db.prepare(`SELECT r.id,r.checked_at,r.expires_at,r.checked_ids_json FROM retail_scope_state s
      JOIN retail_runs r ON r.id=s.active_run_id WHERE s.scope_key=?`).bind(meta.reference_scope)
      .first<Run>();
    if (!run || !run.id || !Number.isFinite(Date.parse(run.checked_at)) || !Number.isFinite(Date.parse(run.expires_at))
      || Date.parse(run.expires_at) <= now || Date.parse(run.checked_at) > now + 60000
      || now - Date.parse(run.checked_at) >= 86400000) {
      return { availability: failure(retailer, scope, run?.id ?? null), state: null };
    }
    const connectionsVersion = meta.connections_version;
    if (!connectionsVersion || connectionsVersion.length > 200) {
      return { availability: failure(retailer, scope, run.id, ['connections_version_missing']), state: null };
    }
    const cacheKey = JSON.stringify([manifest.datasetId, manifest.inventoryHash, run.id, connectionsVersion, meta.policy_version]);
    const cache = cacheFor(db), cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) return { availability: cached.availability, state: cached };
    if (cached) cache.delete(cacheKey);

    const connectionResult = await db.prepare(`SELECT ingredient_id,ingredient_name,status,document_json
      FROM retail_connections ORDER BY ingredient_name`).all<ConnectionRow>();
    const rows = connectionResult.results;
    if (rows.length !== manifest.distinctIngredients) {
      const known = rows.map(row => row.ingredient_name).filter(name => typeof name === 'string');
      return { availability: failure(retailer, scope, run.id, [...known, 'inventory_incomplete']), state: null };
    }
    const malformedConnections = new Set<string>();
    const connections: ReviewedConnection[] = rows.map(row => {
      try {
        const connection = JSON.parse(row.document_json) as ReviewedConnection;
        if (connection.ingredientId !== row.ingredient_id || connection.name !== row.ingredient_name
          || connection.status !== row.status) throw new Error('connection_row_mismatch');
        return connection;
      } catch {
        malformedConnections.add(row.ingredient_name);
        return { ingredientId: row.ingredient_id, name: row.ingredient_name, foodId: null,
          status: 'needs_review', mainProductId: null, approvedProducts: [], policyVersion: DIETARY_POLICY_VERSION,
          reviewedAt: '', reason: 'connection_record_invalid' };
      }
    });
    const brokenNames = new Set<string>();
    const allApproved = connections.flatMap(connection => connection.status === 'matched'
      ? connection.approvedProducts.map(product => product.productId) : []);
    const approvedIds = [...new Set(allApproved)];
    if (approvedIds.length > 5000) {
      return { availability: failure(retailer, scope, run.id, connections.map(connection => connection.name)), state: null };
    }
    let rawCheckedIds: unknown;
    try { rawCheckedIds = JSON.parse(run.checked_ids_json); } catch {
      return { availability: failure(retailer, scope, run.id, ['invalid_run_inventory']), state: null };
    }
    if (!Array.isArray(rawCheckedIds) || rawCheckedIds.some(id => !productId(id))
      || new Set(rawCheckedIds).size !== rawCheckedIds.length) {
      return { availability: failure(retailer, scope, run.id, ['invalid_run_inventory']), state: null };
    }
    const checkedIds = new Set<string>(rawCheckedIds);
    const tracked = new Set(allApproved);
    if ([...tracked].some(id => !checkedIds.has(id))) {
      for (const connection of connections) if (connection.status === 'matched'
        && connection.approvedProducts.some(product => !checkedIds.has(product.productId))) brokenNames.add(connection.name);
    }
    const stored = approvedIds.length ? await db.prepare(`SELECT product_id,observation_json FROM retail_products WHERE scope_key=?
      AND product_id IN (SELECT value FROM json_each(?))`).bind(meta.reference_scope, JSON.stringify(approvedIds))
      .all<{ product_id: string; observation_json: string }>() : { results: [] as Array<{ product_id: string; observation_json: string }> };
    const observations = stored.results.flatMap(row => {
      try {
        const observation = JSON.parse(row.observation_json) as ProductObservation;
        if (row.product_id !== observation.product.id || !tracked.has(observation.product.id)
          || !checkedIds.has(observation.product.id)) return [];
        const checked = { ...observation, checkedAt: run.checked_at, expiresAt: run.expires_at };
        validateObservation(checked, retailer, scope);
        return [checked];
      } catch { return []; }
    });
    const health = new Map<string, { status: string; productId: string | null }>();
    const observedById=new Map(observations.map(o=>[o.product.id,o]));
    for (const connection of connections) {
      const isMalformed = malformedConnections.has(connection.name);
      if (isMalformed || ingredientPolicy(connection.name).blockedReason) {
        brokenNames.add(connection.name);
        health.set(connection.ingredientId, { status: 'needs_review', productId: null });
        continue;
      }
      try { validateConnections([connection], reviewedProducts(connection)); }
      catch {
        brokenNames.add(connection.name);
        health.set(connection.ingredientId, { status: 'needs_review', productId: null });
        continue;
      }
      const result = connectionHealth(connection, connection.approvedProducts.flatMap(p=>observedById.has(p.productId)?[observedById.get(p.productId)!]:[]), retailer, scope, now);
      health.set(connection.ingredientId, { status: result.status, productId: result.productId });
      if (connection.status !== 'non_purchased' && result.status !== 'matched') brokenNames.add(connection.name);
    }
    const expCandidates = [Date.parse(run.expires_at), now + 86400000];
    for (const result of health.values()) {
      const observation = result.productId ? observations.find(item => item.product.id === result.productId) : undefined;
      if (!observation?.price) continue;
      const validUntil = observation.price.validUntil ? Date.parse(observation.price.validUntil) : NaN;
      const validFrom = observation.price.validFrom ? Date.parse(observation.price.validFrom) : NaN;
      if (Number.isFinite(validUntil) && validUntil > now) expCandidates.push(validUntil);
    }
    for (const observation of observations) {
      const validFrom = observation.price?.validFrom ? Date.parse(observation.price.validFrom) : NaN;
      if (Number.isFinite(validFrom) && validFrom > now) expCandidates.push(validFrom);
    }
    const expiryMs = Math.min(...expCandidates);
    const expiresAt = new Date(expiryMs).toISOString();
    const availability: RetailAvailability = { current: true, retailer, scope, runId: run.id,
      brokenNames: [...brokenNames].sort(), expiresAt };
    const state: CachedState = { availability, connections, observations, health, expiresAtMs: expiryMs };
    if (expiryMs > now) {
      if (cache.size >= 8 && !cache.has(cacheKey)) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, state);
    }
    return { availability, state };
  } catch {
    return { availability: failure(retailer), state: null };
  }
}

export async function retailerAvailability(env: RetailAvailabilityEnv, manifest: RetailManifest,
  retailer: RetailerId, now = Date.now()): Promise<RetailAvailability> {
  return (await assess(env, manifest, retailer, now)).availability;
}

export async function lookupRetailConnections(env: RetailAvailabilityEnv, manifest: RetailManifest,
  retailer: RetailerId, names: string[], now = Date.now()): Promise<RetailConnectionLink[]> {
  if (!Array.isArray(names) || names.length > 400 || names.some(name => typeof name !== 'string' || !name.trim())) return [];
  const { availability, state } = await assess(env, manifest, retailer, now);
  if (!availability.current || !state) return [];
  const byName = new Map(state.connections.map(connection => [connection.name, connection]));
  const byProductId = new Map(state.observations.map(observation => [observation.product.id, observation]));
  return names.map(name => {
    const connection = byName.get(name);
    if (!connection) return { retailer, ingredientId: `missing:${name}`, name,
      status: 'needs_review', productId: null, referencePrice: null, expiresAt: null };
    const health = state.health.get(connection.ingredientId);
    const observation = health?.status === 'matched' && health.productId ? byProductId.get(health.productId) : undefined;
    return { retailer, ingredientId: connection.ingredientId, name: connection.name, status: health?.status ?? 'needs_review',
      productId: observation?.product.id ?? null, referencePrice: observation?.price ?? null,
      expiresAt: observation?.expiresAt ?? null };
  });
}

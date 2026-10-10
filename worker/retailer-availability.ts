import { calendarWeekEnd, scanIsCurrent, PRICE_FRESHNESS_POLICY_VERSION } from '../src/price-freshness.ts';
import { referenceObservation } from '../src/retailers/freshness.ts';
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
export type RetailContext = { availability: RetailAvailability; links: RetailConnectionLink[] };
export type RetailConnectionLink = { retailer: RetailerId; ingredientId: string; name: string; status: string;
  productId: string | null; referencePrice: RetailPrice | null; expiresAt: string | null };

type Run = { id: string; checked_at: string; expires_at: string; checked_ids_json: string; report_json: string };
type ConnectionRow = { ingredient_id: string; ingredient_name: string; status: string; document_json: string };
type AvailabilitySummary = { schemaVersion: 1; retailer: RetailerId; scopeKey: string; datasetId: string;
  inventoryHash: string; policyVersion: string; connectionsVersion: string; distinctIngredients: number;
  checkedProductCount: number; brokenNames: string[]; earliestPriceBoundary: string | null };
type CachedState = { availability: RetailAvailability; connections?: ReviewedConnection[];
  observations?: ProductObservation[]; health?: Map<string, { status: string; productId: string | null }>;
  summary?: AvailabilitySummary; run?: Run; checkedIds?: Set<string>; links?: Map<string, RetailConnectionLink>;
  expiresAtMs: number };
type DbMeta = Record<string, string>;
const stateCache = new WeakMap<object, Map<string, CachedState>>();
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const binding = (env: RetailAvailabilityEnv, retailer: RetailerId) => retailer === 'coop' ? env.COOP_DB : env.ICA_DB;

function reviewedProducts(connections: ReviewedConnection[]): RetailProduct[] {
  const products = new Map<string, RetailProduct>();
  for (const connection of connections) for (const approved of connection.approvedProducts) {
    if (products.has(approved.identity)) continue;
    const identity = JSON.parse(approved.identity) as unknown[];
    if (!Array.isArray(identity) || identity.length !== 7) throw new Error('invalid_reviewed_product_identity');
    const packValue = identity[5];
    if (packValue !== null && (!Array.isArray(packValue) || packValue.length !== 4)) throw new Error('invalid_reviewed_product_package');
    const pack = packValue === null ? null : {quantity:packValue[0] as number,
      unit:packValue[1] as 'g'|'ml'|'piece',approximate:packValue[2] as boolean,
      ...(packValue[3] === null ? {} : {drainedGrams:packValue[3] as number})};
    products.set(approved.identity, { id: String(identity[0]), ean: identity[1] as string | null, name: String(identity[2]),
      brand: identity[3] as string | null, categories: identity[4] as string[],
      pack, ingredientsText: identity[6] as string | null });
  }
  return [...products.values()];
}

async function metadata(db: D1Database): Promise<DbMeta> {
  const result = await db.prepare('SELECT key,value FROM retail_meta').all<{ key: string; value: string }>();
  return Object.fromEntries(result.results.map(row => [row.key, row.value]));
}

async function publicationState(db: D1Database): Promise<{meta: DbMeta; run: Run | null}> {
  const selectRun = `SELECT r.id,r.checked_at,r.expires_at,r.checked_ids_json,r.report_json FROM retail_scope_state s
    JOIN retail_runs r ON r.id=s.active_run_id WHERE s.scope_key=(SELECT value FROM retail_meta WHERE key='reference_scope')`;
  if (typeof db.batch === 'function') {
    // A read-only D1 batch gives a coherent metadata/run snapshot in one binding call.
    const [meta, run] = await db.batch([
      db.prepare('SELECT key,value FROM retail_meta'), db.prepare(selectRun),
    ]);
    return {meta: Object.fromEntries((meta.results as Array<{key: string; value: string}>).map(row => [row.key, row.value])),
      run: run.results[0] as Run | undefined ?? null};
  }
  return {meta: await metadata(db), run: await db.prepare(selectRun).first<Run>()};
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
    const {meta,run} = await publicationState(db);
    if (meta.retailer !== retailer || meta.dataset_id !== manifest.datasetId
      || meta.inventory_hash !== manifest.inventoryHash || meta.policy_version !== DIETARY_POLICY_VERSION) {
      return { availability: failure(retailer), state: null };
    }
    const scope = parseScope(meta.reference_scope, retailer);
    if (!scope) return { availability: failure(retailer), state: null };
    if (!run || !run.id || !Number.isFinite(Date.parse(run.checked_at)) || !Number.isFinite(Date.parse(run.expires_at))
      || !scanIsCurrent(Date.parse(run.checked_at),now)) {
      return { availability: failure(retailer, scope, run?.id ?? null), state: null };
    }
    const connectionsVersion = meta.connections_version;
    if (!connectionsVersion || connectionsVersion.length > 200) {
      return { availability: failure(retailer, scope, run.id, ['connections_version_missing']), state: null };
    }
    const cacheKey = JSON.stringify([manifest.datasetId, manifest.inventoryHash, run.id, connectionsVersion, meta.policy_version, PRICE_FRESHNESS_POLICY_VERSION]);
    const cache = cacheFor(db), cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) return { availability: cached.availability, state: cached };
    if (cached) cache.delete(cacheKey);

    let rawCheckedIds: unknown;
    try { rawCheckedIds = JSON.parse(run.checked_ids_json); } catch {
      return { availability: failure(retailer, scope, run.id, ['invalid_run_inventory']), state: null };
    }
    if (!Array.isArray(rawCheckedIds) || rawCheckedIds.some(id => !productId(id))
      || new Set(rawCheckedIds).size !== rawCheckedIds.length) {
      return { availability: failure(retailer, scope, run.id, ['invalid_run_inventory']), state: null };
    }
    const checkedIds = new Set<string>(rawCheckedIds);

    let report: Record<string, unknown>;
    try {
      const parsed = JSON.parse(run.report_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_report');
      report = parsed as Record<string, unknown>;
    } catch { return { availability: failure(retailer, scope, run.id, ['invalid_run_report']), state: null }; }
    if (report.availabilitySummary !== undefined) {
      const value = report.availabilitySummary as Partial<AvailabilitySummary> | null;
      const brokenNames = value?.brokenNames;
      const boundary = value?.earliestPriceBoundary;
      const parsedBoundary = typeof boundary === 'string' ? Date.parse(boundary) : NaN;
      const validBoundary = boundary === null || typeof boundary === 'string' && Number.isFinite(parsedBoundary)
        && new Date(parsedBoundary).toISOString() === boundary;
      if (value?.schemaVersion !== 1 || value.retailer !== retailer || value.scopeKey !== meta.reference_scope
        || value.datasetId !== manifest.datasetId || value.inventoryHash !== manifest.inventoryHash
        || value.policyVersion !== DIETARY_POLICY_VERSION || value.connectionsVersion !== connectionsVersion
        || value.distinctIngredients !== manifest.distinctIngredients || value.checkedProductCount !== checkedIds.size
        || !Array.isArray(brokenNames) || brokenNames.length > manifest.distinctIngredients
        || brokenNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 250)
        || new Set(brokenNames).size !== brokenNames.length || !validBoundary
        || report.id !== run.id || report.retailer !== retailer || report.checkedAt !== run.checked_at
        || report.expiresAt !== run.expires_at) {
        return { availability: failure(retailer, scope, run.id, ['invalid_availability_summary']), state: null };
      }
      const boundaryMs = boundary === null ? Infinity : Date.parse(boundary);
      const checkedExpiry = calendarWeekEnd(Date.parse(run.checked_at));
      if (boundaryMs > now) {
        const expiryMs = Math.min(checkedExpiry, boundaryMs);
        if (expiryMs <= now) return { availability: failure(retailer, scope, run.id, ['availability_summary_expired']), state: null };
        const summary = value as AvailabilitySummary;
        const availability: RetailAvailability = { current: true, retailer, scope, runId: run.id,
          brokenNames: [...brokenNames].sort(), expiresAt: new Date(expiryMs).toISOString() };
        const state: CachedState = { availability, summary, run, checkedIds, expiresAtMs: expiryMs, links: new Map() };
        if (cache.size >= 8 && !cache.has(cacheKey)) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, state);
        return { availability, state };
      }
      // A valid-from/valid-until edge changed health since publication; recompute it once from current rows.
    }

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
        const checked = referenceObservation(observation, run.checked_at);
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
      try { validateConnections([connection], reviewedProducts([connection])); }
      catch {
        brokenNames.add(connection.name);
        health.set(connection.ingredientId, { status: 'needs_review', productId: null });
        continue;
      }
      const result = connectionHealth(connection, connection.approvedProducts.flatMap(p=>observedById.has(p.productId)?[observedById.get(p.productId)!]:[]), retailer, scope, now);
      health.set(connection.ingredientId, { status: result.status, productId: result.productId });
      if (connection.status !== 'non_purchased' && result.status !== 'matched') brokenNames.add(connection.name);
    }
    const expCandidates = [calendarWeekEnd(Date.parse(run.checked_at))];
    for (const result of health.values()) {
      const observation = result.productId ? observations.find(item => item.product.id === result.productId) : undefined;
      if (!observation?.price) continue;
      const validUntil = observation.price.validUntil ? Date.parse(observation.price.validUntil) : NaN;
      const validFrom = observation.price.validFrom ? Date.parse(observation.price.validFrom) : NaN;
      if (Number.isFinite(validUntil) && validUntil > now) expCandidates.push(validUntil);
      if (Number.isFinite(validFrom) && validFrom > now) expCandidates.push(validFrom);
    }
    for (const observation of observations) if (observation.price) {
      const validUntil = observation.price.validUntil ? Date.parse(observation.price.validUntil) : NaN;
      const validFrom = observation.price.validFrom ? Date.parse(observation.price.validFrom) : NaN;
      if (Number.isFinite(validUntil) && validUntil > now) expCandidates.push(validUntil);
      if (Number.isFinite(validFrom) && validFrom > now) expCandidates.push(validFrom);
    }
    const expiryMs = Math.min(...expCandidates);
    const expiresAt = new Date(expiryMs).toISOString();
    const availability: RetailAvailability = { current: true, retailer, scope, runId: run.id,
      brokenNames: [...brokenNames].sort(), expiresAt };
    const state: CachedState = { availability, connections, observations, health, run, checkedIds, expiresAtMs: expiryMs };
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

async function lookupPublishedNames(db: D1Database, retailer: RetailerId, scope: StoreScope,
  state: CachedState, names: string[], now: number): Promise<Map<string, RetailConnectionLink> | null> {
  const run = state.run, summary = state.summary, checkedIds = state.checkedIds;
  if (!run || !summary || !checkedIds) return null;
  const activeStatement = db.prepare(`SELECT s.active_run_id,
    (SELECT value FROM retail_meta WHERE key='connections_version') AS connections_version,
    (SELECT value FROM retail_meta WHERE key='dataset_id') AS dataset_id,
    (SELECT value FROM retail_meta WHERE key='inventory_hash') AS inventory_hash,
    (SELECT value FROM retail_meta WHERE key='policy_version') AS policy_version
    FROM retail_scope_state s WHERE s.scope_key=?`).bind(summary.scopeKey);
  type Active = {active_run_id:string;connections_version:string;dataset_id:string;inventory_hash:string;policy_version:string};
  const unresolved = [...new Set(names)].filter(name => !state.links?.has(name));
  const namesJson=JSON.stringify(unresolved);
  const connectionStatement=db.prepare(`SELECT ingredient_id,ingredient_name,status,document_json FROM retail_connections
    WHERE ingredient_name IN (SELECT value FROM json_each(?))`).bind(namesJson);
  let active:Active|null, connectionRows:ConnectionRow[]=[], batchedProducts:Array<{product_id:string;observation_json:string}>|undefined;
  if(unresolved.length&&typeof db.batch==='function'){
    // Derive the selected IDs inside SQLite so all three reads share one snapshot
    // and one binding call. Malformed review JSON stays isolated by validation below.
    const productStatement=db.prepare(`SELECT product_id,observation_json FROM retail_products WHERE scope_key=?
      AND product_id IN (SELECT json_extract(CASE WHEN json_valid(p.value) THEN p.value ELSE '{}' END,'$.productId')
        FROM retail_connections c,json_each(CASE WHEN json_valid(c.document_json) THEN c.document_json ELSE '{}' END,'$.approvedProducts') p
        WHERE c.ingredient_name IN (SELECT value FROM json_each(?)))
      AND product_id IN (SELECT value FROM json_each(?))`).bind(summary.scopeKey,namesJson,JSON.stringify([...checkedIds]));
    const [activeResult,connectionsResult,productsResult]=await db.batch([activeStatement,connectionStatement,productStatement]);
    active=activeResult.results[0] as Active|undefined??null;
    connectionRows=connectionsResult.results as ConnectionRow[];
    batchedProducts=productsResult.results as Array<{product_id:string;observation_json:string}>;
  }else active=await activeStatement.first<Active>();
  if (active?.active_run_id !== run.id || active.connections_version !== summary.connectionsVersion
    || active.dataset_id !== summary.datasetId || active.inventory_hash !== summary.inventoryHash
    || active.policy_version !== summary.policyVersion) return null;

  if (!unresolved.length) return state.links ?? new Map();
  if(!batchedProducts)connectionRows=(await connectionStatement.all<ConnectionRow>()).results;
  const wanted = new Set(unresolved);
  const connections = new Map<string, ReviewedConnection>();
  const invalid = new Set<string>();
  for (const row of connectionRows) {
    if (!wanted.has(row.ingredient_name)) continue;
    try {
      const connection = JSON.parse(row.document_json) as ReviewedConnection;
      if (connection.ingredientId !== row.ingredient_id || connection.name !== row.ingredient_name
        || connection.status !== row.status || connections.has(row.ingredient_name)) throw new Error('connection_row_mismatch');
      connections.set(connection.name, connection);
    } catch { invalid.add(row.ingredient_name); }
  }
  const selectedConnections = [...connections.values()].filter(connection => !invalid.has(connection.name));
  try { validateConnections(selectedConnections, reviewedProducts(selectedConnections)); }
  catch {
    // A malformed selected connection should not invalidate unrelated requested names.
    // Keep the fast aggregate path for valid rows and isolate only the failing records here.
    for (const connection of selectedConnections) {
      try { validateConnections([connection], reviewedProducts([connection])); }
      catch { invalid.add(connection.name); }
    }
  }
  const approvedIds = [...new Set([...connections.values()].flatMap(connection => connection.status === 'matched'
    ? connection.approvedProducts.map(product => product.productId) : []))];
  const missingFromRun = new Set([...connections.values()].flatMap(connection => connection.status === 'matched'
    ? connection.approvedProducts.filter(product => !checkedIds.has(product.productId)).map(() => connection.name) : []));
  const checkedApprovedIds = approvedIds.filter(id => checkedIds.has(id));
  const stored = batchedProducts?{results:batchedProducts}:checkedApprovedIds.length ? await db.prepare(`SELECT product_id,observation_json FROM retail_products WHERE scope_key=?
    AND product_id IN (SELECT value FROM json_each(?))`).bind(summary.scopeKey, JSON.stringify(checkedApprovedIds))
    .all<{ product_id: string; observation_json: string }>() : { results: [] as Array<{ product_id: string; observation_json: string }> };
  const expected = new Set(checkedApprovedIds);
  const observations = new Map<string, ProductObservation>();
  for (const row of stored.results) {
    try {
      const observation = JSON.parse(row.observation_json) as ProductObservation;
      if (row.product_id !== observation.product.id || !expected.has(observation.product.id)
        || observations.has(observation.product.id)) throw new Error('invalid_stored_observation');
      const current = referenceObservation(observation, run.checked_at);
      validateObservation(current, retailer, scope);
      observations.set(current.product.id, current);
    } catch { /* A bad or missing selected row remains unavailable for this name. */ }
  }
  for (const name of unresolved) {
    const connection = connections.get(name);
    let status = 'needs_review', selectedId: string | null = null;
    if (connection && !invalid.has(name) && !missingFromRun.has(name)) {
      const health = connectionHealth(connection, connection.approvedProducts.flatMap(product => {
        const observation = observations.get(product.productId);
        return observation ? [observation] : [];
      }), retailer, scope, now);
      status = health.status;
      selectedId = health.productId;
      if (status === 'matched' && summary.brokenNames.includes(name)) {
        // A mismatch between a selected row and the atomic publish summary is never allowed to fail open.
        status = 'needs_review';
        selectedId = null;
      }
    }
    const selected = selectedId ? observations.get(selectedId) : undefined;
    state.links?.set(name, { retailer, ingredientId: connection?.ingredientId ?? `missing:${name}`, name,
      status, productId: selected?.product.id ?? null, referencePrice: selected?.price ?? null,
      expiresAt: selected?.expiresAt ?? null });
  }
  return state.links ?? null;
}

export async function lookupRetailContext(env: RetailAvailabilityEnv, manifest: RetailManifest,
  retailer: RetailerId, names: string[], now = Date.now()): Promise<RetailContext> {
  if (!Array.isArray(names) || names.length > 400 || names.some(name => typeof name !== 'string' || !name.trim())) {
    return { availability: failure(retailer), links: [] };
  }
  const { availability, state } = await assess(env, manifest, retailer, now);
  if (!availability.current || !state) return { availability, links: [] };
  let byName: Map<string, RetailConnectionLink>;
  if (state.summary) {
    const db = binding(env, retailer);
    if (!db) return { availability: failure(retailer, availability.scope, availability.runId), links: [] };
    const links = await lookupPublishedNames(db, retailer, availability.scope!, state, names, now);
    if (!links) return { availability: failure(retailer, availability.scope, availability.runId,
      ['active_run_changed']), links: [] };
    byName = links;
  } else {
    const connections = state.connections ?? [], observations = state.observations ?? [], health = state.health ?? new Map();
    const byConnection = new Map(connections.map(connection => [connection.name, connection]));
    const byProductId = new Map(observations.map(observation => [observation.product.id, observation]));
    byName = new Map(names.map(name => {
      const connection = byConnection.get(name);
      if (!connection) return [name, { retailer, ingredientId: `missing:${name}`, name,
        status: 'needs_review', productId: null, referencePrice: null, expiresAt: null }];
      const checked = health.get(connection.ingredientId);
      const observation = checked?.status === 'matched' && checked.productId ? byProductId.get(checked.productId) : undefined;
      return [name, { retailer, ingredientId: connection.ingredientId, name: connection.name, status: checked?.status ?? 'needs_review',
        productId: observation?.product.id ?? null, referencePrice: observation?.price ?? null,
        expiresAt: observation?.expiresAt ?? null }];
    }));
  }
  const links = names.map(name => {
    const link = byName.get(name);
    if (!link) return { retailer, ingredientId: `missing:${name}`, name,
      status: 'needs_review', productId: null, referencePrice: null, expiresAt: null };
    return link;
  });
  return { availability, links };
}

export async function lookupRetailConnections(env: RetailAvailabilityEnv, manifest: RetailManifest,
  retailer: RetailerId, names: string[], now = Date.now()): Promise<RetailConnectionLink[]> {
  return (await lookupRetailContext(env, manifest, retailer, names, now)).links;
}

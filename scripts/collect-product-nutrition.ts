import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CoopClient, CoopMissingProductsError } from '../src/retailers/coop.ts';
import { productIdentity } from '../src/retailers/identity.ts';
import { copyNutritionSource } from '../src/retailers/nutrition-source.ts';
import { createRetailTransport } from '../src/retailers/transport.ts';
import { productId as validProductId, scopeKey, validateScope } from '../src/retailers/types.ts';
import type { ProductObservation, ProductNutritionSource, StoreScope } from '../src/retailers/types.ts';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PRODUCTS = 500;
const BATCH_SIZE = 25;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Dataset = { retailer: 'coop'; scope: StoreScope; datasetId: string; inventoryHash: string;
  connections: Array<{ status: string; approvedProducts: Array<{ productId: string; identity: string }> }>;
  observations: ProductObservation[] };
export type CollectionOptions = { input: string; output: string; maxProducts?: number; maxRequests?: number;
  productIds?: string[]; allowLive?: boolean; fixture?: string; fixtureCheckedAt?: string };
type CollectionDependencies = { fetch?: typeof fetch; subscriptionKey?: string; now?: () => Date };
type CollectedProduct = { retailer: 'coop'; productId: string; productIdentity: string; identityHash: string;
  checkedAt: string | null; nutritionSource?: ProductNutritionSource;
  /** Price/scope observation from the same request; the raw label is stored only above. */
  observation?: ProductObservation;
  expectedIdentityHash?: string; observedIdentityHash?: string;
  status: 'retained' | 'collected' | 'nutrition_unavailable' | 'product_missing' | 'product_identity_changed' | 'not_collected' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positiveInteger(value: number | undefined, fallback: number, maximum: number, label: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`invalid_${label}`);
  return result;
}
function sourceTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error('fixture_source_checked_at_required');
  return value;
}
async function readSource(path: string) {
  const absolute = await realpath(resolve(path)), info = await lstat(absolute);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('collection_input_not_bounded_json');
  const bytes = await readFile(absolute);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('collection_input_too_large');
  return { path: absolute, sha256: hash(bytes), value: JSON.parse(bytes.toString('utf8')) as unknown };
}
async function preflightOutput(output: string, inputs: string[]) {
  const target = resolve(output);
  if (inputs.includes(target)) throw new Error('collection_output_is_input');
  try { await lstat(target); throw new Error('collection_output_exists'); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return target;
}
async function saveNewArtifact(path: string, artifact: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // A hard link is atomic and refuses an existing destination, including a race after preflight.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
function readDataset(value: unknown): Dataset {
  if (!record(value) || value.retailer !== 'coop' || typeof value.datasetId !== 'string' || !value.datasetId
    || typeof value.inventoryHash !== 'string' || !value.inventoryHash
    || !Array.isArray(value.connections) || !Array.isArray(value.observations)
    || value.connections.length > 20000 || value.observations.length > 20000) throw new Error('invalid_reviewed_coop_dataset');
  validateScope(value.scope as StoreScope);
  if ((value.scope as StoreScope).channel !== 'pickup' || (value.scope as StoreScope).slotId !== undefined) {
    throw new Error('collection_requires_reviewed_pickup_scope');
  }
  return value as Dataset;
}

/** Collect only reviewed IDs into a new local artifact. There are no database imports or writes. */
export async function collectProductNutrition(options: CollectionOptions, dependencies: CollectionDependencies = {}) {
  const maxProducts = positiveInteger(options.maxProducts, 25, MAX_PRODUCTS, 'max_products');
  const maxRequests = positiveInteger(options.maxRequests, 1, 100, 'max_requests');
  if (options.fixture && options.allowLive) throw new Error('choose_fixture_or_allow_live');
  if (options.fixtureCheckedAt && !options.fixture) throw new Error('fixture_checked_at_requires_fixture');
  const input = await readSource(options.input), dataset = readDataset(input.value);
  const fixture = options.fixture ? await readSource(options.fixture) : undefined;
  const output = await preflightOutput(options.output, [input.path, ...(fixture ? [fixture.path] : [])]);
  const approvals = new Map<string, string>();
  for (const connection of dataset.connections) {
    if (!record(connection) || connection.status !== 'matched') continue;
    if (!Array.isArray(connection.approvedProducts) || connection.approvedProducts.length === 0) {
      throw new Error('matched_connection_without_approved_products');
    }
    for (const approval of connection.approvedProducts) {
      if (!record(approval) || !validProductId(approval.productId) || typeof approval.identity !== 'string'
        || !approval.identity) throw new Error('invalid_approved_product_identity');
      const prior = approvals.get(approval.productId);
      if (prior !== undefined && prior !== approval.identity) throw new Error('conflicting_product_approvals');
      approvals.set(approval.productId, approval.identity);
    }
  }
  const allIds = [...approvals.keys()].sort();
  let selected = allIds.slice(0, maxProducts);
  if (options.productIds !== undefined) {
    if (!options.productIds.length || new Set(options.productIds).size !== options.productIds.length
      || options.productIds.some(id => !validProductId(id) || !approvals.has(id))) throw new Error('unapproved_requested_product');
    if (options.productIds.length > maxProducts) throw new Error('selected_products_exceed_budget');
    selected = [...options.productIds].sort();
  }
  if (!selected.length) throw new Error('no_matched_approved_products');
  const selectedSet = new Set(selected), observations = new Map<string, ProductObservation>();
  for (const observation of dataset.observations) {
    if (!record(observation) || !record(observation.product) || !selectedSet.has(String(observation.product.id))) continue;
    const id = String(observation.product.id);
    if (observations.has(id)) throw new Error('duplicate_reviewed_product_observation');
    if (observation.product.id !== id || observation.retailer !== 'coop'
      || scopeKey('coop', observation.scope) !== scopeKey('coop', dataset.scope)
      || productIdentity(observation.product) !== approvals.get(id)) throw new Error('reviewed_product_identity_mismatch');
    observations.set(id, observation);
  }
  if (selected.some(id => !observations.has(id))) throw new Error('approved_product_observation_missing');

  const rows = new Map<string, CollectedProduct>();
  for (const id of selected) {
    const observation = observations.get(id)!, identity = approvals.get(id)!;
    const source = copyNutritionSource(observation.product.nutritionSource, 'coop', id);
    if (source && !Number.isFinite(Date.parse(observation.checkedAt))) throw new Error('nutrition_source_checked_at_missing');
    rows.set(id, { retailer: 'coop', productId: id, productIdentity: identity, identityHash: hash(identity),
      observation: { ...observation, product: { ...observation.product, nutritionSource: undefined } },
      checkedAt: source ? observation.checkedAt : null, ...(source ? { nutritionSource: source } : {}),
      status: source ? 'retained' : 'not_collected' });
  }
  const lookupIds = selected.filter(id => !rows.get(id)!.nutritionSource);
  let requested = 0, requestCount = 0, fixtureCheckedAt: string | undefined;
  let client: CoopClient | undefined;
  let requestMetrics: (() => { readonly requests: number }) | undefined;
  if (fixture) {
    if (record(fixture.value) && fixture.value.scope !== undefined
      && scopeKey('coop', fixture.value.scope as StoreScope) !== scopeKey('coop', dataset.scope)) throw new Error('fixture_scope_mismatch');
    if (record(fixture.value) && fixture.value.retailer !== undefined && fixture.value.retailer !== 'coop') throw new Error('fixture_retailer_mismatch');
    fixtureCheckedAt = sourceTime(options.fixtureCheckedAt
      ?? (record(fixture.value) ? fixture.value.checkedAt : undefined));
    const payload = record(fixture.value) && fixture.value.response !== undefined ? fixture.value.response : fixture.value;
    if (!record(payload) || !record(payload.results) || !Array.isArray(payload.results.items)
      || payload.results.items.length > 400 || !Number.isSafeInteger(payload.results.count)
      || payload.results.count !== payload.results.items.length) throw new Error('invalid_coop_fixture_response');
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of payload.results.items) {
      if (!record(item)) throw new Error('invalid_coop_fixture_product');
      const id = ['id', 'code', 'productId', 'ean'].map(key => item[key]).find(value => typeof value === 'string') as string | undefined;
      if (!id || byId.has(id)) throw new Error('duplicate_or_missing_fixture_product_id');
      byId.set(id, item);
    }
    client = new CoopClient({ publicSubscriptionKey: 'offline-fixture', now: () => new Date(fixtureCheckedAt!),
      transport: async (_url, init) => {
        const ids = JSON.parse(String(init?.body)) as string[];
        const items = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
        return new Response(JSON.stringify({ results: { count: items.length, items } }), {
          headers: { 'content-type': 'application/json' },
        });
      } });
  } else if (options.allowLive && lookupIds.length) {
    if (Math.ceil(lookupIds.length / BATCH_SIZE) > maxRequests) throw new Error('lookup_batches_exceed_request_budget');
    const key = dependencies.subscriptionKey ?? process.env.COOP_PUBLIC_SUBSCRIPTION_KEY;
    if (!key) throw new Error('coop_public_subscription_key_required');
    const transport = createRetailTransport({ retailer: 'coop', fetch: dependencies.fetch, maxRequests,
      maxRunMs: 5 * 60 * 1000 });
    requestMetrics = () => transport.metrics;
    client = new CoopClient({ publicSubscriptionKey: key, transport, now: dependencies.now });
  }
  if (client) {
    for (let start = 0; start < lookupIds.length; start += BATCH_SIZE) {
      const ids = lookupIds.slice(start, start + BATCH_SIZE);
      requested += ids.length;
      let found: ProductObservation[], missing: string[] = [];
      try { found = await client.products(dataset.scope, ids); }
      catch (error) {
        if (!(error instanceof CoopMissingProductsError)) throw error;
        found = error.observations; missing = error.missingProductIds;
      }
      if (fixture) requestCount++;
      for (const observation of found) {
        const id = observation.product.id;
        if (!ids.includes(id)) throw new Error('collected_unrequested_product');
        const observedIdentity = productIdentity(observation.product);
        if (observedIdentity !== approvals.get(id)) {
          // Keep changed products quarantined until their connection is reviewed again.
          // Export no nutritionSource for this row, even if the response has a label.
          rows.set(id, { ...rows.get(id)!, checkedAt: observation.checkedAt,
            expectedIdentityHash: rows.get(id)!.identityHash, observedIdentityHash: hash(observedIdentity),
            status: 'product_identity_changed' });
          continue;
        }
        const source = copyNutritionSource(observation.product.nutritionSource, 'coop', id);
        rows.set(id, { ...rows.get(id)!, checkedAt: observation.checkedAt,
          observation: { ...observation, product: { ...observation.product, nutritionSource: undefined } },
          ...(source ? { nutritionSource: source } : {}), status: source ? 'collected' : 'nutrition_unavailable' });
      }
      for (const id of missing) rows.set(id, { ...rows.get(id)!, status: 'product_missing' });
    }
  }
  const products = selected.map(id => rows.get(id)!);
  const counts = { approvedProducts: allIds.length, selectedProducts: selected.length, requested,
    requests: requestMetrics?.().requests ?? 0, fixtureBatches: requestCount,
    missing: products.filter(p => p.status === 'product_missing').length,
    identityChanged: products.filter(p => p.status === 'product_identity_changed').length,
    nutritionPresent: products.filter(p => p.nutritionSource !== undefined).length,
    preserved: products.filter(p => p.status === 'retained').length,
    nutritionUnavailable: products.filter(p => p.status === 'nutrition_unavailable').length,
    notCollected: products.filter(p => p.status === 'not_collected').length };
  const artifact = { schemaVersion: 1, retailer: 'coop', mode: fixture ? 'fixture' : options.allowLive ? 'live' : 'retained_only',
    datasetId: dataset.datasetId, inventoryHash: dataset.inventoryHash, scope: dataset.scope,
    source: { input: input.path, inputSha256: input.sha256,
      ...(fixture ? { fixture: fixture.path, fixtureSha256: fixture.sha256, fixtureCheckedAt } : {}) },
    limits: { maxProducts, maxRequests, batchSize: BATCH_SIZE },
    selectionTruncated: options.productIds === undefined && allIds.length > selected.length,
    counts, products };
  await saveNewArtifact(output, artifact);
  return { output, artifact };
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' },
    'max-products': { type: 'string' }, 'max-requests': { type: 'string' }, 'product-ids': { type: 'string' },
    'allow-live': { type: 'boolean', default: false }, fixture: { type: 'string' },
    'fixture-checked-at': { type: 'string' } } });
  if (!values.input || !values.output) throw new Error('Supply --input reviewed.json --output NEW.json');
  const result = await collectProductNutrition({ input: values.input, output: values.output,
    maxProducts: values['max-products'] === undefined ? undefined : Number(values['max-products']),
    maxRequests: values['max-requests'] === undefined ? undefined : Number(values['max-requests']),
    productIds: values['product-ids']?.split(',').map(id => id.trim()), allowLive: values['allow-live'],
    fixture: values.fixture, fixtureCheckedAt: values['fixture-checked-at'] });
  console.log(JSON.stringify({ output: result.output, ...result.artifact.counts }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'product_nutrition_collection_failed'); process.exitCode = 1; });
}

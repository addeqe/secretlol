import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CoopClient, CoopMissingProductsError } from '../src/retailers/coop.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import { productIdentity } from '../src/retailers/identity.ts';
import { createRetailTransport } from '../src/retailers/transport.ts';
import { productId as validProductId, validateScope } from '../src/retailers/types.ts';
import type { ProductObservation, RetailProduct, StoreScope } from '../src/retailers/types.ts';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATE_IDS = 23;
const BATCH_SIZE = 25;
const MAX_REQUESTS = 2;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export type CandidateCollectionOptions = { overlay: string; output: string; allowLive?: boolean; fixture?: string };
type CollectionDependencies = { fetch?: typeof fetch; subscriptionKey?: string; now?: () => Date };
type Candidate = { productId: string; observedName: string; brand: string | null; ean: string | null;
  categories: string[]; pack: RetailProduct['pack']; ingredientsText: string | null };
type CandidateGroup = { foodId: string; sourceIdentity: string; candidates: Candidate[] };
type Overlay = { schemaVersion: 1; kind: 'local-coop-product-identity-review-overlay'; status: 'proposal_only_not_approval';
  sourceSnapshot: { datasetId: string; inventoryHash: string; scope: StoreScope; policy?: { version: string } };
  policy: { version: string }; proposals: CandidateGroup[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error('candidate_fixture_checked_at_required');
  return new Date(value).toISOString();
}
async function readJson(path: string) {
  const absolute = await realpath(resolve(path)), info = await lstat(absolute);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error('candidate_input_not_bounded_json');
  const bytes = await readFile(absolute);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error('candidate_input_too_large');
  return { path: absolute, sha256: hash(bytes), value: JSON.parse(bytes.toString('utf8')) as unknown };
}
function readOverlay(value: unknown): { overlay: Overlay; groups: CandidateGroup[]; ids: string[] } {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== 'local-coop-product-identity-review-overlay'
    || value.status !== 'proposal_only_not_approval' || !record(value.sourceSnapshot)
    || !Array.isArray(value.proposals) || !record(value.policy)
    || value.policy.version !== DIETARY_POLICY_VERSION) throw new Error('invalid_candidate_identity_overlay');
  const scope = value.sourceSnapshot.scope;
  validateScope(scope as StoreScope);
  if ((scope as StoreScope).storeId !== '256600' || (scope as StoreScope).channel !== 'pickup'
    || (scope as StoreScope).slotId !== undefined || typeof value.sourceSnapshot.datasetId !== 'string'
    || typeof value.sourceSnapshot.inventoryHash !== 'string') throw new Error('candidate_overlay_scope_or_snapshot_invalid');
  const groups: CandidateGroup[] = [];
  const ids: string[] = [];
  for (const item of value.proposals) {
    if (!record(item) || typeof item.foodId !== 'string' || typeof item.sourceIdentity !== 'string'
      || !Array.isArray(item.candidates) || item.candidates.length < 1) throw new Error('invalid_candidate_overlay_group');
    const candidates: Candidate[] = [];
    for (const candidate of item.candidates) {
      if (!record(candidate) || !validProductId(candidate.productId) || typeof candidate.observedName !== 'string'
        || !candidate.observedName.trim() || candidate.brand !== null && typeof candidate.brand !== 'string'
        || candidate.ean !== null && typeof candidate.ean !== 'string' || !Array.isArray(candidate.categories)
        || candidate.categories.some(category => typeof category !== 'string')
        || candidate.ingredientsText !== null && typeof candidate.ingredientsText !== 'string'
        || candidate.pack !== null && (!record(candidate.pack) || typeof candidate.pack.quantity !== 'number'
          || typeof candidate.pack.unit !== 'string' || typeof candidate.pack.approximate !== 'boolean')) {
        throw new Error('invalid_candidate_overlay_product');
      }
      ids.push(candidate.productId);
      candidates.push(candidate as unknown as Candidate);
    }
    groups.push({ foodId: item.foodId, sourceIdentity: item.sourceIdentity, candidates });
  }
  if (!ids.length || ids.length > MAX_CANDIDATE_IDS || new Set(ids).size !== ids.length) {
    throw new Error('candidate_id_budget_or_duplicate_violation');
  }
  return { overlay: value as unknown as Overlay, groups, ids: ids.sort() };
}
async function preflightOutput(output: string, inputs: string[]) {
  const target = resolve(output);
  if (inputs.includes(target)) throw new Error('candidate_output_is_input');
  try { await lstat(target); throw new Error('candidate_output_exists'); }
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
    await link(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}
function fixtureResponse(value: unknown) {
  if (!record(value) || value.retailer !== 'coop' || !record(value.scope)
    || value.scope.storeId !== '256600' || value.scope.channel !== 'pickup') throw new Error('invalid_candidate_fixture_scope');
  const checkedAt = timestamp(value.checkedAt);
  const response = value.response ?? value;
  if (!record(response) || !record(response.results) || !Array.isArray(response.results.items)
    || response.results.items.length > MAX_CANDIDATE_IDS
    || !Number.isSafeInteger(response.results.count) || response.results.count !== response.results.items.length) {
    throw new Error('invalid_candidate_fixture_response');
  }
  return { checkedAt, response };
}

/** Fetch only the fixed candidate IDs in an identity overlay; this never changes approvals or cloud state. */
export async function collectCoopCandidates(options: CandidateCollectionOptions, dependencies: CollectionDependencies = {}) {
  if (options.fixture && options.allowLive) throw new Error('choose_candidate_fixture_or_allow_live');
  if (!options.fixture && !options.allowLive) throw new Error('candidate_fixture_or_allow_live_required');
  const overlayInput = await readJson(options.overlay), parsed = readOverlay(overlayInput.value);
  const fixtureInput = options.fixture ? await readJson(options.fixture) : undefined;
  const output = await preflightOutput(options.output, [overlayInput.path, ...(fixtureInput ? [fixtureInput.path] : [])]);
  let client: CoopClient, transportMetrics: (() => { readonly requests: number; readonly retries: number }) | undefined;
  let fixtureCheckedAt: string | undefined;
  if (fixtureInput) {
    const fixture = fixtureResponse(fixtureInput.value);
    fixtureCheckedAt = fixture.checkedAt;
    const transport = createRetailTransport({ retailer: 'coop', maxRequests: MAX_REQUESTS, maxRunMs: 5 * 60_000,
      fetch: async () => new Response(JSON.stringify(fixture.response), { headers: { 'content-type': 'application/json' } }) });
    transportMetrics = () => transport.metrics;
    client = new CoopClient({ publicSubscriptionKey: 'offline-fixture-only', transport,
      now: () => new Date(fixtureCheckedAt!) });
  } else {
    const key = dependencies.subscriptionKey ?? process.env.COOP_PUBLIC_SUBSCRIPTION_KEY;
    if (!key) throw new Error('coop_public_subscription_key_required');
    if (Math.ceil(parsed.ids.length / BATCH_SIZE) > MAX_REQUESTS) throw new Error('candidate_lookup_batches_exceed_request_budget');
    const transport = createRetailTransport({ retailer: 'coop', fetch: dependencies.fetch,
      maxRequests: MAX_REQUESTS, maxRunMs: 5 * 60_000 });
    transportMetrics = () => transport.metrics;
    client = new CoopClient({ publicSubscriptionKey: key, transport, now: dependencies.now });
  }
  const scope = parsed.overlay.sourceSnapshot.scope;
  const idToCandidate = new Map(parsed.groups.flatMap(group => group.candidates.map(candidate => [candidate.productId,
    { group, candidate }] as const)));
  const observations = new Map<string, ProductObservation>(), missing = new Set<string>();
  let requestedIds = 0;
  for (let start = 0; start < parsed.ids.length; start += BATCH_SIZE) {
    const batch = parsed.ids.slice(start, start + BATCH_SIZE);
    requestedIds += batch.length;
    try {
      for (const observation of await client.products(scope, batch)) observations.set(observation.product.id, observation);
    } catch (error) {
      if (!(error instanceof CoopMissingProductsError)) throw error;
      for (const observation of error.observations) observations.set(observation.product.id, observation);
      error.missingProductIds.forEach(id => missing.add(id));
    }
  }
  const products = parsed.ids.map(id => {
    const entry = idToCandidate.get(id)!;
    const oldProduct = { id: entry.candidate.productId, ean: entry.candidate.ean, name: entry.candidate.observedName,
      brand: entry.candidate.brand, categories: entry.candidate.categories, pack: entry.candidate.pack,
      ingredientsText: entry.candidate.ingredientsText } as RetailProduct;
    const identityOld = productIdentity(oldProduct), observation = observations.get(id);
    if (!observation) return { foodId: entry.group.foodId, sourceIdentity: entry.group.sourceIdentity, productId: id,
      identityOld, identityOldHash: hash(identityOld), identityNew: null, identityNewHash: null,
      status: 'missing' as const, observation: null, nutritionSource: null };
    const identityNew = productIdentity(observation.product), same = identityOld === identityNew;
    return { foodId: entry.group.foodId, sourceIdentity: entry.group.sourceIdentity, productId: id,
      identityOld, identityOldHash: hash(identityOld), identityNew, identityNewHash: hash(identityNew),
      status: same ? 'unchanged' as const : 'changed' as const,
      observation, nutritionSource: observation.product.nutritionSource ?? null };
  });
  const counts = { candidateIds: parsed.ids.length, requestedIds, requests: transportMetrics?.().requests ?? 0,
    retries: transportMetrics?.().retries ?? 0, unchanged: products.filter(product => product.status === 'unchanged').length,
    changed: products.filter(product => product.status === 'changed').length, missing: products.filter(product => product.status === 'missing').length,
    nutritionSources: products.filter(product => product.nutritionSource !== null).length };
  const artifact = { schemaVersion: 1, retailer: 'coop', mode: fixtureInput ? 'fixture' : 'live',
    datasetId: parsed.overlay.sourceSnapshot.datasetId, inventoryHash: parsed.overlay.sourceSnapshot.inventoryHash,
    policyVersion: parsed.overlay.policy.version, scope, source: { overlay: overlayInput.path, overlaySha256: overlayInput.sha256,
      ...(fixtureInput ? { fixture: fixtureInput.path, fixtureSha256: fixtureInput.sha256, fixtureCheckedAt } : {}) },
    limits: { maxProductIds: MAX_CANDIDATE_IDS, batchSize: BATCH_SIZE, maxRequests: MAX_REQUESTS }, counts, products };
  await saveNewArtifact(output, artifact);
  return { output, artifact };
}

async function main() {
  const { values } = parseArgs({ options: { overlay: { type: 'string' }, output: { type: 'string' },
    'allow-live': { type: 'boolean', default: false }, fixture: { type: 'string' } } });
  if (!values.overlay || !values.output) throw new Error('Supply --overlay local-overlay.json --output NEW.json');
  const result = await collectCoopCandidates({ overlay: values.overlay, output: values.output,
    allowLive: values['allow-live'], fixture: values.fixture });
  console.log(JSON.stringify({ output: result.output, mode: result.artifact.mode, ...result.artifact.counts }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'coop_candidate_collection_failed'); process.exitCode = 1; });
}

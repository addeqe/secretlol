/** Build a local-only Coop review snapshot from independently reviewed deltas. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FOOD_RULES } from '../src/ingredient-vocabulary.ts';
import { ingredientId } from '../src/ingredient-matching.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import { observationUsable, productIdentity, reviewedProductPolicy, validateConnections, validateObservation } from '../src/retailers/identity.ts';
import type { ReviewedConnection } from '../src/retailers/identity.ts';
import type { ProductObservation, RetailProduct, StoreScope } from '../src/retailers/types.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => JSON.stringify(value);
const serialized = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
type Json = Record<string, any>;
type InputOptions = { dataset: string; sources: string; candidateObservations: string;
  bindingDelta: string; foodIdDelta: string; output: string; now?: number };
type Loaded = { path: string; sha256: string; value: Json };

function obj(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }
function need(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
async function readJson(path: string): Promise<Loaded> {
  const absolute = await realpath(resolve(path)), info = await lstat(absolute);
  need(info.isFile() && info.size <= 128 * 1024 * 1024, 'input_not_bounded_json');
  const bytes = await readFile(absolute);
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  need(obj(value), 'input_json_must_be_object');
  return { path: absolute, sha256: hash(bytes), value };
}
function identityHash(identity: string) { return hash(identity); }
function identitiesHash(identities: string[]) { return hash(canonical([...identities].sort())); }
function normalizeAlias(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']/g, '')
    .replace(/[^a-z0-9%]+/g, ' ').trim().replace(/\s+/g, ' ');
}
export function exactRuleAlias(alias: unknown, expectedFoodId?: string): { id: string; alias: string; ambiguous: boolean } {
  need(typeof alias === 'string' && alias.trim(), 'binding_alias_invalid');
  const key = normalizeAlias(alias);
  const hits = FOOD_RULES.flatMap(rule => rule.aliases.filter(a => normalizeAlias(a) === key)
    .map(a => ({ id: rule.id, alias: a, ambiguous: rule.ambiguous === true })));
  const distinctRules = new Map<string, { id: string; alias: string; ambiguous: boolean }>();
  for (const hit of hits) {
    const existing = distinctRules.get(hit.id);
    if (!existing || (hit.alias === alias && existing.alias !== alias)) distinctRules.set(hit.id, hit);
  }
  need(distinctRules.size === 1, hits.length ? 'food_rule_alias_ambiguous' : 'food_rule_alias_not_exact');
  const match = [...distinctRules.values()][0]!;
  need(!match.ambiguous, 'food_rule_alias_ambiguous');
  if (expectedFoodId !== undefined) need(match.id === expectedFoodId, 'food_rule_alias_food_id_mismatch');
  return match;
}
function sameScope(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
function currentPolicy(data: Json) {
  need(data.retailer === 'coop' && data.policyVersion === DIETARY_POLICY_VERSION,
    'policy_version_or_retailer_mismatch');
}
function checkSnapshot(data: Json, dataset: Json, policyRequired = false) {
  need(data.datasetId === dataset.datasetId && data.inventoryHash === dataset.inventoryHash,
    'source_dataset_hash_mismatch');
  need(sameScope(data.scope, dataset.scope), 'source_scope_mismatch');
  if (policyRequired) currentPolicy(data);
}
function toConnection(row: Json, foodId: string | null, products: Array<{ productId: string; identity: string }>,
  reviewedAt: string, reason: string): ReviewedConnection {
  const mainProductId = products[0]?.productId ?? null;
  return { ingredientId: row.ingredientId, name: row.name, foodId,
    status: products.length ? 'matched' : row.status,
    mainProductId: products.length ? mainProductId : null,
    approvedProducts: products,
    policyVersion: DIETARY_POLICY_VERSION, reviewedAt, reason };
}

export function mergeLocalCoopRegistry(inputs: { dataset: Json; datasetSha256: string; sources: Json; sourcesSha256: string;
  candidate: Json; candidateSha256: string; bindingDelta: Json; bindingDeltaSha256: string;
  foodIdDelta: Json; foodIdDeltaSha256: string; now?: number }) {
  const { dataset, sources, candidate, bindingDelta, foodIdDelta } = inputs;
  need(dataset.retailer === 'coop' && typeof dataset.datasetId === 'string' && typeof dataset.inventoryHash === 'string'
    && Array.isArray(dataset.connections) && Array.isArray(dataset.observations), 'invalid_reviewed_coop_dataset');
  need(dataset.scope?.channel === 'pickup' && !dataset.scope.slotId, 'local_merge_requires_pickup_scope');
  const now = inputs.now ?? Date.now();
  need(Number.isFinite(now), 'invalid_now');
  need(sources.schemaVersion === 1 && sources.mode === 'live' && sources.retailer === 'coop'
    && Array.isArray(sources.products), 'invalid_approved_source_collection');
  checkSnapshot(sources, dataset);
  need(sources.source?.inputSha256 === inputs.datasetSha256, 'approved_sources_dataset_hash_mismatch');
  need(candidate.schemaVersion === 1 && candidate.retailer === 'coop' && candidate.mode === 'live'
    && Array.isArray(candidate.products), 'invalid_candidate_observations');
  checkSnapshot(candidate, dataset, true);
  need(bindingDelta.kind === 'reviewed-coop-product-binding-delta'
    && bindingDelta.status === 'local_proposal_not_production', 'invalid_binding_delta');
  checkSnapshot(bindingDelta, dataset, true);
  need(bindingDelta.reviewContract?.bindingRequiresExactExistingFoodRuleAlias === true
    && bindingDelta.reviewContract?.identityAndPriceFreshnessAreSeparate === true,
  'binding_review_contract_missing');
  need(bindingDelta.input?.observationsSha256 === inputs.candidateSha256,
    'binding_candidate_observations_hash_mismatch');
  need(foodIdDelta.schemaVersion === 'coop-food-id-review-delta-1'
    && foodIdDelta.source?.datasetId === dataset.datasetId
    && foodIdDelta.source?.inventoryHash === dataset.inventoryHash
    && Array.isArray(foodIdDelta.entries)
    && foodIdDelta.count === foodIdDelta.entries.length, 'invalid_food_id_delta');

  const sourceById = new Map<string, ProductObservation>();
  for (const observation of dataset.observations as ProductObservation[]) {
    validateObservation(observation, 'coop', dataset.scope as StoreScope);
    const prior = sourceById.get(observation.product.id);
    if (!prior) sourceById.set(observation.product.id, observation);
    else need(productIdentity(prior.product) === productIdentity(observation.product), 'conflicting_original_observation_identity');
  }
  const originalByIngredient = new Map<string, ReviewedConnection>();
  for (const c of dataset.connections as ReviewedConnection[]) originalByIngredient.set(c.ingredientId, c);
  const nullFoodConnections = (dataset.connections as ReviewedConnection[]).filter(c => c.status === 'matched' && c.foodId === null);
  need(foodIdDelta.source?.matchedConnectionCount === nullFoodConnections.length
    && foodIdDelta.entries.length === nullFoodConnections.length, 'food_id_delta_inventory_count_mismatch');
  const nullFoodIds = new Set(nullFoodConnections.map(c => c.ingredientId));
  const deltaIds = new Set(foodIdDelta.entries.map((entry: Json) => entry.ingredientId));
  need(deltaIds.size === foodIdDelta.entries.length
    && foodIdDelta.entries.every((entry: Json) => nullFoodIds.has(entry.ingredientId)), 'food_id_delta_does_not_cover_inventory');
  // This validation proves the source inventory is internally coherent before applying either delta.
  validateConnections(dataset.connections as ReviewedConnection[], [...sourceById.values()].map(o => o.product));

  const candidateById = new Map<string, Json>();
  for (const item of candidate.products as Json[]) {
    need(item.status === 'unchanged' && item.identityOld === item.identityNew && item.observation,
      'candidate_not_identity_unchanged');
    const observation = item.observation as ProductObservation;
    validateObservation(observation, 'coop', dataset.scope as StoreScope);
    const identity = productIdentity(observation.product);
    need(item.productId === observation.product.id && item.identityNew === identity
      && item.identityNewHash === identityHash(identity), 'candidate_identity_hash_mismatch');
    need(!candidateById.has(item.productId), 'duplicate_candidate_product');
    candidateById.set(item.productId, item);
  }

  const connections = new Map((dataset.connections as ReviewedConnection[]).map(c => [c.ingredientId, structuredClone(c)]));
  const approvedExtra = new Map<string, { identity: string; observation: ProductObservation }>();
  const boundAliasCount = new Set<string>();
  let addedAliases = 0, updatedAliases = 0, bindingProducts = 0;
  for (const entry of bindingDelta.entries ?? []) {
    if (entry.decision !== 'eligible_binding') continue;
    need(typeof entry.foodId === 'string' && entry.foodRule?.id === entry.foodId && entry.foodRule.ambiguous !== true,
      'eligible_binding_food_rule_invalid');
    need(Array.isArray(entry.approvedSourceAliases) && entry.approvedSourceAliases.length > 0
      && Array.isArray(entry.approvedProducts) && entry.approvedProducts.length > 0
      && entry.approvedProducts.length <= 3, 'eligible_binding_shape_invalid');
    for (const alias of entry.approvedSourceAliases) exactRuleAlias(alias, entry.foodId);
    const products: Array<{ productId: string; identity: string }> = [];
    for (const approved of entry.approvedProducts) {
      const cand = candidateById.get(approved.productId);
      need(cand, 'binding_product_missing_from_candidates');
      const observation = cand.observation as ProductObservation;
      const identity = productIdentity(observation.product);
      need(identity === approved.productIdentity && identityHash(identity) === approved.identityHash,
        'binding_product_identity_hash_mismatch');
      need(!reviewedProductPolicy(observation.product, entry.foodId), 'binding_product_policy_blocked');
      const originalObservation = sourceById.get(approved.productId);
      need(originalObservation && productIdentity(originalObservation.product) === identity,
        'binding_product_identity_differs_from_original_observation');
      validateObservation(observation, 'coop', dataset.scope as StoreScope);
      // Validate price/freshness independently. Stale observations can carry identity/nutrition,
      // but cannot be advertised as current-price evidence in the output report.
      const priceCurrent = observationUsable(observation, 'coop', dataset.scope as StoreScope, now);
      products.push({ productId: approved.productId, identity });
      approvedExtra.set(approved.productId, { identity, observation });
      bindingProducts++;
      void priceCurrent;
    }
    for (const alias of entry.approvedSourceAliases as string[]) {
      const id = ingredientId(alias), key = `${entry.foodId}\0${id}`;
      need(!boundAliasCount.has(key), 'duplicate_reviewed_binding_alias');
      boundAliasCount.add(key);
      const prior = connections.get(id);
      if (prior) need(prior.name === alias, 'ingredient_id_name_collision');
      const result = toConnection({ ingredientId: id, name: alias, status: prior?.status ?? 'needs_review' },
        entry.foodId, products, bindingDelta.reviewedAt, `Reviewed local Coop binding for exact FOOD_RULES alias: ${alias}.`);
      // Do not bypass source-level policy when creating or refreshing a binding.
      need(!reviewedProductPolicy(approvedExtra.get(products[0]!.productId)!.observation.product, alias),
        'binding_alias_policy_blocked');
      if (prior) updatedAliases++; else addedAliases++;
      connections.set(id, result);
    }
  }

  const names = new Set<string>();
  for (const row of foodIdDelta.entries as Json[]) {
    need(row.expectedOldFoodId === null, 'food_id_delta_expected_old_id_mismatch');
    const prior = originalByIngredient.get(row.ingredientId);
    need(prior && prior.name === row.name && prior.status === 'matched' && prior.foodId === null,
      'food_id_delta_source_connection_mismatch');
    need(!names.has(row.name), 'duplicate_food_id_delta_name'); names.add(row.name);
    const approvals = prior.approvedProducts.map(x => x.identity).sort();
    need(row.approvedProductsidentitieshash === identitiesHash(approvals), 'food_id_delta_approved_identity_hash_mismatch');
    if (row.decision !== 'propose_food_id') {
      need(row.proposedFoodId === null, 'abstention_must_not_propose_food_id');
      continue;
    }
    need(typeof row.proposedFoodId === 'string', 'food_id_proposal_missing');
    const aliasProof = row.evidence;
    const matched = exactRuleAlias(aliasProof?.alias, row.proposedFoodId);
    need(aliasProof?.kind === 'exact_existing_food_rule_alias' && aliasProof.sourceName === row.name,
      'food_id_alias_evidence_invalid');
    need(normalizeAlias(row.name) === normalizeAlias(matched.alias), 'food_id_source_name_not_exact_alias');
    const existing = connections.get(row.ingredientId)!;
    connections.set(row.ingredientId, { ...existing, foodId: row.proposedFoodId,
      reason: `${existing.reason} Local registry merge added exact reviewed FOOD_RULES id ${row.proposedFoodId}.` });
  }

  const mergedConnections = [...connections.values()];
  const observations = new Map(sourceById);
  for (const [id, { observation }] of approvedExtra) observations.set(id, observation);
  validateConnections(mergedConnections, [...observations.values()].map(o => o.product));
  const approvedForms = new Set(mergedConnections.flatMap(c => c.approvedProducts.map(p =>
    `${c.foodId}\0${p.productId}\0${p.identity}`)));
  const productFormReviews = new Map<string, Json>();
  for (const prior of dataset.productFormReviews ?? []) {
    need(obj(prior) && typeof prior.foodId === 'string' && typeof prior.productId === 'string'
      && typeof prior.productIdentity === 'string' && prior.form === 'dried'
      && typeof prior.reviewedAt === 'string' && Number.isFinite(Date.parse(prior.reviewedAt))
      && /^[a-f0-9]{64}$/.test(prior.sourceSha256) && typeof prior.reason === 'string' && prior.reason.trim(),
    'invalid_prior_product_form_review');
    const key = `${prior.foodId}\0${prior.productId}\0${prior.productIdentity}`;
    need(approvedForms.has(key), 'prior_product_form_review_not_bound_to_approved_product');
    productFormReviews.set(key, structuredClone(prior));
  }
  for (const entry of bindingDelta.entries ?? []) {
    if (entry.decision !== 'eligible_binding' || entry.foodRule?.form !== 'dried') continue;
    for (const approved of entry.approvedProducts as Json[]) {
      const current = approvedExtra.get(approved.productId);
      need(current && current.identity === approved.productIdentity
        && approvedForms.has(`${entry.foodId}\0${approved.productId}\0${current.identity}`),
      'dried_form_review_product_identity_unverified');
      const key = `${entry.foodId}\0${approved.productId}\0${current.identity}`;
      if (!productFormReviews.has(key)) productFormReviews.set(key, {
        foodId: entry.foodId, productId: approved.productId, productIdentity: current.identity,
        form: 'dried', reviewedAt: bindingDelta.reviewedAt,
        sourceSha256: inputs.bindingDeltaSha256, reason: entry.decisionReason,
      });
    }
  }
  const datasetId = hash(canonical({ kind: 'local-coop-registry-v1', parent: dataset.datasetId,
    datasetSha256: inputs.datasetSha256, bindingDeltaSha256: inputs.bindingDeltaSha256,
    foodIdDeltaSha256: inputs.foodIdDeltaSha256, connectionIds: mergedConnections.map(c => c.ingredientId).sort() }));
  const inventoryHash = hash(canonical(mergedConnections.map(c => [c.ingredientId, c.name, c.foodId, c.status,
    c.mainProductId, c.approvedProducts]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
  const liveById = new Map<string, Json>();
  for (const row of sources.products as Json[]) {
    need(row.retailer === 'coop' && typeof row.productId === 'string', 'invalid_source_collection_product');
    liveById.set(row.productId, structuredClone(row));
  }
  const priceFreshness: Record<string, boolean> = {};
  for (const [id, { identity, observation }] of approvedExtra) {
    const isFresh = observationUsable(observation, 'coop', dataset.scope as StoreScope, now);
    priceFreshness[id] = isFresh;
    const existing = liveById.get(id);
    liveById.set(id, { retailer: 'coop', productId: id, productIdentity: identity,
      identityHash: identityHash(identity), checkedAt: observation.checkedAt,
      status: observation.product.nutritionSource ? 'collected' : 'nutrition_unavailable',
      nutritionSource: observation.product.nutritionSource ?? undefined, observation });
    // Existing approvals are retained only if their identity still agrees.
    if (existing) need(existing.productIdentity === identity, 'approved_source_collection_identity_mismatch');
  }
  const mergedDataset = { retailer: 'coop', scope: dataset.scope, datasetId, inventoryHash,
    localOnly: true, parentDatasetId: dataset.datasetId, observations: [...observations.values()],
    connections: mergedConnections, productFormReviews: [...productFormReviews.values()] };
  const mergedDatasetSha256 = hash(serialized(mergedDataset));
  const mergedSources = { schemaVersion: 1, retailer: 'coop', mode: 'live', datasetId, inventoryHash,
    scope: dataset.scope, localOnly: true, parentDatasetId: dataset.datasetId,
    source: { inputSha256: mergedDatasetSha256, parentDatasetSha256: inputs.datasetSha256,
      approvedObservationsSha256: inputs.sourcesSha256,
      candidateObservationsSha256: inputs.candidateSha256, bindingDeltaSha256: inputs.bindingDeltaSha256,
      foodIdDeltaSha256: inputs.foodIdDeltaSha256 },
    products: [...liveById.values()] };
  const report = { schemaVersion: 1, localOnly: true, parentDatasetId: dataset.datasetId,
    datasetId, inventoryHash, sourceHashes: { dataset: inputs.datasetSha256, sources: inputs.sourcesSha256,
      candidates: inputs.candidateSha256, bindingDelta: inputs.bindingDeltaSha256, foodIdDelta: inputs.foodIdDeltaSha256 },
    counts: { originalConnections: dataset.connections.length, outputConnections: mergedConnections.length,
      boundAliasesAdded: addedAliases, boundAliasesUpdated: updatedAliases, candidateBindingProducts: bindingProducts,
      foodIdProposals: (foodIdDelta.entries as Json[]).filter(x => x.decision === 'propose_food_id').length,
      foodIdAbstentions: (foodIdDelta.entries as Json[]).filter(x => x.decision !== 'propose_food_id').length,
      productFormReviews: productFormReviews.size,
      sourceProducts: mergedSources.products.length, mergedDatasetSha256 },
    candidatePriceFreshness: priceFreshness };
  return { dataset: mergedDataset, sources: mergedSources, report };
}

async function saveNewDirectory(output: string, files: Record<string, unknown>, inputPaths: string[]) {
  const target = resolve(output);
  need(!inputPaths.includes(target), 'output_is_input');
  try { await lstat(target); throw new Error('output_already_exists'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.local-build-${process.pid}-${Date.now()}`;
  try {
    await mkdir(temp);
    for (const [name, value] of Object.entries(files)) {
      await writeFile(resolve(temp, name), serialized(value), { flag: 'wx', mode: 0o600 });
    }
    await rename(temp, target);
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}

export async function buildLocalCoopRegistry(options: InputOptions) {
  const loaded = await Promise.all([options.dataset, options.sources, options.candidateObservations,
    options.bindingDelta, options.foodIdDelta].map(readJson));
  const [dataset, sources, candidate, bindingDelta, foodIdDelta] = loaded;
  const merged = mergeLocalCoopRegistry({ dataset: dataset!.value, datasetSha256: dataset!.sha256,
    sources: sources!.value, sourcesSha256: sources!.sha256, candidate: candidate!.value,
    candidateSha256: candidate!.sha256, bindingDelta: bindingDelta!.value,
    bindingDeltaSha256: bindingDelta!.sha256, foodIdDelta: foodIdDelta!.value,
    foodIdDeltaSha256: foodIdDelta!.sha256, now: options.now });
  await saveNewDirectory(options.output, { 'dataset.json': merged.dataset,
    'source-collection.json': merged.sources, 'report.json': merged.report }, loaded.map(x => x!.path));
  return { output: resolve(options.output), ...merged.report };
}

async function main() {
  const { values } = parseArgs({ options: { dataset: { type: 'string' }, sources: { type: 'string' },
    'candidate-observations': { type: 'string' }, 'binding-delta': { type: 'string' },
    'food-id-delta': { type: 'string' }, output: { type: 'string' } } });
  need(values.dataset && values.sources && values['candidate-observations'] && values['binding-delta']
    && values['food-id-delta'] && values.output, 'supply_all_inputs_and_new_output_directory');
  const result = await buildLocalCoopRegistry({ dataset: values.dataset, sources: values.sources,
    candidateObservations: values['candidate-observations'], bindingDelta: values['binding-delta'],
    foodIdDelta: values['food-id-delta'], output: values.output });
  console.log(JSON.stringify({ output: result.output, localOnly: true, ...result.counts }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'local_coop_registry_build_failed'); process.exitCode = 1; });
}

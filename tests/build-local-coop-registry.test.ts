import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildLocalCoopRegistry, exactRuleAlias, mergeLocalCoopRegistry } from '../scripts/build-local-coop-registry.ts';
import { ingredientId } from '../src/ingredient-matching.ts';
import { productIdentity } from '../src/retailers/identity.ts';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const scope = { storeId: '256600', channel: 'pickup' as const };
const checkedAt = '2026-10-14T12:00:00.000Z';
const expiresAt = '2026-10-18T22:00:00.000Z';

function fixture() {
  const product = { id: 'sku-pom', ean: 'sku-pom', name: 'Granatäppeljuice', brand: 'LAVI',
    categories: ['334695'], pack: { quantity: 1000, unit: 'ml' as const, approximate: false },
    ingredientsText: 'Granatäpple.' };
  const observation = { retailer: 'coop' as const, scope, product,
    price: { amountOre: 2000, basis: 'pack' as const, depositOre: 0, memberOnly: false,
      minimumQuantity: null, validFrom: null, validUntil: null },
    availability: 'available' as const, checkedAt, expiresAt, storeScopeVerified: true };
  const identity = productIdentity(product);
  const row = { ingredientId: ingredientId('pomegranate juice'), name: 'pomegranate juice', foodId: null,
    status: 'matched' as const, mainProductId: product.id, approvedProducts: [{ productId: product.id, identity }],
    policyVersion: 'owner-halal-brands-strict-2', reviewedAt: checkedAt,
    reason: 'Reviewed exact product identity.' };
  const dataset = { retailer: 'coop', scope, datasetId: 'parent-dataset', inventoryHash: 'parent-inventory',
    observations: [observation], connections: [row] };
  const datasetSha256 = hash('original-dataset-bytes');
  const candidateSha256 = hash('candidate-bytes');
  const sources = { schemaVersion: 1, retailer: 'coop', mode: 'live', datasetId: dataset.datasetId,
    inventoryHash: dataset.inventoryHash, scope, source: { inputSha256: datasetSha256 },
    products: [{ retailer: 'coop', productId: product.id, productIdentity: identity,
      identityHash: hash(identity), checkedAt, status: 'collected', nutritionSource: null, observation }] };
  const candidate = { schemaVersion: 1, retailer: 'coop', mode: 'live', datasetId: dataset.datasetId,
    inventoryHash: dataset.inventoryHash, policyVersion: 'owner-halal-brands-strict-2', scope,
    products: [{ foodId: 'pomegranate-juice', productId: product.id, identityOld: identity,
      identityNew: identity, identityNewHash: hash(identity), status: 'unchanged', observation }] };
  const bindingDelta = { kind: 'reviewed-coop-product-binding-delta', status: 'local_proposal_not_production',
    retailer: 'coop', datasetId: dataset.datasetId, inventoryHash: dataset.inventoryHash, policyVersion: 'owner-halal-brands-strict-2',
    scope, reviewedAt: checkedAt,
    input: { observationsSha256: candidateSha256 },
    reviewContract: { bindingRequiresExactExistingFoodRuleAlias: true, identityAndPriceFreshnessAreSeparate: true },
    entries: [{ foodId: 'pomegranate-juice', decision: 'eligible_binding', foodRule: { id: 'pomegranate-juice', ambiguous: false },
      approvedSourceAliases: ['pomegranate juice'], approvedProducts: [{ productId: product.id,
        productIdentity: identity, identityHash: hash(identity) }] }] };
  const foodIdDelta = { schemaVersion: 'coop-food-id-review-delta-1',
    source: { datasetId: dataset.datasetId, inventoryHash: dataset.inventoryHash, matchedConnectionCount: 1 }, count: 1,
    entries: [{ ingredientId: row.ingredientId, name: row.name, proposedFoodId: 'pomegranate-juice',
      expectedOldFoodId: null, approvedProductsidentitieshash: hash(JSON.stringify([identity])),
      evidence: { kind: 'exact_existing_food_rule_alias', foodRuleId: 'pomegranate-juice',
        alias: 'pomegranate juice', sourceName: 'pomegranate juice' }, decision: 'propose_food_id' }] };
  const inputs = { dataset, datasetSha256, sources, sourcesSha256: hash('source-bytes'), candidate,
    candidateSha256, bindingDelta, bindingDeltaSha256: hash('binding-bytes'), foodIdDelta,
    foodIdDeltaSha256: hash('food-id-bytes'), now: Date.parse(checkedAt) };
  return { inputs, product, observation, identity };
}

test('merges only reviewed aliases into a local-only, identity-matched snapshot', () => {
  const { inputs } = fixture();
  const result = mergeLocalCoopRegistry(inputs);
  assert.equal(result.dataset.localOnly, true);
  assert.notEqual(result.dataset.datasetId, inputs.dataset.datasetId);
  assert.notEqual(result.dataset.inventoryHash, inputs.dataset.inventoryHash);
  assert.equal(result.dataset.connections[0].foodId, 'pomegranate-juice');
  assert.equal(result.sources.datasetId, result.dataset.datasetId);
  assert.equal(result.sources.products[0].status, 'nutrition_unavailable');
  assert.equal(result.report.counts.boundAliasesUpdated, 1);
  assert.equal(result.report.candidatePriceFreshness['sku-pom'], true);
});

test('merged source hash binds exact serialized dataset bytes and supports a second merge', () => {
  const { inputs } = fixture();
  const first = mergeLocalCoopRegistry(inputs);
  const datasetBytes = JSON.stringify(first.dataset, null, 2) + '\n';
  assert.equal(first.sources.source.inputSha256, hash(datasetBytes));
  const secondInputs: any = structuredClone(inputs);
  secondInputs.dataset = JSON.parse(datasetBytes);
  secondInputs.datasetSha256 = hash(datasetBytes);
  secondInputs.sources = JSON.parse(JSON.stringify(first.sources));
  secondInputs.sourcesSha256 = hash(JSON.stringify(first.sources));
  secondInputs.candidate.datasetId = first.dataset.datasetId;
  secondInputs.candidate.inventoryHash = first.dataset.inventoryHash;
  secondInputs.bindingDelta.datasetId = first.dataset.datasetId;
  secondInputs.bindingDelta.inventoryHash = first.dataset.inventoryHash;
  secondInputs.bindingDelta.entries = [];
  secondInputs.foodIdDelta.source.datasetId = first.dataset.datasetId;
  secondInputs.foodIdDelta.source.inventoryHash = first.dataset.inventoryHash;
  secondInputs.foodIdDelta.source.matchedConnectionCount = 0;
  secondInputs.foodIdDelta.entries = [];
  secondInputs.foodIdDelta.count = 0;
  const second = mergeLocalCoopRegistry(secondInputs);
  assert.equal(second.dataset.localOnly, true);
  assert.equal(second.dataset.parentDatasetId, first.dataset.datasetId);
});

test('rejects candidate SKU or identity drift', () => {
  const { inputs } = fixture();
  const wrongSku = structuredClone(inputs);
  wrongSku.bindingDelta.entries[0].approvedProducts[0].productId = 'other-sku';
  assert.throws(() => mergeLocalCoopRegistry(wrongSku), /binding_product_missing_from_candidates/);

  const wrongIdentity = structuredClone(inputs);
  const changed = wrongIdentity;
  changed.candidate.products[0].observation = structuredClone(changed.candidate.products[0].observation);
  changed.candidate.products[0].observation.product.name = 'Different juice';
  assert.throws(() => mergeLocalCoopRegistry(changed), /candidate_identity_hash_mismatch/);
});

test('rejects stale source hashes and ambiguous exact food aliases', () => {
  const wrongHash = fixture().inputs;
  wrongHash.bindingDelta.input.observationsSha256 = 'wrong';
  assert.throws(() => mergeLocalCoopRegistry(wrongHash), /binding_candidate_observations_hash_mismatch/);

  const wrongDataset = fixture().inputs;
  wrongDataset.sources.inventoryHash = 'different-inventory';
  assert.throws(() => mergeLocalCoopRegistry(wrongDataset), /source_dataset_hash_mismatch/);

  const ambiguous = fixture().inputs;
  ambiguous.bindingDelta.entries[0].foodId = 'parsley-unspecified';
  ambiguous.bindingDelta.entries[0].foodRule.id = 'parsley-unspecified';
  ambiguous.bindingDelta.entries[0].approvedSourceAliases = ['parsley'];
  assert.throws(() => mergeLocalCoopRegistry(ambiguous), /food_rule_alias_ambiguous/);
});

test('normalization-equivalent aliases within one food rule are not ambiguous', () => {
  assert.equal(exactRuleAlias('jalapeno').id, 'jalapeno');
  assert.equal(exactRuleAlias('jalapeño').id, 'jalapeno');
  assert.throws(() => exactRuleAlias('parsley'), /food_rule_alias_ambiguous/);
});

test('rejects a current candidate whose disclosed ingredients violate policy', () => {
  const { inputs } = fixture();
  const blocked = structuredClone(inputs);
  blocked.candidate.products[0].observation = structuredClone(blocked.candidate.products[0].observation);
  const product = { ...blocked.candidate.products[0].observation.product,
    ingredientsText: 'Water, white wine.' };
  const identity = productIdentity(product);
  for (const item of [blocked.candidate.products[0], blocked.bindingDelta.entries[0].approvedProducts[0]]) {
    if ('observation' in item) { item.observation.product = product; item.identityOld = identity; item.identityNew = identity; item.identityNewHash = hash(identity); }
    else { item.productIdentity = identity; item.identityHash = hash(identity); }
  }
  assert.throws(() => mergeLocalCoopRegistry(blocked), /binding_product_policy_blocked/);
});

test('writes a new output directory atomically and refuses overwrite', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'local-coop-registry-'));
  try {
    const paths = [] as string[];
    const fixtureFiles = fixture();
    const values = [fixtureFiles.inputs.dataset, fixtureFiles.inputs.sources, fixtureFiles.inputs.candidate,
      fixtureFiles.inputs.bindingDelta, fixtureFiles.inputs.foodIdDelta];
    const names = ['dataset.json', 'sources.json', 'candidate.json', 'binding.json', 'food-id.json'];
    const write = async (i: number) => {
      const path = join(tmp, names[i]!); const bytes = JSON.stringify(values[i]);
      await import('node:fs/promises').then(fs => fs.writeFile(path, bytes)); paths[i] = path; return hash(bytes);
    };
    const datasetHash = await write(0);
    fixtureFiles.inputs.sources.source.inputSha256 = datasetHash;
    const candidateHash = await write(2);
    fixtureFiles.inputs.bindingDelta.input.observationsSha256 = candidateHash;
    await write(1);
    await write(3);
    await write(4);
    const output = join(tmp, 'new-snapshot');
    const result = await buildLocalCoopRegistry({ dataset: paths[0]!, sources: paths[1]!, candidateObservations: paths[2]!,
      bindingDelta: paths[3]!, foodIdDelta: paths[4]!, output, now: Date.parse(checkedAt) });
    const written = JSON.parse(await readFile(join(output, 'dataset.json'), 'utf8'));
    assert.equal(written.localOnly, true);
    assert.equal(result.localOnly, true);
    await assert.rejects(buildLocalCoopRegistry({ dataset: paths[0]!, sources: paths[1]!, candidateObservations: paths[2]!,
      bindingDelta: paths[3]!, foodIdDelta: paths[4]!, output, now: Date.parse(checkedAt) }), /output_already_exists/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

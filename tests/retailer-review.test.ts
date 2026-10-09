import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compactReviewBatches, expandCompactReviewDecisions, prepareReviewBatches, validateReviewedInventory,
  coopReviewCategoryMap, manualNominationsHash, reviewCatalogueHash, type CloudIngredientInventory,
  mergeManualReviewNominations, type CompactReviewDecisionSet, type ManualReviewNominations } from '../src/retailers/review.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import { productIdentity, reviewedProductPolicy, validateConnections } from '../src/retailers/identity.ts';
import { ingredientId } from '../src/ingredient-matching.ts';
import type { ProductObservation } from '../src/retailers/types.ts';

const now = Date.parse('2026-10-08T10:00:00.000Z');
const scope = { storeId: 'ica-store-17', channel: 'pickup' as const };
const requirements = [{ name: 'cucumber', occurrences: 2 }, { name: 'salt', occurrences: 1 }];
const inventory: CloudIngredientInventory = {
  schemaVersion: 1,
  datasetId: 'a'.repeat(64),
  sourceDatabaseSha256: 'a'.repeat(64),
  inventorySource: 'cloud-recipe-database',
  hash: createHash('sha256').update(JSON.stringify(requirements)).digest('hex'),
  recipes: 12,
  ingredientOccurrences: 3,
  distinctIngredients: 2,
  dietaryPolicy: { version: DIETARY_POLICY_VERSION },
  requirements,
};
const observation: ProductObservation = {
  retailer: 'ica', scope, storeScopeVerified: true,
  product: { id: 'prod-1', ean: '7310000000012', name: 'Gurka', brand: null,
    categories: ['Frukt och grönt'], pack: { quantity: 300, unit: 'g', approximate: false },
    ingredientsText: 'Gurka 100%' },
  price: { amountOre: 1990, basis: 'kg', depositOre: null, memberOnly: false,
    minimumQuantity: null, validFrom: null, validUntil: null },
  availability: 'available', checkedAt: '2026-10-08T09:00:00.000Z',
  expiresAt: '2026-10-08T11:00:00.000Z',
};

test('Coop category ID resolution maps readable ancestor paths to matcher families', () => {
  const categories = coopReviewCategoryMap([
    { categoryId: '32361', name: 'Frukt & grönsaker > Grönsaker > Gurka' },
    { categoryId: '32203', name: 'Kött, fågel & chark > Kyckling & fågel' },
    { categoryId: '21330', name: 'Skafferi' },
  ]);
  assert.ok(categories['32361'].includes('frukt'));
  assert.ok(categories['32203'].includes('kott'));
  assert.ok(categories['21330'].includes('skafferi'));
  const mixedCanning = coopReviewCategoryMap([
    { categoryId: 'tuna-cans', name: 'Kött & fiskkonserver > Tonfisk' },
    { categoryId: 'chicken-cans', name: 'Kött & fiskkonserver > Kyckling' },
  ]);
  assert.ok(mixedCanning['tuna-cans'].includes('fisk'));
  assert.ok(!mixedCanning['tuna-cans'].includes('kott'));
  assert.ok(mixedCanning['chicken-cans'].includes('kott'));
  assert.equal(reviewedProductPolicy({ name: 'Tonfisk i olja', brand: 'Xtra',
    categories: mixedCanning['tuna-cans'], ingredientsText: 'Tonfisk, olja' }, 'tuna'), null);
  assert.match(reviewedProductPolicy({ name: 'Kycklingfilé', brand: 'Coop',
    categories: mixedCanning['chicken-cans'], ingredientsText: 'Kyckling' }, 'chicken breast') ?? '', /meat_brand_not_permitted/);
});

test('prepares bounded review batches with scoped identities and no automatic approvals', () => {
  const batches = prepareReviewBatches(inventory, [observation], 'ica', scope, 1, now);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].batchCount, 2);
  assert.equal(batches[0].items[0].reviewStatus, 'needs_review');
  assert.equal(batches[0].items[0].sourceFoodId, 'cucumber');
  const cucumber = batches[0].items[0];
  assert.equal(cucumber.candidates[0].productIdentity, productIdentity(observation.product));
  assert.equal(cucumber.candidates[0].ingredientsText, observation.product.ingredientsText);
  assert.deepEqual(cucumber.candidates[0].normalizedPack, {
    label: '300g', quantity: 300, unit: 'g', drainedGrams: null, approximate: false,
  });
  assert.equal(cucumber.candidates[0].price?.amountOre, 1990);
  assert.equal(cucumber.candidates[0].matcherEligible, false);
  assert.equal(cucumber.candidates[0].matcherExclusion, 'price_or_comparison_basis_unknown');
  assert.equal(batches[0].inventoryHash, inventory.hash);
  const { schemaVersion: _schemaVersion, ...cloudReturnedShape } = inventory;
  assert.equal(prepareReviewBatches(cloudReturnedShape, [observation], 'ica', scope, 25, now).length, 1);
  assert.throws(() => prepareReviewBatches(inventory, [observation], 'ica', scope, 26, now), /invalid_review_group_size/);
});

test('rejects modified inventories, cross-scope observations, and blocked ingredients', () => {
  assert.throws(() => prepareReviewBatches({ ...inventory, hash: 'b'.repeat(64) }, [observation], 'ica', scope, 25, now), /hash_mismatch/);
  assert.throws(() => prepareReviewBatches(inventory, [{ ...observation, storeScopeVerified: false }], 'ica', scope, 25, now), /invalid_product_observation/);
  const pork = [{ name: 'pork', occurrences: 1 }];
  assert.throws(() => prepareReviewBatches({ ...inventory, requirements: pork,
    hash: createHash('sha256').update(JSON.stringify(pork)).digest('hex'),
    ingredientOccurrences: 1, distinctIngredients: 1 }, [observation], 'ica', scope, 25, now), /invalid_cloud_ingredient_inventory/);
});

test('screens disclosed product ingredients at review, publication, and quote validation without vinegar false positives', () => {
  const vinegar = { ...observation.product, ingredientsText: 'Vatten, äppelcidervinäger, senapsfrö' };
  const nonAlcoholic = { ...observation.product, ingredientsText: 'Water, non alcoholic beer flavour, spices' };
  const wine = { ...observation.product, ingredientsText: 'Gurka, vitt vin, vatten' };
  const uncertainRennet = { ...observation.product, ingredientsText: 'Milk, ystenzym, salt' };
  const swedishRennet = { ...observation.product, ingredientsText: 'Mjölk, salt, löpe' };
  const eggMayo = { ...observation.product, brand: 'Eriks Såser', ingredientsText:
    'Rapsolja, äggula, vitlök, vitvinsvinäger. Ägg från frigående höns.' };
  const chickenWithEgg = { ...observation.product, ingredientsText:
    'Kycklingkött, ägg från frigående höns.' };
  assert.equal(reviewedProductPolicy(vinegar), null);
  assert.equal(reviewedProductPolicy(nonAlcoholic), null);
  assert.match(reviewedProductPolicy(wine) ?? '', /ingredient_alcohol/);
  assert.match(reviewedProductPolicy(uncertainRennet) ?? '', /uncertain_animal_source/);
  assert.match(reviewedProductPolicy(swedishRennet) ?? '', /uncertain_animal_source/);
  assert.equal(reviewedProductPolicy(eggMayo), null);
  assert.match(reviewedProductPolicy(chickenWithEgg) ?? '', /meat_brand_not_permitted/);

  const matched = { ingredientId: ingredientId('cucumber'), name: 'cucumber', foodId: 'cucumber',
    status: 'matched' as const, mainProductId: wine.id,
    approvedProducts: [{ productId: wine.id, identity: productIdentity(wine) }],
    policyVersion: DIETARY_POLICY_VERSION, reviewedAt: '2026-10-08T09:30:00.000Z', reason: 'Candidate review.' };
  assert.throws(() => validateConnections([matched], [wine]), /connection_product_not_permitted/);
  assert.equal(prepareReviewBatches(inventory, [{ ...observation, product: wine }], 'ica', scope, 25, now)[0]
    .items.find(item => item.name === 'cucumber')?.candidates.length, 0);
});

test('validates complete reviewed decisions against inventory, scope, and current product identity', () => {
  const connection = (name: string, ingredientId: string, foodId: string) => ({
    ingredientId, name, foodId, status: 'unavailable' as const, mainProductId: null,
    approvedProducts: [], policyVersion: DIETARY_POLICY_VERSION,
    reviewedAt: '2026-10-08T09:30:00.000Z', reason: 'Checked current store catalogue',
  });
  const decisions = {
    retailer: 'ica' as const, scope, datasetId: inventory.datasetId,
    inventoryHash: inventory.hash, policyVersion: DIETARY_POLICY_VERSION,
    connections: [connection('cucumber', 'ing_1', 'cucumber'), connection('salt', 'ing_2', 'salt')],
  };
  // These IDs are deterministic outputs from the same matcher that prepares the queue.
  decisions.connections[0].ingredientId = ingredientId('cucumber');
  decisions.connections[1].ingredientId = ingredientId('salt');
  assert.equal(validateReviewedInventory(inventory, [observation], decisions, 'ica', scope, now).length, 2);
  assert.throws(() => validateReviewedInventory(inventory, [observation], {
    ...decisions, connections: decisions.connections.slice(0, 1),
  }, 'ica', scope, now), /review_inventory_names_mismatch/);
  assert.throws(() => validateReviewedInventory(inventory, [observation], {
    ...decisions, scope: { storeId: 'other-store', channel: 'pickup' },
  }, 'ica', scope, now), /review_snapshot_scope_mismatch/);
  const matched = { ...decisions.connections[0], status: 'matched' as const,
    mainProductId: observation.product.id,
    approvedProducts: [{ productId: observation.product.id, identity: productIdentity(observation.product) }],
  };
  const validMatched = { ...decisions, connections: [matched, decisions.connections[1]] };
  assert.equal(validateReviewedInventory(inventory, [observation], validMatched, 'ica', scope, now)[0].status, 'matched');
  assert.throws(() => validateReviewedInventory(inventory, [{ ...observation,
    product: { ...observation.product, name: 'Different cucumber' } }], validMatched, 'ica', scope, now), /review_product_not_a_matcher_candidate/);
});

test('rejects explicit matches outside the matcher candidate set, such as rice mapped to sugar', () => {
  const requirement = [{ name: 'rice', occurrences: 1 }];
  const riceInventory: CloudIngredientInventory = {
    ...inventory, requirements: requirement, hash: createHash('sha256').update(JSON.stringify(requirement)).digest('hex'),
    ingredientOccurrences: 1, distinctIngredients: 1,
  };
  const sugar: ProductObservation = { ...observation, product: { ...observation.product,
    id: 'sugar-1', ean: null, name: 'Socker', categories: ['Skafferi'], pack: { quantity: 1, unit: 'g', approximate: false } } };
  const [reviewed] = prepareReviewBatches(riceInventory, [sugar], 'ica', scope, 25, now);
  assert.equal(reviewed.items[0].candidates.length, 0);
  const decision = {
    retailer: 'ica' as const, scope, datasetId: riceInventory.datasetId, inventoryHash: riceInventory.hash,
    policyVersion: DIETARY_POLICY_VERSION,
    connections: [{ ingredientId: ingredientId('rice'), name: 'rice', foodId: 'rice', status: 'matched' as const,
      mainProductId: sugar.product.id,
      approvedProducts: [{ productId: sugar.product.id, identity: productIdentity(sugar.product) }],
      policyVersion: DIETARY_POLICY_VERSION, reviewedAt: '2026-10-08T09:30:00.000Z', reason: 'Reviewed manually' }],
  };
  assert.throws(() => validateReviewedInventory(riceInventory, [sugar], decision, 'ica', scope, now),
    /review_product_not_a_matcher_candidate/);
});

test('compact review parts expand IDs through the current candidate and full identity only', () => {
  const current = { ...observation, price: { ...observation.price!, depositOre: 0 } };
  const [batch] = compactReviewBatches(inventory, [current], 'ica', scope, 1, now);
  const cucumber = batch.items.find(item => item.name === 'cucumber')!;
  assert.ok(cucumber.candidates[0].matcherEligible);
  assert.equal('productIdentity' in cucumber.candidates[0], false);
  const decisions: CompactReviewDecisionSet = { retailer: 'ica', scope, datasetId: inventory.datasetId,
    inventoryHash: inventory.hash, policyVersion: DIETARY_POLICY_VERSION, part: 1, partCount: 1,
    catalogueHash: reviewCatalogueHash([current]), nominationsHash: null,
    connections: batch.items.map(item => ({ ingredientId: item.ingredientId, name: item.name,
      sourceFoodId: item.sourceFoodId, status: item.name === 'cucumber' ? 'matched' as const : 'unavailable' as const,
      approvedProductIds: item.name === 'cucumber' ? [cucumber.candidates[0].productId] : [],
      reason: item.name === 'cucumber' ? 'Exact fresh cucumber identity; selected one compatible current item.' : 'No applicable catalog candidate.' })) };
  const [connection] = expandCompactReviewDecisions(inventory, [current], [batch], [decisions], 'ica', scope, now);
  assert.equal(connection.status, 'matched');
  assert.equal(connection.approvedProducts[0].identity, productIdentity(current.product));
  const changed = { ...batch, items: batch.items.map(item => item.name === 'cucumber' ? { ...item,
    candidates: item.candidates.map(candidate => ({ ...candidate, ingredientsText: 'Changed after review' })) } : item) };
  assert.throws(() => expandCompactReviewDecisions(inventory, [current], [changed], [decisions], 'ica', scope, now),
    /compact_review_batch_candidates_changed/);
  assert.throws(() => expandCompactReviewDecisions(inventory, [current], [{ ...batch,
    scope: { storeId: 'other-store', channel: 'pickup' } }], [decisions], 'ica', scope, now),
    /compact_review_batch_snapshot_mismatch/);
  const duplicated = { ...decisions, connections: [decisions.connections[0], decisions.connections[0]] };
  assert.throws(() => expandCompactReviewDecisions(inventory, [current], [batch], [duplicated], 'ica', scope, now),
    /compact_review_decision_name_mismatch/);
});

test('compact review expansion refuses non-eligible prices and meat outside approved brands', () => {
  const [batch] = compactReviewBatches(inventory, [observation], 'ica', scope, 1, now);
  const cucumber = batch.items.find(item => item.name === 'cucumber')!;
  const decisions: CompactReviewDecisionSet = { retailer: 'ica', scope, datasetId: inventory.datasetId,
    inventoryHash: inventory.hash, policyVersion: DIETARY_POLICY_VERSION, part: 1, partCount: 1,
    catalogueHash: reviewCatalogueHash([observation]), nominationsHash: null,
    connections: batch.items.map(item => ({ ingredientId: item.ingredientId, name: item.name,
      sourceFoodId: item.sourceFoodId, status: item.name === 'cucumber' ? 'matched' as const : 'unavailable' as const,
      approvedProductIds: item.name === 'cucumber' ? [cucumber.candidates[0].productId] : [], reason: 'Reviewed identity.' })) };
  assert.equal(cucumber.candidates[0].matcherEligible, false);
  assert.throws(() => expandCompactReviewDecisions(inventory, [observation], [batch], [decisions], 'ica', scope, now),
    /compact_review_product_not_eligible/);

  const chicken = [{ name: 'chicken breast', occurrences: 1 }];
  const chickenInventory: CloudIngredientInventory = { ...inventory, requirements: chicken,
    hash: createHash('sha256').update(JSON.stringify(chicken)).digest('hex'), ingredientOccurrences: 1,
    distinctIngredients: 1 };
  const unapproved: ProductObservation = { ...observation, product: { ...observation.product,
    id: 'chicken-1', ean: null, name: 'Kycklingfilé', brand: 'Random brand', categories: ['Kött'],
    pack: { quantity: 500, unit: 'g', approximate: false } } };
  const [meatBatch] = compactReviewBatches(chickenInventory, [unapproved], 'ica', scope, 1, now);
  assert.deepEqual(meatBatch.items[0].candidates, []);
});

test('prior ingredient assessments seed exact same-name-and-brand candidates for manual review', () => {
  const requirement = [{ name: 'Chinese five spice powder', occurrences: 2 }];
  const seededInventory: CloudIngredientInventory = { ...inventory, requirements: requirement,
    hash: createHash('sha256').update(JSON.stringify(requirement)).digest('hex'), ingredientOccurrences: 2,
    distinctIngredients: 1 };
  const seededObservation: ProductObservation = { ...observation, product: { ...observation.product,
    id: 'spice-1', ean: '7310000000099', name: 'Five Spice Mix', brand: 'Kockens', categories: ['Skafferi'],
    pack: { quantity: 35, unit: 'g', approximate: false } }, price: { ...observation.price!, basis: 'pack', depositOre: 0 } };
  const assessment = { name: requirement[0].name, outcome: 'approve' as const, approvedCodes: ['old-catalogue-id'], basis: 'kg' as const,
    reason: 'Reviewed as a five-spice powder.', evidence: ['Exact previous product title and brand'],
    reviewedAt: '2026-10-08T09:30:00.000Z', reviewerModel: 'gpt-6-luna', catalogueSnapshotId: 'old-snapshot',
    catalogueIdentityHash: 'b'.repeat(64), products: [{ code: 'old-catalogue-id', name: 'Five Spice Mix', brand: 'Kockens' }] };
  const [batch] = compactReviewBatches(seededInventory, [seededObservation], 'ica', scope, 1, now, undefined,
    { [requirement[0].name]: assessment });
  assert.equal(batch.items[0].sourceFoodId, null);
  assert.equal(batch.items[0].candidates[0].proposalSource, 'prior_review_same_name_brand');
  assert.equal(batch.items[0].candidates[0].productId, seededObservation.product.id);
  const decisions: CompactReviewDecisionSet = { retailer: 'ica', scope, datasetId: inventory.datasetId,
    inventoryHash: seededInventory.hash, policyVersion: DIETARY_POLICY_VERSION, part: 1, partCount: 1,
    catalogueHash: reviewCatalogueHash([seededObservation]), nominationsHash: null,
    connections: [{ ingredientId: ingredientId(requirement[0].name), name: requirement[0].name, sourceFoodId: null,
      status: 'matched', approvedProductIds: [seededObservation.product.id],
      reason: 'Reviewed the current Coop product against the ingredient and prior same-name-and-brand identity.' }] };
  const [connection] = expandCompactReviewDecisions(seededInventory, [seededObservation], [batch], [decisions],
    'ica', scope, now, undefined, { [requirement[0].name]: assessment });
  assert.equal(connection.status, 'matched');
  assert.equal(connection.approvedProducts[0].identity, productIdentity(seededObservation.product));
});

test('manual nominations are scoped to the source scan and cannot bypass policy or eligibility', () => {
  const requirement = [{ name: 'mystery dry spice', occurrences: 1 }];
  const coopScope = { storeId: 'coop-store-17', channel: 'pickup' as const };
  const nominatedInventory: CloudIngredientInventory = { ...inventory, requirements: requirement,
    hash: createHash('sha256').update(JSON.stringify(requirement)).digest('hex'), ingredientOccurrences: 1,
    distinctIngredients: 1 };
  const product: ProductObservation = { ...observation, retailer: 'coop', scope: coopScope, product: { ...observation.product,
    id: 'spice-2', ean: '7310000000088', name: 'Chinese Five Spice Mix', brand: 'Kockens', categories: ['Skafferi'],
    pack: { quantity: 35, unit: 'g', approximate: false } }, price: { ...observation.price!, basis: 'pack', depositOre: 0 } };
  const nominations: ManualReviewNominations = { schemaVersion: 1, retailer: 'coop', scope: coopScope,
    datasetId: nominatedInventory.datasetId, inventoryHash: nominatedInventory.hash,
    catalogueHash: reviewCatalogueHash([product]), source: 'scoped-coop-reference-scan',
    nominations: [{ name: requirement[0].name, productIds: [product.product.id],
      reason: 'Exact title candidate found in the scope-pinned Coop scan; requires manual ingredient review.' }] };
  assert.throws(() => mergeManualReviewNominations([nominations, nominations]), /manual_nomination_name_repeated/);
  const [batch] = compactReviewBatches(nominatedInventory, [product], 'coop', coopScope, 1, now, undefined, {}, nominations);
  const candidate = batch.items[0].candidates[0];
  assert.equal(candidate.proposalSource, 'manual_nomination');
  assert.equal(candidate.nominationReason, nominations.nominations[0].reason);
  assert.equal(candidate.matcherEligible, true);
  const decision: CompactReviewDecisionSet = { retailer: 'coop', scope: coopScope, datasetId: nominatedInventory.datasetId,
    inventoryHash: nominatedInventory.hash, policyVersion: DIETARY_POLICY_VERSION, part: 1, partCount: 1,
    catalogueHash: reviewCatalogueHash([product]), nominationsHash: manualNominationsHash(nominations),
    connections: [{ ingredientId: ingredientId(requirement[0].name), name: requirement[0].name,
      sourceFoodId: null, status: 'matched', approvedProductIds: [product.product.id],
      reason: 'Manual exact-food review of the nominated Coop product.' }] };
  const [connection] = expandCompactReviewDecisions(nominatedInventory, [product], [batch], [decision],
    'coop', coopScope, now, undefined, {}, nominations);
  assert.equal(connection.approvedProducts[0].identity, productIdentity(product.product));
  assert.throws(() => compactReviewBatches(nominatedInventory, [product], 'coop', coopScope, 1, now, undefined, {}, {
    ...nominations, catalogueHash: 'b'.repeat(64),
  }), /manual_nomination_snapshot_mismatch/);
  assert.throws(() => compactReviewBatches(nominatedInventory, [product], 'coop', coopScope, 1, now, undefined, {}, {
    ...nominations, nominations: [{ ...nominations.nominations[0], productIds: ['not-in-scan'] }],
  }), /manual_nomination_product_not_in_scan/);

  const chicken = [{ name: 'chicken breast', occurrences: 1 }];
  const chickenInventory: CloudIngredientInventory = { ...nominatedInventory, requirements: chicken,
    hash: createHash('sha256').update(JSON.stringify(chicken)).digest('hex') };
  const pork: ProductObservation = { ...product, product: { ...product.product, id: 'pork-1', name: 'Pork fillet',
    brand: 'Affco' } };
  const disallowed: ManualReviewNominations = { ...nominations, inventoryHash: chickenInventory.hash,
    catalogueHash: reviewCatalogueHash([pork]), nominations: [{ name: chicken[0].name,
      productIds: [pork.product.id], reason: 'Candidate.' }] };
  assert.throws(() => compactReviewBatches(chickenInventory, [pork], 'coop', coopScope, 1, now, undefined, {}, disallowed),
    /manual_nomination_product_policy_excluded/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoopRecipeEngine } from '../src/recipe-coop-engine.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import { productIdentity } from '../src/retailers/identity.ts';
import type { ReviewedConnection } from '../src/retailers/identity.ts';
import type { ParsedLine } from '../src/recipe-ingredient-engine.ts';
import type { ProductObservation, RetailProduct } from '../src/retailers/types.ts';

const scope = { storeId: 'store1', channel: 'pickup' as const };
type TestLiveProduct = { retailer: 'coop'; productId: string; productIdentity: string; status: string;
  checkedAt?: string; nutritionSource?: RetailProduct['nutritionSource'] | null; observation?: ProductObservation };
function fixture(options: { ingredient?: string; productName?: string; brand?: string | null;
  liveStatus?: string; liveIdentity?: string; sku?: string; foodId?: string | null } = {}) {
  const ingredient = options.ingredient ?? 'tomato';
  const sku = options.sku ?? 'sku1';
  const product: RetailProduct = { id: sku, ean: sku, name: options.productName ?? 'Tomato',
    brand: options.brand ?? null, categories: ['fresh'], pack: { quantity: 500, unit: 'g', approximate: false },
    ingredientsText: null };
  const observation: ProductObservation = { retailer: 'coop', scope, product, price: { amountOre: 1000,
    basis: 'pack', depositOre: null, memberOnly: false, minimumQuantity: null, validFrom: null, validUntil: null },
    availability: 'available', checkedAt: '2026-10-09T08:00:00Z', expiresAt: '2026-10-10T08:00:00Z', storeScopeVerified: true };
  const identity = productIdentity(product);
  const dataset = { retailer: 'coop' as const, datasetId: 'a'.repeat(64), inventoryHash: 'b'.repeat(64), scope,
    observations: [observation], connections: [{ ingredientId: 'ing_1', name: ingredient,
      foodId: Object.hasOwn(options, 'foodId') ? options.foodId! : 'tomato',
      status: 'matched' as const, mainProductId: sku, approvedProducts: [{ productId: sku, identity }],
      policyVersion: DIETARY_POLICY_VERSION, reviewedAt: '2026-10-09T08:00:00Z', reason: 'reviewed' }] };
  const sourceCollection: { schemaVersion: 1; retailer: 'coop'; mode: 'live'; datasetId: string; inventoryHash: string;
    scope: typeof scope; products: TestLiveProduct[] } = { schemaVersion: 1 as const, retailer: 'coop' as const, mode: 'live' as const,
    datasetId: dataset.datasetId, inventoryHash: dataset.inventoryHash, scope,
    products: [{ retailer: 'coop' as const, productId: sku,
      productIdentity: options.liveIdentity ?? identity, status: options.liveStatus ?? 'collected' }] };
  return { engine: createCoopRecipeEngine(dataset, sourceCollection, Date.parse('2026-10-13T12:00:00Z')),
    identity, dataset, sourceCollection };
}
function line(overrides: Partial<ParsedLine> = {}): ParsedLine {
  return { raw: '2 tomatoes', name: 'tomato', query: 'tomato', names: ['tomato'], status: 'parsed',
    amount: { quantity: 2, unit: 'piece' }, size: null, preparation: null, ...overrides };
}

test('binds only the exact approved ingredient name and marks historical price ineligible', () => {
  const { engine } = fixture();
  const result = engine.evaluate(line({ name: '  TOMATO  ', query: 'tomato' }));
  assert.equal(result.status, 'matched');
  assert.equal(result.productId, 'sku1');
  assert.equal(result.selectedProduct?.eligible, true);
  assert.equal(result.selectedProduct?.priceEligible, false);
  assert.deepEqual(result.amount, { quantity: 2, unit: 'piece' }); // preserve known source quantity independently of pack basis
  assert.equal(engine.evaluate(line({ amount: { quantity: 200, unit: 'g' } })).status, 'matched');
  assert.equal(engine.evaluate(line({ name: 'tomatoes' })).reason, 'no_exact_approved_coop_name');
  assert.equal(engine.evaluate(line({ query: 'organic tomato', raw: '1 organic tomato' })).reason, 'organic_not_verified');
});

test('rejects wrong SKU, missing products, and changed approved identities', () => {
  const { engine } = fixture({ sku: 'approved-sku' });
  assert.equal(engine.evaluate(line()).productId, 'approved-sku');
  const wrongSku = fixture({ sku: 'approved-sku' });
  wrongSku.sourceCollection.products = [{ retailer: 'coop', productId: 'other-sku', productIdentity: wrongSku.identity, status: 'collected' }];
  assert.equal(createCoopRecipeEngine(wrongSku.dataset, wrongSku.sourceCollection, Date.now()).evaluate(line()).reason,
    'approved_product_missing_from_live_collection');
  const changed = fixture({ liveIdentity: 'changed' });
  assert.equal(changed.engine.evaluate(line()).reason, 'approved_product_identity_changed');
  const missing = fixture({ liveStatus: 'product_missing' });
  assert.equal(missing.engine.evaluate(line()).reason, 'approved_product_missing_from_live_collection');
});

test('rejects a foreign retailer and enforces current pork and brand policy', () => {
  const base = fixture();
  assert.throws(() => createCoopRecipeEngine(base.dataset,
    { ...base.sourceCollection, retailer: 'ica' } as never, Date.now()), /invalid_coop_recipe_snapshots/);
  const pork = fixture({ ingredient: 'pork chop', productName: 'Pork chops', brand: null });
  const porkResult = pork.engine.evaluate(line({ name: 'pork chop', query: 'pork chop', raw: '1 pork chop' }));
  assert.equal(porkResult.status, 'excluded');
  assert.equal(porkResult.reason, 'pork');
  const chicken = fixture({ ingredient: 'chicken', productName: 'Kycklingfilé', brand: 'Unapproved Brand' });
  const chickenResult = chicken.engine.evaluate(line({ name: 'chicken', query: 'chicken', raw: '200 g chicken' }));
  assert.equal(chickenResult.status, 'needs_review');
  assert.equal(chickenResult.reason, 'meat_brand_not_permitted');
});

test('uses an attached current observation only when it is current for the evaluation time', () => {
  const current = fixture();
  const historical = current.dataset.observations[0];
  const observation = { ...historical, checkedAt: '2026-10-13T10:00:00Z', expiresAt: '2026-10-18T22:00:00Z' };
  Object.assign(current.sourceCollection.products[0], { observation, checkedAt: observation.checkedAt });
  const now = Date.parse('2026-10-13T12:00:00Z');
  const fresh = createCoopRecipeEngine(current.dataset, current.sourceCollection, now).evaluate(
    line({ amount: { quantity: 200, unit: 'g' } }));
  assert.equal(fresh.status, 'matched');
  assert.equal(fresh.selectedProduct?.priceEligible, true);
  assert.equal(fresh.selectedProduct?.price?.amountOre, 1000);
  assert.deepEqual(fresh.selectedProduct?.priceAmount, { quantity: 200, unit: 'g' });

  const stale = createCoopRecipeEngine(current.dataset, current.sourceCollection,
    Date.parse('2026-10-20T12:00:00Z')).evaluate(line({ amount: { quantity: 200, unit: 'g' } }));
  assert.equal(stale.status, 'matched');
  assert.equal(stale.selectedProduct?.eligible, true);
  assert.equal(stale.selectedProduct?.priceEligible, false);
  assert.equal(stale.selectedProduct?.priceAmount, null);
});

test('keeps source package quantities unresolved without inventing a serving conversion', () => {
  const { engine } = fixture();
  const result = engine.evaluate(line({ raw: '2 packs tomato', sourceAmount: { quantity: 2, unit: 'pack' },
    amount: { quantity: 2, unit: 'pack' } }));
  assert.equal(result.status, 'amount_unresolved');
  assert.equal(result.amount, null);
});

test('keeps a known source measurement while withholding incompatible package-price quantity', () => {
  const setup = fixture();
  const observation = { ...setup.dataset.observations[0], checkedAt: '2026-10-13T10:00:00Z', expiresAt: '2026-10-18T22:00:00Z' };
  Object.assign(setup.sourceCollection.products[0], { observation, checkedAt: observation.checkedAt });
  const result = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'))
    .evaluate(line({ raw: '100 ml tomato', amount: { quantity: 100, unit: 'ml' } }));
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.amount, { quantity: 100, unit: 'ml' });
  assert.equal(result.selectedProduct?.priceEligible, true);
  assert.equal(result.selectedProduct?.priceAmount, null);
});

test('uses a reviewed reserve only when the primary is missing and keeps its reviewed query', () => {
  const setup = fixture({ sku: 'primary' });
  const primary = setup.dataset.observations[0];
  const reserveProduct: RetailProduct = { ...primary.product, id: 'reserve', ean: 'reserve', name: 'Tomato Reserve' };
  const reserveIdentity = productIdentity(reserveProduct);
  setup.dataset.observations.push({ ...primary, product: reserveProduct });
  setup.dataset.connections[0].approvedProducts.push({ productId: 'reserve', identity: reserveIdentity });
  setup.sourceCollection.products[0].status = 'product_missing';
  setup.sourceCollection.products.push(Object.assign({ retailer: 'coop' as const, productId: 'reserve',
    productIdentity: reserveIdentity, status: 'collected' }, { observation: { ...primary, product: reserveProduct,
    checkedAt: '2026-10-13T10:00:00Z', expiresAt: '2026-10-18T22:00:00Z' }, checkedAt: '2026-10-13T10:00:00Z' }));
  const engine = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'));
  const result = engine.evaluate(line({ amount: { quantity: 200, unit: 'g' } }));
  assert.equal(result.productId, 'reserve');
  assert.equal(result.selectedProduct?.id, 'reserve');
  assert.equal(result.selectedProduct?.reviewedQuery, 'tomato');
  assert.equal(result.selectedProduct?.priceEligible, true);
});

test('does not fallback after a changed primary and allows low-confidence exact source only', () => {
  const changed = fixture({ sku: 'primary', liveStatus: 'product_identity_changed' });
  const primary = changed.dataset.observations[0];
  const reserveProduct: RetailProduct = { ...primary.product, id: 'reserve', ean: 'reserve' };
  const reserveIdentity = productIdentity(reserveProduct);
  changed.dataset.observations.push({ ...primary, product: reserveProduct });
  changed.dataset.connections[0].approvedProducts.push({ productId: 'reserve', identity: reserveIdentity });
  changed.sourceCollection.products.push({ retailer: 'coop', productId: 'reserve', productIdentity: reserveIdentity, status: 'collected' });
  assert.equal(createCoopRecipeEngine(changed.dataset, changed.sourceCollection, Date.now()).evaluate(line()).reason,
    'approved_product_identity_changed');

  const exact = fixture();
  const exactResult = exact.engine.evaluate(line({ raw: '2 tomato', selectionSource: '2 tomato', status: 'needs_review' }));
  assert.equal(exactResult.status, 'matched');
  const modified = exact.engine.evaluate(line({ raw: '2 fresh tomato', selectionSource: '2 fresh tomato', status: 'needs_review' }));
  assert.equal(modified.status, 'needs_review');
  assert.equal(modified.reason, 'low_confidence_source_not_exact');
});

test('shares Coop bindings only with eligible exact-food Willys identity evidence', () => {
  const setup = fixture();
  const verified = { status: 'matched', foodId: 'tomato', selectedCode: 'willys-tomato',
    selectedProduct: { eligible: true, name: 'Tomatoes', brand: null }, query: 'tomato', name: 'Tomatoes' };
  const alias = setup.engine.evaluate(line({ raw: '2 Roma tomatoes', name: 'Roma tomatoes', query: 'tomato' }), verified);
  assert.equal(alias.status, 'matched');
  assert.equal(alias.method, 'approved_coop_shared_food_id');
  assert.equal(alias.productId, 'sku1');
  assert.equal(alias.identityEvidence?.selectedCode, 'willys-tomato');
  assert.equal(alias.identityEvidence?.canonicalQuery, 'tomato');
  assert.equal(alias.identityEvidence?.foodId, 'tomato');

  const withoutEvidence = setup.engine.evaluate(line({ name: 'Roma tomatoes', query: 'tomato' }));
  assert.equal(withoutEvidence.reason, 'no_exact_approved_coop_name');
  assert.equal(setup.engine.evaluate(line({ name: 'Roma tomatoes', query: 'tomato' }),
    { ...verified, status: 'needs_review' }).reason, 'no_exact_approved_coop_name');
  assert.equal(setup.engine.evaluate(line({ name: 'Roma tomatoes', query: 'tomato' }),
    { ...verified, selectedProduct: { eligible: false } }).reason, 'no_exact_approved_coop_name');

  const exactWins = setup.engine.evaluate(line(), { ...verified, foodId: 'different-food' });
  assert.equal(exactWins.method, 'approved_coop_exact_name');
  assert.equal(exactWins.identityEvidence, null);
});

test('retries a pending exact Coop name only through its reviewed canonical food identity', () => {
  const setup = fixture({ ingredient: 'black pepper', productName: 'Svartpeppar Malen', brand: 'Coop', foodId: 'pepper-black' });
  const connections = setup.dataset.connections as ReviewedConnection[];
  const pending = connections[0];
  connections[0] = { ...pending, status: 'needs_review', mainProductId: null, approvedProducts: [],
    reason: 'Generic black pepper has no exact reviewed product name' };
  connections.push({ ...pending, ingredientId: 'ground-pepper', name: 'ground black pepper',
    status: 'matched', mainProductId: 'sku1', approvedProducts: [{ productId: 'sku1', identity: setup.identity }],
    reason: 'Reviewed ground black pepper product' });
  const engine = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'));
  const source = line({ raw: '1 tsp black pepper', name: 'black pepper', query: 'black pepper',
    amount: { quantity: 2, unit: 'g' }, sourceAmount: { quantity: 1, unit: 'tsp' } });
  const canonical = { status: 'matched', foodId: 'pepper-black', selectedCode: 'willys-black-pepper',
    selectedProduct: { eligible: true, name: 'Black Pepper', brand: null }, query: 'black pepper', name: 'black pepper' };
  const result = engine.evaluate(source, canonical);
  assert.equal(result.status, 'matched');
  assert.equal(result.method, 'approved_coop_shared_food_id');
  assert.equal(result.productId, 'sku1');
  assert.equal(result.foodId, 'pepper-black');
  assert.equal(result.selectedProduct?.priceEligible, false); // historical price stays ineligible
  assert.deepEqual(result.sourcePendingEvidence, { ingredientId: 'ing_1', sourceName: 'black pepper',
    reason: 'Generic black pepper has no exact reviewed product name' });
  assert.equal(engine.evaluate(source).reason, 'pending_coop_name_requires_verified_canonical_identity');
  assert.equal(engine.evaluate(source, { ...canonical, status: 'amount_unresolved' }).status, 'matched');

  const wrongFood = engine.evaluate(source, { ...canonical, foodId: 'pepper-white' });
  assert.equal(wrongFood.status, 'needs_review');
  assert.equal(wrongFood.reason, 'pending_coop_canonical_food_id_mismatch');
  assert.equal(wrongFood.productId, null);
  assert.equal(engine.evaluate(source, { ...canonical, selectedProduct: { eligible: false } }).reason,
    'pending_coop_name_requires_verified_canonical_identity');
});

test('pending-name retry cannot bypass excluded sources, form checks, or unavailable approved products', () => {
  const makePending = (ingredient: string, foodId: string, productName: string, approvedName: string, brand = 'Coop') => {
    const setup = fixture({ ingredient, productName, brand, foodId });
    const connections = setup.dataset.connections as ReviewedConnection[];
    const pending = connections[0];
    connections[0] = { ...pending, status: 'needs_review', mainProductId: null, approvedProducts: [],
      reason: 'Pending review' };
    connections.push({ ...pending, ingredientId: `approved-${foodId}`, name: approvedName,
      status: 'matched', mainProductId: 'sku1', approvedProducts: [{ productId: 'sku1', identity: setup.identity }],
      reason: 'Reviewed product' });
    return { setup, engine: createCoopRecipeEngine(setup.dataset, setup.sourceCollection,
      Date.parse('2026-10-13T12:00:00Z')) };
  };
  const verified = (foodId: string, query: string) => ({ status: 'matched', foodId, selectedCode: `willys-${foodId}`,
    selectedProduct: { eligible: true, name: query, brand: null }, query, name: query });

  const pepper = makePending('black pepper', 'pepper-black', 'Svartpeppar Malen', 'ground black pepper');
  const fresh = pepper.engine.evaluate(line({ raw: '1 tsp fresh black pepper', name: 'black pepper', query: 'black pepper',
    amount: { quantity: 2, unit: 'g' } }), verified('pepper-black', 'black pepper'));
  assert.equal(fresh.status, 'needs_review');
  assert.equal(fresh.reason, 'product_form_incompatible');
  assert.equal(fresh.productId, null);

  const wholePeppercorns = makePending('whole black peppercorns', 'peppercorns', 'Svartpeppar Malen', 'ground black pepper');
  const whole = wholePeppercorns.engine.evaluate(line({ raw: '1 tsp whole black peppercorns',
    name: 'whole black peppercorns', query: 'whole black peppercorns', amount: { quantity: 2, unit: 'g' } }),
  verified('peppercorns', 'whole black peppercorns'));
  assert.equal(whole.status, 'needs_review');
  assert.equal(whole.productId, null);

  const chicken = makePending('chicken', 'chicken', 'Kycklingfilé', 'chicken', 'Eldorado');
  const cooked = chicken.engine.evaluate(line({ raw: '200 g cooked chicken', name: 'cooked chicken', query: 'chicken',
    amount: { quantity: 200, unit: 'g' } }), verified('chicken', 'chicken'));
  assert.equal(cooked.status, 'needs_review');
  assert.equal(cooked.reason, 'cooked_form_not_verified');
  assert.equal(cooked.productId, null);

  const unavailable = makePending('black pepper', 'pepper-black', 'Svartpeppar Malen', 'ground black pepper');
  unavailable.setup.sourceCollection.products[0].status = 'product_missing';
  const unavailableEngine = createCoopRecipeEngine(unavailable.setup.dataset, unavailable.setup.sourceCollection,
    Date.parse('2026-10-13T12:00:00Z'));
  const noSku = unavailableEngine.evaluate(line({ raw: '1 tsp black pepper', name: 'black pepper', query: 'black pepper' }),
    verified('pepper-black', 'black pepper'));
  assert.equal(noSku.status, 'needs_review');
  assert.equal(noSku.productId, null);
  assert.equal(noSku.selectedProduct, null);

  const excluded = pepper.engine.evaluate(line({ raw: '1 tsp alcohol', name: 'alcohol', query: 'alcohol' }),
    verified('alcohol', 'alcohol'));
  assert.equal(excluded.status, 'excluded');
  assert.equal(excluded.productId, null);
});

test('keeps an exact approved SKU when its reviewed food ID is explicitly null', () => {
  const setup = fixture({ foodId: null });
  const result = setup.engine.evaluate(line({ amount: { quantity: 100, unit: 'g' } }));
  assert.equal(result.status, 'matched');
  assert.equal(result.productId, 'sku1');
  assert.equal(result.foodId, null);
  assert.equal(result.selectedProduct?.eligible, true);
  assert.equal(result.identityEvidence, null);
});

test('rejects conflicting duplicate SKU records in either snapshot', () => {
  const liveConflict = fixture();
  liveConflict.sourceCollection.products.push({ ...liveConflict.sourceCollection.products[0], productIdentity: 'different' });
  assert.throws(() => createCoopRecipeEngine(liveConflict.dataset, liveConflict.sourceCollection, Date.now()),
    /conflicting_duplicate_coop_live_product/);

  const observationConflict = fixture();
  observationConflict.dataset.observations.push({ ...observationConflict.dataset.observations[0],
    product: { ...observationConflict.dataset.observations[0].product, name: 'Different tomato identity' } });
  assert.throws(() => createCoopRecipeEngine(observationConflict.dataset, observationConflict.sourceCollection, Date.now()),
    /conflicting_duplicate_coop_observation/);
});

test('rechecks cooked meat and reduced-fat modifiers on shared-food-ID aliases', () => {
  const chicken = fixture({ ingredient: 'chicken', productName: 'Kycklingfilé', brand: 'Eldorado', foodId: 'chicken' });
  const identity = { status: 'matched', foodId: 'chicken', selectedCode: 'willys-chicken',
    selectedProduct: { eligible: true }, query: 'chicken', name: 'chicken' };
  const cooked = chicken.engine.evaluate(line({ raw: '200 g cooked chicken', name: 'cooked chicken', query: 'chicken',
    amount: { quantity: 200, unit: 'g' } }), identity);
  assert.equal(cooked.status, 'needs_review');
  assert.equal(cooked.reason, 'cooked_form_not_verified');

  const yogurt = fixture({ ingredient: 'yogurt', productName: 'Yoghurt Naturell 3%', brand: 'Coop', foodId: 'yogurt' });
  const yogurtIdentity = { status: 'matched', foodId: 'yogurt', selectedCode: 'willys-yogurt',
    selectedProduct: { eligible: true }, query: 'yogurt', name: 'yogurt' };
  const lowFat = yogurt.engine.evaluate(line({ raw: '100 g fat-free yogurt', name: 'fat-free yogurt', query: 'yogurt',
    amount: { quantity: 100, unit: 'g' } }), yogurtIdentity);
  assert.equal(lowFat.status, 'needs_review');
  assert.equal(lowFat.reason, 'fat_free_not_verified');
});

test('prefers a same-food-ID reviewed reserve with a matching complete-core nutrition capability', () => {
  const setup = fixture({ ingredient: 'butter', productName: 'Salted Butter', brand: 'Coop', foodId: 'butter_food' });
  const primary = setup.dataset.observations[0];
  const alternativeProduct: RetailProduct = { ...primary.product, id: 'complete-butter', ean: 'complete-butter',
    name: 'Osaltat Smör', brand: 'Coop' };
  const alternativeIdentity = productIdentity(alternativeProduct);
  setup.dataset.observations.push({ ...primary, product: alternativeProduct });
  setup.dataset.connections.push({ ...setup.dataset.connections[0], ingredientId: 'ing_2', name: 'unsalted butter',
    mainProductId: alternativeProduct.id, approvedProducts: [{ productId: alternativeProduct.id, identity: alternativeIdentity }] });
  const primaryNutrition = { schemaVersion: 1, retailer: 'coop', productId: 'sku1', contentHash: 'primary-hash', sourcePayload: {} };
  const alternativeNutrition = { schemaVersion: 1, retailer: 'coop', productId: alternativeProduct.id,
    contentHash: 'complete-hash', sourcePayload: {} };
  setup.sourceCollection.products[0].nutritionSource = primaryNutrition as never;
  setup.sourceCollection.products[0].checkedAt = '2026-10-13T10:00:00Z';
  setup.sourceCollection.products.push({ retailer: 'coop', productId: alternativeProduct.id, productIdentity: alternativeIdentity,
    status: 'collected', checkedAt: '2026-10-13T10:00:00Z', nutritionSource: alternativeNutrition as never });
  const capabilities = {
    sku1: { contentHash: 'primary-hash', coreComplete: false },
    'complete-butter': { contentHash: 'complete-hash', coreComplete: true },
  };
  const preferred = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'),
    { preferCompleteNutrition: true, nutritionCapabilities: capabilities }).evaluate(line({
      raw: '200 g butter', name: 'butter', query: 'butter', amount: { quantity: 200, unit: 'g' },
    }));
  assert.equal(preferred.productId, 'complete-butter');
  assert.equal(preferred.selectedProduct?.reviewedQuery, 'butter');
  assert.deepEqual(preferred.selectionEvidence?.reasons,
    ['nutrition_complete_preference', 'approved_same_food_id_connection']);
  assert.equal(preferred.selectionEvidence?.approvedConnectionName, 'unsalted butter');
  assert.equal(preferred.selectionEvidence?.foodId, 'butter_food');
  assert.equal(preferred.selectionEvidence?.nutritionContentHash, 'complete-hash');
  assert.equal(preferred.selectedProduct?.priceEligible, false);

  const defaultOrder = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'),
    { nutritionCapabilities: capabilities }).evaluate(line({ raw: '200 g butter', name: 'butter', query: 'butter',
      amount: { quantity: 200, unit: 'g' } }));
  assert.equal(defaultOrder.productId, 'sku1');
});

test('requires a matching nutrition content hash and preserves modifier and brand policy across reserve candidates', () => {
  const setup = fixture({ ingredient: 'butter', productName: 'Salted Butter', brand: 'Coop', foodId: 'butter_food' });
  const primary = setup.dataset.observations[0];
  const alternativeProduct: RetailProduct = { ...primary.product, id: 'other-butter', ean: 'other-butter',
    name: 'Salted Butter Reserve', brand: 'Coop' };
  const alternativeIdentity = productIdentity(alternativeProduct);
  setup.dataset.observations.push({ ...primary, product: alternativeProduct });
  setup.dataset.connections.push({ ...setup.dataset.connections[0], ingredientId: 'ing_2', name: 'butter reserve',
    mainProductId: alternativeProduct.id, approvedProducts: [{ productId: alternativeProduct.id, identity: alternativeIdentity }] });
  const currentSource = { schemaVersion: 1, retailer: 'coop', productId: alternativeProduct.id,
    contentHash: 'observed-hash', sourcePayload: {} };
  setup.sourceCollection.products.push({ retailer: 'coop', productId: alternativeProduct.id, productIdentity: alternativeIdentity,
    status: 'collected', nutritionSource: currentSource as never });
  const invalidHash = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.now(), {
    preferCompleteNutrition: true,
    nutritionCapabilities: { 'other-butter': { contentHash: 'different-hash', coreComplete: true } },
  }).evaluate(line({ raw: '100 g butter', name: 'butter', query: 'butter', amount: { quantity: 100, unit: 'g' } }));
  assert.equal(invalidHash.productId, 'sku1');
  assert.equal(invalidHash.selectionEvidence?.nutritionCoreComplete, false);

  const unverifiedTime = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'), {
    preferCompleteNutrition: true,
    nutritionCapabilities: { 'other-butter': { contentHash: 'observed-hash', coreComplete: true } },
  }).evaluate(line({ raw: '100 g butter', name: 'butter', query: 'butter', amount: { quantity: 100, unit: 'g' } }));
  assert.equal(unverifiedTime.productId, 'sku1');
  assert.equal(unverifiedTime.selectionEvidence?.nutritionCoreComplete, false);

  const unsalted = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.now(), {
    preferCompleteNutrition: true,
    nutritionCapabilities: { 'other-butter': { contentHash: 'observed-hash', coreComplete: true } },
  }).evaluate(line({ raw: '100 g unsalted butter', name: 'butter', query: 'butter',
    amount: { quantity: 100, unit: 'g' } }));
  assert.notEqual(unsalted.productId, 'other-butter');

  const chicken = fixture({ ingredient: 'chicken', productName: 'Kycklingfilé', brand: 'Eldorado', foodId: 'chicken_food' });
  const chickenMain = chicken.dataset.observations[0];
  const unapprovedBrand: RetailProduct = { ...chickenMain.product, id: 'brand-chicken', ean: 'brand-chicken', brand: 'Unknown Label' };
  const brandIdentity = productIdentity(unapprovedBrand);
  chicken.dataset.observations.push({ ...chickenMain, product: unapprovedBrand });
  chicken.dataset.connections.push({ ...chicken.dataset.connections[0], ingredientId: 'ing_3', name: 'chicken reserve',
    mainProductId: unapprovedBrand.id, approvedProducts: [{ productId: unapprovedBrand.id, identity: brandIdentity }] });
  chicken.sourceCollection.products[0].nutritionSource = { schemaVersion: 1, retailer: 'coop', productId: 'sku1',
    contentHash: 'incomplete', sourcePayload: {} } as never;
  chicken.sourceCollection.products[0].checkedAt = '2026-10-13T10:00:00Z';
  chicken.sourceCollection.products.push({ retailer: 'coop', productId: unapprovedBrand.id, productIdentity: brandIdentity,
    status: 'collected', checkedAt: '2026-10-13T10:00:00Z', nutritionSource: { schemaVersion: 1, retailer: 'coop', productId: unapprovedBrand.id,
      contentHash: 'complete', sourcePayload: {} } as never });
  const brandBlocked = createCoopRecipeEngine(chicken.dataset, chicken.sourceCollection, Date.now(), {
    preferCompleteNutrition: true,
    nutritionCapabilities: { 'brand-chicken': { contentHash: 'complete', coreComplete: true } },
  }).evaluate(line({ raw: '200 g chicken', name: 'chicken', query: 'chicken', amount: { quantity: 200, unit: 'g' } }));
  assert.equal(brandBlocked.productId, 'sku1');
});

test('does not expand to a different or explicitly null food identity', () => {
  const setup = fixture({ ingredient: 'butter', productName: 'Salted Butter', brand: 'Coop', foodId: null });
  const primary = setup.dataset.observations[0];
  const otherProduct: RetailProduct = { ...primary.product, id: 'other-food', ean: 'other-food', name: 'Margarine' };
  const otherIdentity = productIdentity(otherProduct);
  setup.dataset.observations.push({ ...primary, product: otherProduct });
  setup.dataset.connections.push({ ...setup.dataset.connections[0], ingredientId: 'ing_2', name: 'margarine', foodId: 'margarine_food',
    mainProductId: otherProduct.id, approvedProducts: [{ productId: otherProduct.id, identity: otherIdentity }] });
  setup.sourceCollection.products.push({ retailer: 'coop', productId: otherProduct.id, productIdentity: otherIdentity,
    status: 'collected', nutritionSource: { schemaVersion: 1, retailer: 'coop', productId: otherProduct.id,
      contentHash: 'complete', sourcePayload: {} } as never });
  const result = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.now(), {
    preferCompleteNutrition: true, nutritionCapabilities: { 'other-food': { contentHash: 'complete', coreComplete: true } },
  }).evaluate(line({ name: 'butter', query: 'butter' }));
  assert.equal(result.productId, 'sku1');
  assert.equal(result.foodId, null);
});

test('recognizes only explicit plain water as non-purchased and preserves its measured quantity', () => {
  const { engine } = fixture();
  const tapWater = engine.evaluate(line({ raw: '2 cups tap water', name: 'tap water', query: 'tap water',
    amount: { quantity: 480, unit: 'ml' } }));
  assert.equal(tapWater.status, 'non_purchased');
  assert.equal(tapWater.method, 'plain_water_non_purchased');
  assert.equal(tapWater.foodId, 'water');
  assert.equal(tapWater.productId, null);
  assert.equal(tapWater.selectedProduct, null);
  assert.deepEqual(tapWater.amount, { quantity: 480, unit: 'ml' });
  assert.equal(tapWater.reason, 'plain_water_non_purchased_no_retail_sku_or_cost');

  const cupAbbreviation = engine.evaluate(line({ raw: '1 c. water', name: 'water', query: 'water',
    amount: { quantity: 236.5882365, unit: 'ml' } }));
  assert.equal(cupAbbreviation.status, 'non_purchased');
  assert.deepEqual(cupAbbreviation.amount, { quantity: 236.5882365, unit: 'ml' });
  const boilingCup = engine.evaluate(line({ raw: '2 c. boiling water', name: 'boiling water', query: 'boiling water',
    amount: { quantity: 473.176473, unit: 'ml' } }));
  assert.equal(boilingCup.status, 'non_purchased');
  assert.deepEqual(boilingCup.amount, { quantity: 473.176473, unit: 'ml' });

  const unknownAmount = engine.evaluate(line({ raw: 'water', name: 'water', query: 'water', amount: null }));
  assert.equal(unknownAmount.status, 'non_purchased');
  assert.equal(unknownAmount.foodId, 'water');
  assert.equal(unknownAmount.amount, null);

  for (const phrase of ['water to cover', 'water as needed', 'water for boiling',
    'hot water to cover', 'cold water as needed', 'boiling water for boiling', 'tap water to cover']) {
    const qualitative = engine.evaluate(line({ raw: phrase, name: 'water', query: 'water', amount: null }));
    assert.equal(qualitative.status, 'non_purchased', phrase);
    assert.equal(qualitative.foodId, 'water', phrase);
    assert.equal(qualitative.amount, null, phrase);
    assert.equal(qualitative.method, 'plain_water_non_purchased', phrase);
  }

  for (const phrase of ['mineral water', 'sparkling water', 'flavored water', 'salted water', 'spring water',
    'coconut water', 'vegetable stock', 'chicken broth']) {
    const result = engine.evaluate(line({ raw: `1 cup ${phrase}`, name: phrase, query: phrase,
      amount: { quantity: 240, unit: 'ml' } }));
    assert.notEqual(result.status, 'non_purchased', phrase);
    assert.equal(result.productId, null, phrase);
  }
  const embellishedSource = engine.evaluate(line({ raw: '1 cup lemon water', name: 'water', query: 'water',
    amount: { quantity: 240, unit: 'ml' } }));
  assert.notEqual(embellishedSource.status, 'non_purchased');
  const embellishedAbbreviation = engine.evaluate(line({ raw: '1 c. lemon water', name: 'water', query: 'water',
    amount: { quantity: 236.5882365, unit: 'ml' } }));
  assert.notEqual(embellishedAbbreviation.status, 'non_purchased');

  const corruptQuantity = engine.evaluate(line({ raw: '1/0 cup water', name: 'water', query: 'water', amount: null }));
  assert.notEqual(corruptQuantity.status, 'non_purchased');
});

test('uses an exact reviewed raw-source modifier binding without broadening generic ingredient names', () => {
  const setup = fixture({ ingredient: 'black pepper', productName: 'Black Pepper', brand: 'Coop', foodId: 'pepper-black' });
  const connections = setup.dataset.connections as ReviewedConnection[];
  connections[0] = { ...connections[0], status: 'needs_review', mainProductId: null, approvedProducts: [],
    reason: 'Generic black pepper source name remains ambiguous' };

  const addBinding = (name: string, id: string, displayName: string, foodId: string) => {
    const product: RetailProduct = { ...setup.dataset.observations[0].product, id, ean: id, name: displayName };
    const identity = productIdentity(product);
    setup.dataset.observations.push({ ...setup.dataset.observations[0], product });
    connections.push({ ...connections[0], ingredientId: id, name, foodId, status: 'matched',
      mainProductId: id, approvedProducts: [{ productId: id, identity }], reason: 'exact reviewed name' });
    setup.sourceCollection.products.push({ retailer: 'coop', productId: id, productIdentity: identity, status: 'collected' });
  };
  addBinding('ground black pepper', 'ground-pepper', 'Svartpeppar Malen', 'pepper-black');
  addBinding('whole black peppercorns', 'whole-peppercorns', 'Svartpeppar Hel', 'peppercorns');

  const engine = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'));
  const ground = engine.evaluate(line({ raw: '1 tsp ground black pepper', name: 'black pepper', query: 'black pepper',
    amount: { quantity: 2, unit: 'g' }, sourceAmount: { quantity: 1, unit: 'tsp' } }));
  assert.equal(ground.status, 'matched');
  assert.equal(ground.productId, 'ground-pepper');
  assert.equal(ground.sourceExactReviewedQuery, 'ground black pepper');
  assert.equal(ground.selectedProduct?.reviewedQuery, 'ground black pepper');
  assert.equal(ground.selectedProduct?.priceEligible, false);

  const generic = engine.evaluate(line({ raw: '1 tsp black pepper', name: 'black pepper', query: 'black pepper' }));
  assert.equal(generic.productId, null);
  assert.equal(generic.reason, 'pending_coop_name_requires_verified_canonical_identity');
  assert.equal(generic.sourceExactReviewedQuery, null);

  const whole = engine.evaluate(line({ raw: '1 tsp whole black peppercorns', name: 'whole black peppercorns',
    query: 'whole black peppercorns', amount: { quantity: 2, unit: 'g' } }));
  assert.equal(whole.productId, 'whole-peppercorns');
  assert.equal(whole.sourceExactReviewedQuery, null);
});

test('does not let embellished or rejected source wording fall through to another approved connection', () => {
  const setup = fixture({ ingredient: 'pepper', productName: 'Black Pepper', brand: 'Coop', foodId: 'pepper-black' });
  const connections = setup.dataset.connections as ReviewedConnection[];
  const alternate = fixture({ ingredient: 'black pepper', productName: 'Black Pepper', brand: 'Coop', foodId: 'pepper-black' });
  const alternateConnections = alternate.dataset.connections as ReviewedConnection[];
  alternateConnections[0] = { ...alternateConnections[0], status: 'needs_review', mainProductId: null, approvedProducts: [],
    reason: 'Generic black pepper source name remains ambiguous' };
  const primary = connections[0];
  const reviewedRejectedName: ReviewedConnection = { ...primary, ingredientId: 'cracked', name: 'cracked black pepper',
    status: 'needs_review', mainProductId: null, approvedProducts: [], reason: 'This source wording is not approved' };
  connections.push(reviewedRejectedName);
  const engine = createCoopRecipeEngine(setup.dataset, setup.sourceCollection, Date.parse('2026-10-13T12:00:00Z'));

  const rejectedSource = engine.evaluate(line({ raw: '1 tsp cracked black pepper', name: 'pepper', query: 'pepper' }));
  assert.equal(rejectedSource.productId, null);
  assert.equal(rejectedSource.reason, 'exact_coop_source_name_is_not_approved');
  assert.equal(rejectedSource.sourceExactReviewedQuery, null);
  const rejectedRetry = engine.evaluate(line({ raw: '1 tsp cracked black pepper', name: 'pepper', query: 'pepper' }),
    { status: 'matched', foodId: 'pepper-black', selectedCode: 'willys-black-pepper',
      selectedProduct: { eligible: true }, query: 'pepper', name: 'pepper' });
  assert.equal(rejectedRetry.productId, null);
  assert.equal(rejectedRetry.reason, 'exact_coop_source_name_is_not_approved');

  const ground: RetailProduct = { ...alternate.dataset.observations[0].product, id: 'ground-pepper', ean: 'ground-pepper',
    name: 'Svartpeppar Malen' };
  const groundIdentity = productIdentity(ground);
  alternate.dataset.observations.push({ ...alternate.dataset.observations[0], product: ground });
  alternateConnections.push({ ...alternateConnections[0], ingredientId: 'ground', name: 'ground black pepper', status: 'matched',
    mainProductId: ground.id, approvedProducts: [{ productId: ground.id, identity: groundIdentity },], reason: 'exact reviewed name' });
  alternate.sourceCollection.products.push({ retailer: 'coop', productId: ground.id, productIdentity: groundIdentity, status: 'collected' });
  const alternateEngine = createCoopRecipeEngine(alternate.dataset, alternate.sourceCollection, Date.parse('2026-10-13T12:00:00Z'));
  const embellished = alternateEngine.evaluate(line({ raw: '1 tsp freshly ground black pepper', name: 'black pepper', query: 'black pepper' }));
  assert.equal(embellished.productId, null);
  assert.equal(embellished.reason, 'pending_coop_name_requires_verified_canonical_identity');
});

test('nutrition-complete same-food-ID reserves must preserve fresh versus dried or preserved food form', () => {
  const ginger = fixture({ ingredient: 'ginger', productName: 'Ingefära', brand: 'Coop', foodId: 'ginger-fresh' });
  const gingerPrimary = ginger.dataset.observations[0];
  const powdered: RetailProduct = { ...gingerPrimary.product, id: 'powdered-ginger', ean: 'powdered-ginger', name: 'Ingefära Malen' };
  const powderedIdentity = productIdentity(powdered);
  ginger.dataset.observations.push({ ...gingerPrimary, product: powdered });
  (ginger.dataset.connections as ReviewedConnection[]).push({ ...ginger.dataset.connections[0], ingredientId: 'ginger-powder',
    name: 'powdered ginger', mainProductId: powdered.id, approvedProducts: [{ productId: powdered.id, identity: powderedIdentity }] });
  const complete = { schemaVersion: 1, retailer: 'coop', productId: powdered.id, contentHash: 'complete', sourcePayload: {} };
  ginger.sourceCollection.products[0].nutritionSource = { ...complete, productId: 'sku1', contentHash: 'primary' } as never;
  ginger.sourceCollection.products[0].checkedAt = '2026-10-13T10:00:00Z';
  ginger.sourceCollection.products.push({ retailer: 'coop', productId: powdered.id, productIdentity: powderedIdentity,
    status: 'collected', checkedAt: '2026-10-13T10:00:00Z', nutritionSource: complete as never });
  const gingerResult = createCoopRecipeEngine(ginger.dataset, ginger.sourceCollection, Date.parse('2026-10-13T12:00:00Z'), {
    preferCompleteNutrition: true,
    nutritionCapabilities: { 'powdered-ginger': { contentHash: 'complete', coreComplete: true } },
  }).evaluate(line({ raw: '100 g ginger', name: 'ginger', query: 'ginger', amount: { quantity: 100, unit: 'g' } }));
  assert.equal(gingerResult.productId, 'sku1');
  assert.notEqual(gingerResult.selectionEvidence?.approvedConnectionName, 'powdered ginger');

  const mushrooms = fixture({ ingredient: 'mushrooms', productName: 'Champinjoner', brand: 'Coop', foodId: 'mushroom' });
  const fresh = mushrooms.dataset.observations[0];
  const canned: RetailProduct = { ...fresh.product, id: 'canned-mushrooms', ean: 'canned-mushrooms', name: 'Champinjoner Skivade',
    categories: ['canned-category'], ingredientsText: 'Champinjoner, vatten, salt' };
  const cannedIdentity = productIdentity(canned);
  mushrooms.dataset.observations.push({ ...fresh, product: canned });
  (mushrooms.dataset.connections as ReviewedConnection[]).push({ ...mushrooms.dataset.connections[0], ingredientId: 'canned-mushroom',
    name: 'fresh mushrooms', mainProductId: canned.id, approvedProducts: [{ productId: canned.id, identity: cannedIdentity }] });
  const cannedNutrition = { schemaVersion: 1, retailer: 'coop', productId: canned.id, contentHash: 'canned-complete', sourcePayload: {} };
  mushrooms.sourceCollection.products[0].nutritionSource = { ...cannedNutrition, productId: 'sku1', contentHash: 'fresh-incomplete' } as never;
  mushrooms.sourceCollection.products[0].checkedAt = '2026-10-13T10:00:00Z';
  mushrooms.sourceCollection.products.push({ retailer: 'coop', productId: canned.id, productIdentity: cannedIdentity,
    status: 'collected', checkedAt: '2026-10-13T10:00:00Z', nutritionSource: cannedNutrition as never });
  const mushroomResult = createCoopRecipeEngine(mushrooms.dataset, mushrooms.sourceCollection, Date.parse('2026-10-13T12:00:00Z'), {
    preferCompleteNutrition: true, categoryMap: { 'canned-category': ['Skafferi > Grönsakskonserver > Svamp'] },
    nutritionCapabilities: { 'canned-mushrooms': { contentHash: 'canned-complete', coreComplete: true } },
  }).evaluate(line({ raw: '100 g mushrooms', name: 'mushrooms', query: 'mushrooms', amount: { quantity: 100, unit: 'g' } }));
  assert.equal(mushroomResult.productId, 'sku1');
  assert.notEqual(mushroomResult.selectionEvidence?.approvedConnectionName, 'fresh mushrooms');
});

test('an exact reviewed dried-form binding permits dry spice without bypassing other form checks', () => {
  const spice = fixture({ ingredient: 'oregano', productName: 'Oregano 5 g', foodId: 'oregano-dried' });
  const approved = spice.dataset.connections[0].approvedProducts[0];
  const review = { foodId: 'oregano-dried', productId: approved.productId, productIdentity: approved.identity,
    form: 'dried' as const, reviewedAt: '2026-10-14T12:00:00Z', sourceSha256: 'a'.repeat(64),
    reason: 'Reviewed exact Coop item as packaged dried oregano.' };
  const makeEngine = (reviews: typeof review[], product = spice.dataset.observations[0].product) => {
    const dataset = { ...spice.dataset, observations: [{ ...spice.dataset.observations[0], product }], productFormReviews: reviews };
    const sourceCollection = { ...spice.sourceCollection, products: [{ ...spice.sourceCollection.products[0],
      productIdentity: productIdentity(product) }] };
    return createCoopRecipeEngine(dataset, sourceCollection, Date.parse('2026-10-14T13:00:00Z'));
  };
  const dryLine = line({ raw: '1 tsp oregano', name: 'oregano', query: 'oregano' });
  assert.equal(spice.engine.evaluate(dryLine).reason, 'product_form_incompatible');
  assert.equal(makeEngine([review]).evaluate(dryLine).productId, approved.productId);

  const tampered = makeEngine([{ ...review, productIdentity: 'wrong-identity' }]);
  assert.equal(tampered.evaluate(dryLine).reason, 'product_form_incompatible');
  assert.equal(makeEngine([{ ...review, productId: 'different-sku' }]).evaluate(dryLine).reason,
    'product_form_incompatible');
  assert.equal(makeEngine([review]).evaluate(line({ raw: '1 tsp freshly ground oregano', name: 'oregano', query: 'oregano' })).reason,
    'product_form_incompatible');

  const duplicate = { ...spice.dataset, productFormReviews: [review, review] };
  assert.throws(() => createCoopRecipeEngine(duplicate, spice.sourceCollection, Date.parse('2026-10-14T13:00:00Z')),
    /duplicate_coop_product_form_review/);

  const potted: RetailProduct = { ...spice.dataset.observations[0].product, id: 'potted-oregano', ean: 'potted-oregano',
    name: 'Oregano i kruka' };
  const pottedId = productIdentity(potted);
  const pottedDataset = { ...spice.dataset, observations: [{ ...spice.dataset.observations[0], product: potted }],
    connections: [{ ...spice.dataset.connections[0], mainProductId: potted.id,
      approvedProducts: [{ productId: potted.id, identity: pottedId }] }], productFormReviews: [review] };
  const pottedLive = { ...spice.sourceCollection, products: [{ retailer: 'coop' as const, productId: potted.id,
    productIdentity: pottedId, status: 'collected' }] };
  assert.equal(createCoopRecipeEngine(pottedDataset, pottedLive, Date.parse('2026-10-14T13:00:00Z'))
    .evaluate(dryLine).reason, 'product_form_incompatible');
});

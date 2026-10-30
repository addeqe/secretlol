import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCoopProduct } from '../src/retailers/coop.ts';
import { checkpointedClient } from '../src/retailers/checkpoints.ts';
import { productIdentity } from '../src/retailers/identity.ts';
import { captureNutritionSource, copyNutritionSource } from '../src/retailers/nutrition-source.ts';
import type { RetailClient } from '../src/retailers/types.ts';

const scope = { storeId: '256600', channel: 'pickup' } as const;
const checkedAt = new Date('2026-10-12T08:00:00.000Z');

// Reduced from the archived successful Coop by-ID response for this exact product.
function rawProduct(): Record<string, unknown> {
  return {
    id: '7300156587121', ean: '7300156587121', name: 'Havredryck Till Kaffe',
    manufacturerName: 'Coop', packageSize: '1l', salesUnit: 'ST',
    piecePriceData: { b2cPrice: 20.95 }, availableOnline: true,
    nutrientBasis: { quantity: 100 },
    nutrientInformation: [{ header: { nutrientBasisQuantity: 100,
      nutrientBasisQuantityType: 'BY_MEASURE',
      nutrientBasisQuantityUnit: { code: 'MLT', value: 'Milliliter' } } }],
    nutrientLinks: [
      { amount: ['60'], description: 'Energi', unit: 'Kilokalori' },
      { amount: ['253'], description: 'Energi', unit: 'Kilojoule' },
      { amount: ['2.8'], description: 'Fett', unit: 'Gram' },
      { amount: ['0.10'], description: 'Salt', unit: 'Gram' },
    ],
  };
}

function observation(raw = rawProduct(), checked = checkedAt) {
  return parseCoopProduct(raw, scope, checked, true);
}

test('Coop retains the exact nutrition labels and declared basis as immutable raw evidence', () => {
  const raw = rawProduct(), product = observation(raw).product, source = product.nutritionSource!;
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.retailer, 'coop');
  assert.equal(source.productId, raw.id);
  assert.match(source.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(source.sourcePayload, {
    nutrientLinks: raw.nutrientLinks, nutrientInformation: raw.nutrientInformation, nutrientBasis: raw.nutrientBasis,
  });
  assert.deepEqual(Object.keys(source).sort(), ['contentHash', 'productId', 'retailer', 'schemaVersion', 'sourcePayload']);
  assert.equal(Object.isFrozen(source), true);
  assert.equal(Object.isFrozen(source.sourcePayload), true);
  assert.equal(Object.isFrozen(source.sourcePayload.nutrientLinks), true);
  (raw.nutrientLinks as Array<{ amount: string[] }>)[0]!.amount[0] = '999';
  assert.equal((source.sourcePayload.nutrientLinks as Array<{ amount: string[] }>)[0]!.amount[0], '60');
  assert.throws(() => { (source.sourcePayload.nutrientLinks as Array<{ amount: string[] }>)[0]!.amount[0] = '999'; }, TypeError);
});

test('nutrition fingerprints ignore object key order, prices and observation times', () => {
  const raw = rawProduct(), before = observation(raw).product.nutritionSource!;
  const reordered = { ...raw, piecePriceData: { b2cPrice: 99.95 }, nutrientBasis: { quantity: 100 },
    nutrientLinks: (raw.nutrientLinks as Array<Record<string, unknown>>).map(({ amount, description, unit }) =>
      ({ unit, description, amount })),
    nutrientInformation: [{ header: { nutrientBasisQuantityUnit: { value: 'Milliliter', code: 'MLT' },
      nutrientBasisQuantityType: 'BY_MEASURE', nutrientBasisQuantity: 100 } }],
  };
  const after = observation(reordered, new Date('2026-10-13T08:00:00Z')).product.nutritionSource!;
  assert.equal(after.contentHash, before.contentHash);
  assert.deepEqual(after.sourcePayload, before.sourcePayload);
});

test('a changed declared nutrient changes its fingerprint without changing approved product identity', () => {
  const raw = rawProduct(), before = observation(raw).product;
  (raw.nutrientLinks as Array<{ amount: string[] }>)[0]!.amount[0] = '61';
  const after = observation(raw).product;
  assert.notEqual(after.nutritionSource!.contentHash, before.nutritionSource!.contentHash);
  assert.equal(productIdentity(after), productIdentity(before));
});

test('unknown JSON-compatible source values remain raw; absent fields stay optional', () => {
  const raw = rawProduct();
  delete raw.nutrientLinks; delete raw.nutrientInformation; delete raw.nutrientBasis;
  assert.equal(observation(raw).product.nutritionSource, undefined);
  raw.nutrientLinks = [{ amount: [], description: 'TEMP_UNKNOWN' }, { amount: ['<0.1'], unit: 'Gram' }];
  raw.nutrientBasis = null;
  raw.nutrientInformation = 'unexpected source shape';
  assert.deepEqual(observation(raw).product.nutritionSource!.sourcePayload, {
    nutrientLinks: raw.nutrientLinks, nutrientInformation: raw.nutrientInformation, nutrientBasis: null,
  });
  const nullField = captureNutritionSource('coop', String(raw.id), { nutrientBasis: null })!;
  const emptyField = captureNutritionSource('coop', String(raw.id), { nutrientBasis: {} })!;
  assert.notEqual(nullField.contentHash, emptyField.contentHash);
});

test('unsafe or oversized nutrition is omitted without losing the product price', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const excessiveDepth: Record<string, unknown> = {}; let next = excessiveDepth;
  for (let n = 0; n < 40; n++) { const child = {}; next.child = child; next = child; }
  for (const value of [NaN, Infinity, 1n, undefined, cycle, excessiveDepth,
    Array(401).fill(null), [{ amount: Array(401).fill('1') }], 'x'.repeat(65536)]) {
    const parsed = observation({ ...rawProduct(), nutrientLinks: value });
    assert.equal(parsed.product.nutritionSource, undefined);
    assert.equal(parsed.price!.amountOre, 2095);
    assert.equal(parsed.availability, 'available');
  }
  const getter = rawProduct();
  Object.defineProperty(getter, 'nutrientLinks', { get() { throw new Error('unsafe accessor'); }, enumerable: true });
  assert.equal(observation(getter).price!.amountOre, 2095);
  assert.equal(observation(getter).product.nutritionSource, undefined);
});

test('checkpoint copying verifies evidence fingerprint and exact source identity', () => {
  const source = observation().product.nutritionSource!;
  assert.deepEqual(copyNutritionSource(source, 'coop', source.productId), source);
  assert.equal(copyNutritionSource(source, 'ica', source.productId), undefined);
  assert.equal(copyNutritionSource(source, 'coop', 'different-product'), undefined);
  assert.equal(copyNutritionSource({ ...source, contentHash: '0'.repeat(64) }, 'coop', source.productId), undefined);
});

test('nutrition evidence survives checkpoint round trips and older products without it remain valid', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'retailer-nutrition-checkpoint-'));
  let calls = 0;
  const client: RetailClient = {
    retailer: 'coop', capabilities: { stores: true, categories: true, browse: true,
      productLookup: true, batchLookup: true, verifiedStorePricing: true, notes: [] },
    async stores() { return []; }, async categories() { return []; }, async products() { return []; },
    async browse(requested, categoryId) {
      calls++;
      const product = observation();
      if (categoryId === 'legacy') delete product.product.nutritionSource;
      return { scope: requested, categoryId, total: 1, nextCursor: null, products: [product] };
    },
  };
  try {
    const wrapped = checkpointedClient(client, folder, { now: () => checkedAt.getTime() + 1000 });
    const first = await wrapped.browse(scope, 'dairy'), warm = await wrapped.browse(scope, 'dairy');
    assert.equal(calls, 1);
    assert.deepEqual(warm, first);
    assert.equal(Object.isFrozen(warm.products[0]!.product.nutritionSource!.sourcePayload), true);
    assert.equal(Object.isFrozen(warm.products[0]!.product.nutritionSource!.sourcePayload.nutrientLinks), true);
    const old = await wrapped.browse(scope, 'legacy'), oldWarm = await wrapped.browse(scope, 'legacy');
    assert.equal(calls, 2);
    assert.deepEqual(oldWarm, old);
    assert.equal(oldWarm.products[0]!.product.nutritionSource, undefined);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

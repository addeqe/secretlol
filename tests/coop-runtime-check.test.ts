import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCoopSource } from '../scripts/verify-coop-runtime.ts';
import type { ProductObservation, RetailClient, StoreScope } from '../src/retailers/types.ts';

const scope: StoreScope = { storeId: '256600', channel: 'pickup' };
function observation(id: string): ProductObservation {
  return {
    retailer: 'coop', scope, product: { id, ean: null, name: `Test ${id}`, brand: null,
      categories: [], pack: { quantity: 1, unit: 'piece', approximate: false }, ingredientsText: null },
    price: { amountOre: 1290, basis: 'pack', depositOre: null, memberOnly: false,
      minimumQuantity: null, validFrom: null, validUntil: null },
    availability: 'available', checkedAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(),
    storeScopeVerified: true,
  };
}
function client(sample: ProductObservation[]): RetailClient {
  return {
    retailer: 'coop',
    capabilities: { stores: true, categories: true, browse: true, productLookup: true,
      batchLookup: true, verifiedStorePricing: true, notes: [] },
    async stores() { return []; },
    async categories() { return [{ id: 'root', name: 'Root', children: [{ id: 'leaf', name: 'Leaf', children: [] }] }]; },
    async browse(_scope, id) {
      assert.equal(id, 'leaf');
      return { products: sample, nextCursor: null, total: 256, scope, categoryId: id };
    },
    async products(_scope, ids) { return ids.map(id => sample.find(item => item.product.id === id)!); },
  };
}

test('bounded source check reads one category page and verifies at most three scoped prices', async () => {
  const source = client([observation('a'), observation('b'), observation('c'), observation('d')]);
  const proof = await verifyCoopSource(source, scope, () => ({ requests: 3, retries: 0 }));
  assert.deepEqual(proof, { scope, categoriesFound: 1, categoryProductsReported: 256,
    productsChecked: 3, pricesOre: [1290, 1290, 1290], requests: 3, retries: 0 });
});

test('source check rejects observations without verified store-scoped prices', async () => {
  const invalid = observation('a');
  invalid.storeScopeVerified = false;
  await assert.rejects(verifyCoopSource(client([invalid]), scope, () => ({ requests: 3, retries: 0 })),
    /did not verify pickup-scoped prices/);
});

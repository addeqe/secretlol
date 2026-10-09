import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CoopClient, CoopMissingProductsError, parseCoopProduct } from '../src/retailers/coop.ts';
import { optimizeBasket } from '../src/retailers/basket.ts';
import { observationUsable, productIdentity, validateObservation } from '../src/retailers/identity.ts';
import type { ReviewedConnection } from '../src/retailers/identity.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import { connectionHealth } from '../src/retailers/connection-health.ts';
import { collectTracked } from '../src/retailers/collection.ts';
import { LocalProductResolver } from '../src/retailers/resolver.ts';
import { RetailerUnsupportedError, type StoreScope } from '../src/retailers/types.ts';

const categoriesFixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/coop-categories.json', import.meta.url), 'utf8')) as unknown;
const productFixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/coop-product.json', import.meta.url), 'utf8')) as unknown;
const storesFixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/coop-stores.json', import.meta.url), 'utf8')) as unknown;
const personalizationFixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/coop-personalization.json', import.meta.url), 'utf8')) as any;
const scope: StoreScope = { storeId: '251300', channel: 'pickup' };

test('default Coop transport preserves the native fetch receiver used by Workers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = function(this:unknown) {
    assert.equal(this,globalThis);
    return Promise.resolve(Response.json(categoriesFixture));
  } as typeof fetch;
  try { assert.ok((await new CoopClient({publicSubscriptionKey:'test-public-key'}).categories(scope)).length); }
  finally { globalThis.fetch = original; }
});

test('Coop category tree maps recursive ids and labels from an injected fixture response', async () => {
  const calls: string[] = [];
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async (url, init) => {
    calls.push(url);
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key'), 'test-public-key');
    return Response.json(categoriesFixture);
  } });
  assert.deepEqual(await client.categories(scope), [{ id: '16534', name: 'Frukt & grönsaker', children: [
    { id: 'fruit', name: 'Frukt', children: [] }, { id: 'vegetables', name: 'Grönsaker', children: [] },
  ] }]);
  assert.equal(new URL(calls[0]).pathname, '/ecommerce/coop/users/anonymous/categories/tree/251300');
  assert.equal(new URL(calls[0]).searchParams.get('api-version'), 'v1');
});

test('Coop ignores only the two observed empty root navigation placeholders', async () => {
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () => Response.json(categoriesFixture) });
  const categories = await client.categories(scope);
  assert.deepEqual(categories.map(category => category.id), ['16534']);
  const malformed = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () => Response.json({
    nodes: [{ code: '0003', url: '/varor/', children: [] }],
  }) });
  await assert.rejects(malformed.categories(scope), /coop_unexpected_category/);
});

test('Coop category browse uses the first-party by-attribute request and store context', async () => {
  // The scrubbed fixture has one sample item; it tests mapping and cursor request shape only.
  let requests = 0;
  let calledUrl: URL | undefined;
  let calledBody: any;
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', now: () => new Date('2026-10-08T10:00:00Z'), transport: async (url, init) => {
    requests++;
    calledUrl = new URL(url);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key'), 'test-public-key');
    calledBody = JSON.parse(String(init?.body));
    return Response.json(personalizationFixture.categoryPage);
  } });
  const page = await client.browse(scope, '21330');
  assert.equal(requests, 1);
  assert.equal(calledUrl?.pathname, '/personalization/search/entities/by-attribute');
  assert.equal(calledUrl?.searchParams.get('api-version'), 'v1');
  assert.equal(calledUrl?.searchParams.get('store'), '251300');
  assert.equal(calledUrl?.searchParams.get('groups'), 'CUSTOMER_PRIVATE');
  assert.equal(calledUrl?.searchParams.get('device'), 'desktop');
  assert.equal(calledUrl?.searchParams.get('direct'), 'false');
  assert.deepEqual(calledBody.attribute, { name: 'categoryIds', value: '21330' });
  assert.deepEqual(calledBody.resultsOptions, {
    skip: 0,
    take: 24,
    sortBy: [],
    facets: [
      { attributeName: 'brand', type: 'distinct', operator: 'AND', selected: [] },
      { attributeName: 'filterLabels', type: 'distinct', operator: 'OR', selected: [] },
      { attributeName: 'topCategory', type: 'distinct', operator: 'OR', selected: [] },
    ],
  });
  assert.equal(page.total, 1931);
  assert.equal(page.nextCursor, '1');
  assert.equal(page.products[0].price?.amountOre, 1495);
  assert.equal(page.products[0].price?.basis, 'pack');
  assert.equal(page.products[0].product.pack?.quantity, 320);
  assert.equal(page.products[0].product.pack?.unit, 'g');
  const laterPage = await client.browse(scope, '21330', '1');
  assert.equal(calledBody.resultsOptions.skip, 1);
  assert.equal(laterPage.products[0].product.id, page.products[0].product.id);
  assert.equal(requests, 2);
  assert.equal(client.capabilities.stores, true);
  assert.equal(client.capabilities.browse, true);
  assert.equal(client.capabilities.verifiedStorePricing, true);
  assert.equal(client.capabilities.batchLookup, true);
});

test('Coop rejects delivery and slot pricing because those scopes are not in the storefront request', async () => {
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () => Response.json(personalizationFixture.byId) });
  await assert.rejects(client.products({ ...scope, channel: 'delivery' }, ['7311070337297']),
    (error: unknown) => error instanceof RetailerUnsupportedError && error.operation === 'requested_price_scope');
  await assert.rejects(client.browse({ ...scope, slotId: 'slot-1' }, '21330'),
    (error: unknown) => error instanceof RetailerUnsupportedError && error.operation === 'requested_price_scope');
});

test('Coop postal lookup maps nearby pickup stores and omits outlets without pickup modes', async () => {
  let called: URL | undefined;
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async url => {
    called = new URL(url);
    return Response.json(storesFixture);
  } });
  assert.deepEqual(await client.stores('114 55'), [{
    retailer: 'coop', id: '035000', name: 'Coop Daglivs', channels: ['pickup'],
    postalCode: '11234', address: 'Sankt Eriksgatan 34-38, Stockholm', url: '/butiker-erbjudanden/coop-daglivs',
    pricingStoreId: '035000',
  }, {
    retailer: 'coop', id: '252700', name: 'Coop Träkvista Alltid Öppet', channels: ['pickup'],
    postalCode: '179 75', address: 'Tegelbruksvägen 1, Ekerö', pricingStoreId: '252700', pickupPointId: '990326',
  }]);
  assert.equal(called?.pathname, '/ecommerce/coop/pointofservices');
  assert.equal(called?.searchParams.get('query'), '11455');
  assert.equal(called?.searchParams.get('fields'), 'FULL');
});

test('generic Coop EAN details retain identity/package but never assert local price or stock', () => {
  const observed = parseCoopProduct(productFixture, scope, new Date('2026-10-08T10:00:00Z'), false);
  assert.equal(observed.product.ean, '7310865001234');
  assert.equal(observed.product.brand, 'Xtra');
  assert.deepEqual(observed.product.pack, { quantity: 600, unit: 'g', approximate: false });
  assert.equal(observed.product.ingredientsText, 'Havregryn');
  assert.equal(observed.price, null);
  assert.equal(observed.availability, 'unknown');
  assert.equal(observed.storeScopeVerified, false);
});

test('Coop by-id selects current public fixed price and falls back from member-only multi-buy', async () => {
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', now: () => new Date('2026-10-08T10:00:00Z'),
    transport: async () => Response.json(personalizationFixture.byId) });
  const products = await client.products(scope, [
    '7311070337297', '7310865561121', '5449000259172', '7300156587121', '2317401100009',
  ]);
  assert.equal(products.length, 5);
  assert.deepEqual(products.map(item => item.price?.amountOre), [2500, 5950, 7377, 1595, 2190]);
  assert.equal(products[0].price?.memberOnly, false);
  assert.equal(products[0].price?.basis, 'pack');
  assert.equal(products[0].price?.minimumQuantity, 1);
  assert.equal(products[0].price?.validFrom, '2026-10-04T22:00:00.000Z');
  assert.equal(products[1].price?.memberOnly, false);
  assert.equal(products[1].price?.minimumQuantity, null);
  assert.equal(products[1].price?.basis, 'pack');
  assert.equal(products[1].product.pack?.unit, 'g');
  assert.equal(products[2].price?.depositOre, 1000);
  assert.equal(products[2].price?.basis, 'pack');
  assert.equal(products[2].product.pack?.quantity, 3300);
  assert.equal(products[2].product.pack?.unit, 'ml');
  assert.equal(products[3].price?.basis, 'pack');
  assert.equal(products[3].product.pack?.unit, 'ml');
  assert.equal(products[4].price?.basis, 'kg');
  assert.equal(products[4].price?.amountOre, 2190);
  assert.deepEqual(products[4].product.pack, { quantity: 180, unit: 'g', approximate: true });
});

test('Coop per-pack prices keep a grocery basket total correct despite kg comparison prices', () => {
  const tortilla = parseCoopProduct({ ...personalizationFixture.categoryPage.results.items[0], id: 'tortilla' }, scope,
    new Date('2026-10-08T10:00:00Z'), true);
  const butter = parseCoopProduct({ ...personalizationFixture.byId.results.items[1], id: 'butter' }, scope,
    new Date('2026-10-08T10:00:00Z'), true);
  const result = optimizeBasket({
    retailer: 'coop', scope, now: Date.parse('2026-10-08T10:00:00Z'),
    observations: [tortilla, butter],
    demands: [
      { ingredientId: 'tortilla', name: 'tortilla', quantity: 640, unit: 'g', approvedProductIds: ['tortilla'] },
      { ingredientId: 'butter', name: 'butter', quantity: 250, unit: 'g', approvedProductIds: ['butter'] },
    ],
  });
  assert.equal(tortilla.price?.basis, 'pack');
  assert.equal(butter.price?.basis, 'pack');
  assert.equal(result.complete, true);
  assert.equal(result.purchaseCostOre, 8940);
  assert.equal(result.consumedCostOre, 5965);
});

test('price and availability parse only with explicit matching store identity', () => {
  const payload = { data: { ...((productFixture as any).data), store: { storeId: '251300', channel: 'pickup' } } };
  const observed = parseCoopProduct(payload, scope, new Date('2026-10-08T10:00:00Z'), true);
  assert.deepEqual(observed.price, {
    amountOre: 3095,
    basis: 'pack',
    depositOre: null,
    memberOnly: true,
    minimumQuantity: 2,
    validFrom: '2026-10-01T00:00:00.000Z',
    validUntil: '2026-10-31T23:59:59.000Z',
  });
  assert.equal(observed.availability, 'unavailable');
  assert.equal(observed.storeScopeVerified, true);
  const otherStore = parseCoopProduct(payload, { ...scope, storeId: 'other' }, new Date('2026-10-08T10:00:00Z'), true);
  assert.equal(otherStore.price, null);
  assert.equal(otherStore.availability, 'unknown');
  assert.equal(otherStore.storeScopeVerified, false);
  const otherChannel = parseCoopProduct(payload, { ...scope, channel: 'delivery' }, new Date('2026-10-08T10:00:00Z'), true);
  assert.equal(otherChannel.price, null);
  assert.equal(otherChannel.storeScopeVerified, false);
  const malformedStore = parseCoopProduct({ ...personalizationFixture.byId.results.items[0], store: {} }, scope,
    new Date('2026-10-08T10:00:00Z'), true);
  assert.equal(malformedStore.price, null);
  assert.equal(malformedStore.storeScopeVerified, false);
});

test('product lookup deduplicates EANs and sends them in one first-party by-id request', async () => {
  const calls: URL[] = [];
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', now: () => new Date('2026-10-08T10:00:00Z'),
    transport: async (url, init) => {
      calls.push(new URL(url));
      const ids = JSON.parse(String(init?.body)) as string[];
      return Response.json({ ...personalizationFixture.byId, results: {
        ...personalizationFixture.byId.results,
        count: ids.length,
        items: personalizationFixture.byId.results.items.filter((item: any) => ids.includes(item.id)),
      } });
    } });
  const result = await client.products(scope, ['7311070337297', '7311070337297']);
  assert.equal(result.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/personalization/search/entities/by-id');
  assert.equal(calls[0].searchParams.get('store'), '251300');
  assert.equal(calls[0].searchParams.get('api-version'), 'v1');
  assert.equal(calls[0].searchParams.get('quickSearch'), 'false');
  assert.equal(client.capabilities.batchLookup, true);
  assert.equal(result[0].expiresAt, '2026-10-09T10:00:00.000Z');
  assert.equal(observationUsable(result[0], 'coop', scope, Date.parse('2026-10-08T16:00:00Z')), true);
});

test('Coop offer expiry bounds source validity while local cache remains limited to 30 minutes', async () => {
  const product = structuredClone(personalizationFixture.byId.results.items[0]);
  product.onlinePromotions[0].endDate = '2026-10-08T10:20:00Z';
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', now: () => new Date('2026-10-08T10:00:00Z'),
    transport: async () => Response.json({ results: { count: 1, items: [product] } }) });
  const [observation] = await client.products(scope, [product.id]);
  assert.equal(observation.expiresAt, '2026-10-08T10:20:00.000Z');
  assert.equal(observation.price?.validUntil, '2026-10-08T10:20:00.000Z');

  let cached: any;
  const resolver = new LocalProductResolver(client, {
    async get() { return null; },
    async set(_key, value) { cached = value; },
  });
  await resolver.resolve(scope, [{ ingredientId: 'ingredient-1', approvedProducts: [{ productId: product.id }] } as any],
    Date.parse('2026-10-08T10:00:00Z'));
  assert.equal(cached.expiresAt, '2026-10-08T10:20:00.000Z');

  const ordinaryClient = new CoopClient({ publicSubscriptionKey: 'test-public-key', now: () => new Date('2026-10-08T10:00:00Z'),
    transport: async () => Response.json({ results: { count: 1, items: [personalizationFixture.byId.results.items[0]] } }) });
  let ordinaryCached: any;
  const ordinaryResolver = new LocalProductResolver(ordinaryClient, {
    async get() { return null; }, async set(_key, value) { ordinaryCached = value; },
  });
  const ordinary = await ordinaryClient.products(scope, [product.id]);
  assert.equal(ordinary[0].expiresAt, '2026-10-09T10:00:00.000Z');
  await ordinaryResolver.resolve(scope, [{ ingredientId: 'ingredient-1', approvedProducts: [{ productId: product.id }] } as any],
    Date.parse('2026-10-08T10:00:00Z'));
  assert.equal(ordinaryCached.expiresAt, '2026-10-08T10:30:00.000Z');
});

test('product lookup distinguishes a well-formed missing ID from malformed by-ID responses', async () => {
  const missingClient = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () =>
    Response.json({ results: { count: 0, items: [] } }) });
  await assert.rejects(missingClient.products(scope, ['7311070337297']), (error: unknown) => {
    assert.ok(error instanceof CoopMissingProductsError);
    assert.deepEqual(error.scope, scope);
    assert.deepEqual(error.requestedProductIds, ['7311070337297']);
    assert.deepEqual(error.missingProductIds, ['7311070337297']);
    assert.deepEqual(error.observations, []);
    return true;
  });
  const malformedClient = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () =>
    Response.json({ results: { count: 1, items: [] } }) });
  await assert.rejects(malformedClient.products(scope, ['7311070337297']), /coop_incomplete_products_response/);
  const inconsistentClient = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () =>
    Response.json({ results: { count: 0, items: [personalizationFixture.byId.results.items[0]] } }) });
  await assert.rejects(inconsistentClient.products(scope, ['7311070337297']), /coop_unexpected_products_response/);
  const duplicateClient = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () =>
    Response.json({ results: { count: 2, items: [personalizationFixture.byId.results.items[0], personalizationFixture.byId.results.items[0]] } }) });
  await assert.rejects(duplicateClient.products(scope, ['7311070337297']), /coop_incomplete_products_response/);
  const unrequestedClient = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () =>
    Response.json({ results: { count: 1, items: [{ ...personalizationFixture.byId.results.items[0], id: '99999999' }] } }) });
  await assert.rejects(unrequestedClient.products(scope, ['7311070337297']), /coop_incomplete_products_response/);
});

test('tracked refresh confirms disappearance once and retains only explicitly prior identity evidence', async () => {
  const id = '7311070337297';
  const prior = await new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () =>
    Response.json({ results: { count: 1, items: [personalizationFixture.byId.results.items[0]] } }) }).products(scope, [id]);
  let calls = 0;
  const missing = new CoopClient({ publicSubscriptionKey: 'test-public-key', now: () => new Date('2026-10-09T10:00:00Z'),
    transport: async () => { calls++; return Response.json({ results: { count: 0, items: [] } }); } });
  const [observation] = await collectTracked(missing, scope, [id], 25, prior);
  assert.equal(calls, 2);
  assert.equal(observation.product.id, id);
  assert.equal(observation.identityEvidence?.status, 'prior');
  assert.equal(observation.identityEvidence?.lastVerifiedAt, prior[0].checkedAt);
  assert.equal(observation.price, null);
  assert.equal(observation.availability, 'unknown');
  assert.equal(observation.storeScopeVerified, false);
  validateObservation(observation, 'coop', scope);
  assert.equal(observationUsable(observation, 'coop', scope), false);
});

test('tracked refresh keeps returned products and recovers missing reserves on the confirmation lookup', async () => {
  const first = '7311070337297', second = '7310865561121';
  const productA = { ...personalizationFixture.byId.results.items[0], id: first };
  const productB = { ...personalizationFixture.byId.results.items[1], id: second };
  const calls: string[][] = [];
  const client = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as string[];
    calls.push(body);
    return body.length === 2
      ? Response.json({ results: { count: 1, items: [productA] } })
      : Response.json({ results: { count: 1, items: [productB] } });
  } });
  const found = await collectTracked(client, scope, [first, second]);
  assert.deepEqual(calls, [[second, first].sort(), [second]]);
  assert.deepEqual(found.map(o => o.product.id), [first, second]);
  assert.ok(found.every(o => o.price && o.storeScopeVerified && !o.identityEvidence));
});

test('confirmed missing primary keeps a current reserve usable for the ingredient', async () => {
  const mainId = '7311070337297', reserveId = '7310865561121';
  const [main, reserve] = await new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () =>
    Response.json({ results: { count: 2, items: personalizationFixture.byId.results.items.slice(0, 2) } })
  }).products(scope, [mainId, reserveId]);
  let request = 0;
  const source = new CoopClient({ publicSubscriptionKey: 'test-public-key', transport: async () => {
    request++;
    return request === 1
      ? Response.json({ results: { count: 1, items: [personalizationFixture.byId.results.items[1]] } })
      : Response.json({ results: { count: 0, items: [] } });
  } });
  const refreshed = await collectTracked(source, scope, [mainId, reserveId], 25, [main, reserve]);
  const connection: ReviewedConnection = {
    ingredientId: 'ing_test', name: 'test ingredient', foodId: null, status: 'matched', mainProductId: mainId,
    approvedProducts: [{ productId: mainId, identity: productIdentity(main.product) },
      { productId: reserveId, identity: productIdentity(reserve.product) }],
    policyVersion: DIETARY_POLICY_VERSION, reviewedAt: main.checkedAt, reason: 'test',
  };
  const health = connectionHealth(connection, refreshed, 'coop', scope);
  assert.equal(health.status, 'matched');
  assert.equal(health.productId, reserveId);
  assert.equal(health.reason, 'approved_alternative_available');
  assert.equal(refreshed.find(o => o.product.id === mainId)?.identityEvidence?.status, 'prior');
});

test('missing public key fails before sending a request', async () => {
  let requests = 0;
  const client = new CoopClient({ transport: async () => { requests++; return Response.json({}); } });
  await assert.rejects(client.categories(scope), /coop_public_subscription_key_required/);
  assert.equal(requests, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, rows } from '../src/database.ts';
import { productIdentity, type ReviewedConnection } from '../src/retailers/identity.ts';
import { retailSchema, configureRetailDataset, publishRetailObservations, type RetailDataset } from '../src/retailers/storage.ts';
import { MemoryObservationCache } from '../src/retailers/resolver.ts';
import { scopeKey, type ProductObservation, type RetailClient, type StoreScope } from '../src/retailers/types.ts';
import { retailMealQuote, retailerRoutes, type RecipeDocument, type RetailEnv } from '../worker/retailers.ts';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('external_network_forbidden_in_test'); };
test.after(() => { globalThis.fetch = originalFetch; });

const rawFixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/demo-coop.json', import.meta.url), 'utf8')) as RetailDataset & { sourceMarker: string };
const manifest = { datasetId: rawFixture.datasetId, inventoryHash: rawFixture.inventoryHash };
const localScope: StoreScope = { storeId: 'selected-local-store', channel: 'pickup' };

function fixture(now = Date.now()): RetailDataset {
  const data = structuredClone(rawFixture) as RetailDataset;
  for (const observation of data.observations) {
    observation.checkedAt = new Date(now - 60_000).toISOString();
    observation.expiresAt = new Date(now + 60 * 60_000).toISOString();
  }
  const rice = data.observations.find(o => o.product.id === 'demo-rice-1kg')!;
  rice.product.ean = '0000000000001';
  for (const connection of data.connections) {
    for (const approved of connection.approvedProducts) {
      const source = data.observations.find(o => o.product.id === approved.productId)!;
      approved.identity = productIdentity(source.product);
    }
  }
  return data;
}

function database() {
  const db = new LocalDatabase(':memory:');
  db.execute(retailSchema());
  return db;
}

function d1(db: LocalDatabase): D1Database {
  return { prepare(sql: string) {
    let params: Array<string | number | null> = [];
    const statement: any = {
      bind(...values: Array<string | number | null>) { params = values; return statement; },
      async first() { return (await rows(db, sql, params))[0] ?? null; },
      async all() { return { results: await rows(db, sql, params), success: true }; },
      async run() { await db.query(sql, params); return { success: true }; },
    };
    return statement;
  } } as unknown as D1Database;
}

async function seed(data = fixture()) {
  const db = database();
  await configureRetailDataset(db, data);
  await publishRetailObservations(db, data.retailer, data.scope, data.observations,
    data.observations.map(o => o.product.id), Date.now());
  return { db, data };
}

function recipe(ingredients: RecipeDocument['ingredients'], servings = 1): RecipeDocument {
  return { servings, recipe_yield: null, ingredients };
}

function loader(documents: Map<number, RecipeDocument>, called?: number[][]) {
  return async (ids: number[]) => { called?.push(ids); return new Map(ids.flatMap(id => documents.has(id) ? [[id, documents.get(id)!] as const] : [])); };
}

function sourceClient(data: RetailDataset, options: { prices?: Record<string, number>; emptyPrice?: boolean; localProducts?: Map<string, ProductObservation['product']> } = {}) {
  const calls: string[][] = [];
  const client: RetailClient = {
    retailer: 'coop',
    capabilities: { stores: true, categories: true, browse: false, productLookup: true, batchLookup: true,
      verifiedStorePricing: true, notes: [] },
    async stores() { throw new Error('not used'); },
    async categories() { throw new Error('not used'); },
    async browse() { throw new Error('not used'); },
    async products(scope, ids) {
      calls.push([...ids]);
      return ids.map(id => {
        const original = data.observations.find(o => o.product.id === id);
        const localProduct = options.localProducts?.get(id);
        if (!original && !localProduct) throw new Error(`unexpected_fixture_product:${id}`);
        const product = localProduct ?? original!.product;
        const originalPrice = original?.price ?? data.observations.find(o => o.product.ean === product.ean)?.price ?? null;
        const price = options.emptyPrice ? null : {
          ...(originalPrice ?? { amountOre: 100, basis: 'pack' as const, depositOre: 0, memberOnly: false,
            minimumQuantity: null, validFrom: null, validUntil: null }),
          amountOre: options.prices?.[id] ?? originalPrice?.amountOre ?? 100,
        };
        return {
          retailer: 'coop', scope, product, price, availability: 'available' as const,
          checkedAt: new Date(Date.now() - 30_000).toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), storeScopeVerified: true,
        };
      });
    },
  };
  return { client, calls };
}

function env(db?: LocalDatabase, extras: Partial<RetailEnv> = {}): RetailEnv {
  return { ...(db ? { COOP_DB: d1(db) } : {}), RETAILERS_LIVE_ENABLED: 'false', ...extras };
}

async function quote(db: LocalDatabase, data: RetailDataset, body: unknown, documents: Map<number, RecipeDocument>,
  dependencies?: { client?: RetailClient; cache?: MemoryObservationCache }) {
  const isolated = dependencies ? { ...dependencies, cache: dependencies.cache ?? new MemoryObservationCache() } : undefined;
  return retailMealQuote(env(db), manifest, body, loader(documents), isolated);
}

test('synthetic Coop fixture has metadata, reviewed connections, product observations and scope-state rows', async () => {
  assert.match(rawFixture.sourceMarker, /^SYNTHETIC OFFLINE FIXTURE ONLY/);
  const { db, data } = await seed();
  try {
    const meta = await rows(db, 'SELECT key,value FROM retail_meta ORDER BY key');
    const metadata = Object.fromEntries(meta.map(r => [r.key, r.value]));
    assert.equal(metadata.dataset_id, data.datasetId);
    assert.equal(metadata.inventory_hash, data.inventoryHash);
    assert.match(metadata.connections_version ?? '', /^[a-f0-9]{64}$/);
    assert.equal(metadata.policy_version, 'owner-halal-brands-strict-2');
    assert.equal(metadata.reference_scope, scopeKey('coop', data.scope));
    assert.equal(metadata.retailer, 'coop');
    assert.equal((await rows(db, 'SELECT COUNT(*) AS count FROM retail_connections'))[0].count, 4);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS count FROM retail_products'))[0].count, 3);
    assert.deepEqual((await rows(db, 'SELECT active_run_id FROM retail_scope_state')).length, 1);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS count FROM retail_local_mappings'))[0].count, 0);
  } finally { db.close(); }
});

test('retailer route reports unconnected setup without external requests', async () => {
  const response = await retailerRoutes(new Request('https://worker.test/retailers'), env(undefined, { RETAILERS_LIVE_ENABLED: 'true' }));
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.defaultRetailer, 'willys');
  assert.equal(body.retailers.find((r: any) => r.retailer === 'coop').connected, false);
  assert.equal(body.retailers.find((r: any) => r.retailer === 'coop').configured, false);
  assert.equal(body.retailers.find((r: any) => r.retailer === 'coop').liveLookupsEnabled, true);
});

test('retailer route reports configured reference scope and latest completed refresh', async () => {
  const { db, data } = await seed();
  try {
    const response = await retailerRoutes(new Request('https://worker.test/retailers'), env(db));
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    const coop = body.retailers.find((r: any) => r.retailer === 'coop');
    assert.equal(coop.connected, true);
    assert.equal(coop.configured, true);
    assert.deepEqual(coop.referenceScope, data.scope);
    assert.equal(coop.datasetId, data.datasetId);
    assert.equal(coop.inventoryHash, data.inventoryHash);
    assert.equal(coop.lastRefresh.checked, 3);
    assert.equal(coop.liveLookupsEnabled, false);
  } finally { db.close(); }
});

test('store route blocks live lookup when disabled and never reaches fetch', async () => {
  const response = await retailerRoutes(new Request('https://worker.test/stores?retailer=coop&postalCode=11455'), env());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'retailer_live_lookups_disabled' });
});

test('reference quote combines multiple recipes and rounds whole packs after summing their needs', async () => {
  const { db, data } = await seed();
  try {
    const documents = new Map<number, RecipeDocument>([
      [1, recipe([
        { ingredient_original: 'rice', unit: 'g', measured_quantity: 500 },
        { ingredient_original: 'onion', unit: 'piece', measured_quantity: 1 },
        { ingredient_original: 'water', unit: 'cup', measured_quantity: 1 },
      ])],
      [2, recipe([
        { ingredient_original: 'rice', unit: 'g', measured_quantity: 600 },
        { ingredient_original: 'onion', unit: 'piece', measured_quantity: 2 },
        { ingredient_original: 'eggs', unit: 'piece', measured_quantity: 2 },
      ])],
    ]);
    const response = await quote(db, data, { retailer: 'coop', finalists: [{ id: 'week', recipes: [{ recipeId: 1 }, { recipeId: 2 }] }] }, documents);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.priceMode, 'reference');
    assert.equal(body.finalists[0].basket.complete, true);
    assert.equal(body.basket.purchaseCostOre, 7440); // 2 rice, 3 onion, 1 egg package.
    assert.deepEqual(body.basket.lines.map((line: any) => [line.productId, line.packs]).sort(), [
      ['demo-eggs-6', 1], ['demo-onion-each', 3], ['demo-rice-1kg', 2],
    ]);
    assert.equal(body.selectedMenuId, 'week');
  } finally { db.close(); }
});

test('local finalists rank by actual local package cost instead of reference cost', async () => {
  const { db, data } = await seed();
  try {
    const docs = new Map<number, RecipeDocument>([
      [1, recipe([{ ingredient_original: 'rice', unit: 'g', measured_quantity: 100 }])],
      [2, recipe([{ ingredient_original: 'eggs', unit: 'piece', measured_quantity: 1 }])],
      [3, recipe([{ ingredient_original: 'onion', unit: 'piece', measured_quantity: 1 }])],
    ]);
    const { client } = sourceClient(data, { prices: { 'demo-rice-1kg': 5000, 'demo-eggs-6': 500, 'demo-onion-each': 1000 } });
    const response = await quote(db, data, { retailer: 'coop', priceMode: 'local', storeId: localScope.storeId, channel: localScope.channel,
      finalists: [
        { id: 'reference-cheapest', recipes: [{ recipeId: 1 }] },
        { id: 'local-cheapest', recipes: [{ recipeId: 2 }] },
        { id: 'middle', recipes: [{ recipeId: 3 }] },
      ] }, docs, { client });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.finalists.map((f: any) => f.id), ['local-cheapest', 'middle', 'reference-cheapest']);
    assert.equal(body.finalists[0].referenceCostOre, 1690);
    assert.equal(body.finalists[0].basket.purchaseCostOre, 500);
    assert.equal(body.selectedMenuId, 'local-cheapest');
    assert.equal(body.priceSource, 'local-webshop');
  } finally { db.close(); }
});

test('missing local price remains unresolved instead of borrowing the reference price', async () => {
  const { db, data } = await seed();
  try {
    const docs = new Map<number, RecipeDocument>([[1, recipe([{ ingredient_original: 'rice', unit: 'g', measured_quantity: 100 }])]]);
    const { client } = sourceClient(data, { emptyPrice: true });
    const response = await quote(db, data, { retailer: 'coop', priceMode: 'local', storeId: localScope.storeId,
      channel: localScope.channel, recipes: [{ recipeId: 1 }] }, docs, { client });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.priceMode, 'local');
    assert.equal(body.basket.referenceCostOre, undefined);
    assert.equal(body.finalists[0].referenceCostOre, 1990);
    assert.equal(body.basket.complete, false);
    assert.equal(body.basket.purchaseCostOre, null);
    assert.equal(body.basket.unresolved[0].reason, 'price_unknown');
  } finally { db.close(); }
});

test('local mapping accepts a changed ID only when EAN and full product identity are exact', async () => {
  const { db, data } = await seed();
  try {
    const reference = data.observations.find(o => o.product.id === 'demo-rice-1kg')!.product;
    const connection = data.connections.find(c => c.mainProductId === reference.id)!;
    const mapping = { referenceProductId: reference.id, referenceIdentity: connection.approvedProducts[0].identity,
      localProduct: { ...reference, id: 'local-rice-id' }, checkedAt: new Date().toISOString() };
    await db.query('INSERT INTO retail_local_mappings VALUES(?,?,?,?,?)', [
      scopeKey('coop', localScope), reference.id, mapping.localProduct.id, JSON.stringify(mapping), mapping.checkedAt,
    ]);
    const { client, calls } = sourceClient(data, { localProducts: new Map([[mapping.localProduct.id, mapping.localProduct]]) });
    const docs = new Map<number, RecipeDocument>([[1, recipe([{ ingredient_original: 'rice', unit: 'g', measured_quantity: 100 }])]]);
    const response = await quote(db, data, { retailer: 'coop', priceMode: 'local', storeId: localScope.storeId,
      channel: localScope.channel, recipes: [{ recipeId: 1 }] }, docs, { client });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.basket.complete, true);
    assert.equal(body.basket.lines[0].productId, 'local-rice-id');
    assert.deepEqual(calls, [['local-rice-id']]);
  } finally { db.close(); }
});

test('local mapping rejects changed ingredients or pack identity even with the same EAN', async t => {
  for (const change of ['ingredientsText', 'pack'] as const) await t.test(change, async () => {
    const { db, data } = await seed();
    try {
      const reference = data.observations.find(o => o.product.id === 'demo-rice-1kg')!.product;
      const connection = data.connections.find(c => c.mainProductId === reference.id)!;
      const localProduct = change === 'ingredientsText'
        ? { ...reference, id: 'changed-rice', ingredientsText: 'Rice and wheat' }
        : { ...reference, id: 'changed-rice', pack: { quantity: 500, unit: 'g' as const, approximate: false } };
      const mapping = { referenceProductId: reference.id, referenceIdentity: connection.approvedProducts[0].identity,
        localProduct, checkedAt: new Date().toISOString() };
      await db.query('INSERT INTO retail_local_mappings VALUES(?,?,?,?,?)', [
        scopeKey('coop', localScope), reference.id, localProduct.id, JSON.stringify(mapping), mapping.checkedAt,
      ]);
      const { client, calls } = sourceClient(data, { localProducts: new Map([[localProduct.id, localProduct]]) });
      const docs = new Map<number, RecipeDocument>([[1, recipe([{ ingredient_original: 'rice', unit: 'g', measured_quantity: 100 }])]]);
      const response = await quote(db, data, { retailer: 'coop', priceMode: 'local', storeId: localScope.storeId,
        channel: localScope.channel, recipes: [{ recipeId: 1 }] }, docs, { client });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'retailer_local_mapping_needs_review' });
      assert.equal(calls.length, 0);
    } finally { db.close(); }
  });
});

test('unknown recipe quantity remains unresolved in the quote', async () => {
  const { db, data } = await seed();
  try {
    const docs = new Map<number, RecipeDocument>([[1, recipe([{ ingredient_original: 'rice', unit: 'g', measured_quantity: null }])]]);
    const { client } = sourceClient(data);
    const response = await quote(db, data, { retailer: 'coop', priceMode: 'local', storeId: localScope.storeId,
      channel: localScope.channel, recipes: [{ recipeId: 1 }] }, docs, { client });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.basket.complete, false);
    assert.equal(body.basket.purchaseCostOre, null);
    assert.equal(body.basket.unresolved[0].reason, 'quantity_unknown_or_invalid');
  } finally { db.close(); }
});

test('cold local lookup fetches the deduplicated tracked-product union once and warm cache avoids fetches', async () => {
  const { db, data } = await seed();
  try {
    const docs = new Map<number, RecipeDocument>([
      [1, recipe([
        { ingredient_original: 'rice', unit: 'g', measured_quantity: 100 },
        { ingredient_original: 'onion', unit: 'piece', measured_quantity: 1 },
      ])],
      [2, recipe([
        { ingredient_original: 'rice', unit: 'g', measured_quantity: 200 },
        { ingredient_original: 'eggs', unit: 'piece', measured_quantity: 1 },
      ])],
    ]);
    const body = { retailer: 'coop', priceMode: 'local', storeId: localScope.storeId, channel: localScope.channel,
      finalists: [
        { id: 'one', recipes: [{ recipeId: 1 }, { recipeId: 2 }] },
        { id: 'two', recipes: [{ recipeId: 2 }] },
      ] };
    const cold = sourceClient(data);
    const coldResponse = await quote(db, data, body, docs, { client: cold.client, cache: new MemoryObservationCache() });
    assert.equal(coldResponse.status, 200);
    assert.equal(cold.calls.length, 1);
    assert.deepEqual(cold.calls[0], ['demo-eggs-6', 'demo-onion-each', 'demo-rice-1kg']);

    const cache = new MemoryObservationCache();
    const warmAt = Date.now();
    for (const reference of data.observations) {
      const observation: ProductObservation = { ...reference, scope: localScope,
        checkedAt: new Date(warmAt - 30_000).toISOString(), expiresAt: new Date(warmAt + 20 * 60_000).toISOString() };
      await cache.set(JSON.stringify([scopeKey('coop', localScope), reference.product.id]), observation);
    }
    const warm = sourceClient(data);
    const warmResponse = await quote(db, data, body, docs, { client: warm.client, cache });
    assert.equal(warmResponse.status, 200);
    assert.equal(warm.calls.length, 0);
  } finally { db.close(); }
});

test('tracked product details expose source pack prices and mark expired observations unusable', async () => {
  const {db,data}=await seed();
  try {
    const request=new Request('https://worker.test/retailers/coop/products?ids=demo-rice-1kg,missing,%20demo-eggs-6');
    assert.equal((await retailerRoutes(request,env(db))).status,400);
    const valid=new Request('https://worker.test/retailers/coop/products?ids=demo-rice-1kg,missing,demo-rice-1kg');
    const response=await retailerRoutes(valid,env(db));
    assert.equal(response.status,200);
    const body=await response.json() as any;
    assert.equal(body.products.length,1);
    assert.equal(body.products[0].product.id,'demo-rice-1kg');
    assert.equal(body.products[0].product.pack.quantity,1000);
    assert.deepEqual(body.products[0].price,data.observations.find(o=>o.product.id==='demo-rice-1kg')!.price);
    assert.equal(body.products[0].fresh,true);
    assert.equal(body.products[0].publicPriceUsable,true);
    assert.deepEqual(body.missingProductIds,['missing']);
    await db.query('UPDATE retail_runs SET checked_at=?,expires_at=?',[new Date(Date.now()-86400000).toISOString(),new Date(Date.now()-1).toISOString()]);
    const expired=await (await retailerRoutes(valid,env(db))).json() as any;
    assert.equal(expired.products[0].fresh,false);
    assert.equal(expired.products[0].publicPriceUsable,false);
    assert.equal((await retailerRoutes(new Request('https://worker.test/retailers/ica/products?ids=demo-rice-1kg'),env(db))).status,503);
  } finally {db.close();}
});

test('blocked meat ingredient cannot use a reviewed product connection', async () => {
  const { db, data } = await seed();
  try {
    const row = (await rows(db, "SELECT document_json FROM retail_connections WHERE ingredient_id='fixture-rice'"))[0];
    const connection = JSON.parse(String(row.document_json)) as ReviewedConnection;
    connection.name = 'pork';
    await db.db.prepare("UPDATE retail_connections SET ingredient_name='pork',document_json=? WHERE ingredient_id='fixture-rice'")
      .run(JSON.stringify(connection));
    const docs = new Map<number, RecipeDocument>([[1, recipe([{ ingredient_original: 'pork', unit: 'g', measured_quantity: 100 }])]]);
    const response = await quote(db, data, { retailer: 'coop', recipes: [{ recipeId: 1 }] }, docs);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.basket.complete, false);
    assert.equal(body.basket.lines.length, 0);
    assert.equal(body.basket.unresolved[0].reason, 'no_approved_compatible_product');
  } finally { db.close(); }
});

test('quote rejects mismatched dataset and oversized or malformed requests before loading recipes', async () => {
  const { db, data } = await seed();
  try {
    let loads = 0;
    const neverLoad = async (_ids: number[]) => { loads++; return new Map<number, RecipeDocument>(); };
    const cases: Array<{ body: unknown; manifest?: typeof manifest; status: number; error: string }> = [
      { body: { retailer: 'coop', recipes: [{ recipeId: 1 }] }, manifest: { ...manifest, datasetId: 'wrong-dataset' }, status: 503, error: 'retailer_connections_refresh_pending' },
      { body: { retailer: 'willys', recipes: [{ recipeId: 1 }] }, status: 400, error: 'retailer_must_be_coop_or_ica' },
      { body: { retailer: 'coop', priceMode: 'online', recipes: [{ recipeId: 1 }] }, status: 400, error: 'invalid_price_mode' },
      { body: { retailer: 'coop', budgetOre: -1, recipes: [{ recipeId: 1 }] }, status: 400, error: 'invalid_budget' },
      { body: { retailer: 'coop', budgetOre: 100000001, recipes: [{ recipeId: 1 }] }, status: 400, error: 'invalid_budget' },
      { body: { retailer: 'coop', recipes: [] }, status: 400, error: 'supply_1_to_3_valid_menu_finalists' },
      { body: { retailer: 'coop', recipes: Array.from({ length: 33 }, () => ({ recipeId: 1 })) }, status: 400, error: 'supply_1_to_3_valid_menu_finalists' },
      { body: { retailer: 'coop', recipes: [{ recipeId: 1, servings: 1001 }] }, status: 400, error: 'supply_1_to_3_valid_menu_finalists' },
      { body: { retailer: 'coop', finalists: Array.from({ length: 4 }, (_, i) => ({ id: `menu-${i}`, recipes: [{ recipeId: 1 }] })) }, status: 400, error: 'supply_1_to_3_valid_menu_finalists' },
    ];
    for (const item of cases) {
      const response = await retailMealQuote(env(db), item.manifest ?? manifest, item.body, neverLoad);
      assert.equal(response.status, item.status);
      assert.deepEqual(await response.json(), { error: item.error });
    }
    assert.equal(loads, 0);
    const validShapeBadOverride = await retailMealQuote(env(db), manifest, {
      retailer: 'coop', recipes: [{ recipeId: 1, amountOverrides: { '0': { unit: 'cup', quantity: 2 } } }],
    }, async ids => { loads++; return new Map(ids.map(id => [id, recipe([{ ingredient_original: 'rice', unit: 'g', measured_quantity: 100 }])])) });
    assert.equal(validShapeBadOverride.status, 400);
    assert.deepEqual(await validShapeBadOverride.json(), { error: 'invalid_amount_override' });
    assert.equal(loads, 1);
  } finally { db.close(); }
});

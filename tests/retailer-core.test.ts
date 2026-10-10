import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, rows } from '../src/database.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import { calendarWeekEnd } from '../src/price-freshness.ts';
import { collectReference } from '../src/retailers/collection.ts';
import { approvedObservations, cachedIngredientPolicy, productIdentity, reviewedProductPolicy } from '../src/retailers/identity.ts';
import type { ReviewedConnection } from '../src/retailers/identity.ts';
import { LocalProductResolver, MemoryObservationCache } from '../src/retailers/resolver.ts';
import { configureRetailDataset, publishRetailObservations, readRetailObservations, retailSchema } from '../src/retailers/storage.ts';
import type { RetailDataset } from '../src/retailers/storage.ts';
import { RetailerUnsupportedError } from '../src/retailers/types.ts';
import type { ProductObservation, RetailCategory, RetailClient, RetailPage, StoreScope } from '../src/retailers/types.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/demo-coop.json', import.meta.url), 'utf8')) as RetailDataset & { sourceMarker: string; generatedAt: string };
const now = () => Date.now();
const scope: StoreScope = { storeId: 'fixture-store', channel: 'pickup' };

test('product identity survives checkpoint key reordering and detects package changes', () => {
  const product = fixture.observations[0].product;
  const pack = {quantity:500,unit:'g' as const,approximate:false};
  const original = {...product,pack};
  const reordered = {...product,pack:{approximate:false,unit:'g' as const,quantity:500,drainedGrams:null}};
  assert.equal(productIdentity(original),productIdentity(reordered));
  assert.notEqual(productIdentity(original),productIdentity({...original,pack:{...pack,quantity:750}}));
  assert.notEqual(productIdentity(original),productIdentity({...original,pack:{...pack,drainedGrams:300}}));
});

test('memoized identity and dietary checks invalidate when reviewed product evidence changes', () => {
  const product = { id: 'cache-test', ean: null, name: 'Cucumber', brand: null, categories: ['Vegetables'],
    pack: { quantity: 300, unit: 'g' as const, approximate: false }, ingredientsText: 'Cucumber, water' };
  const original = productIdentity(product);
  assert.equal(productIdentity(product), original);
  product.name = 'Wine cucumber';
  assert.notEqual(productIdentity(product), original);

  const policyProduct = { name: 'Cucumber', brand: null as string|null, categories: ['Vegetables'], ingredientsText: 'Water, vinegar' };
  assert.equal(reviewedProductPolicy(policyProduct), null);
  policyProduct.ingredientsText = 'Water, white wine';
  assert.match(reviewedProductPolicy(policyProduct) ?? '', /alcohol/);
  assert.match(reviewedProductPolicy({ ...policyProduct, categories: [...policyProduct.categories] }) ?? '', /alcohol/);
  policyProduct.ingredientsText = 'Water';
  policyProduct.categories.push('Kött');
  assert.match(reviewedProductPolicy(policyProduct, 'beef') ?? '', /meat_brand/);
  assert.equal(cachedIngredientPolicy('vinegar').blockedReason, null);
  assert.equal(cachedIngredientPolicy('white wine').blockedReason, 'alcohol');
});

function freshDataset(at = now()): RetailDataset & { sourceMarker: string; generatedAt: string } {
  const checkedAt = new Date(at - 60_000).toISOString();
  const expiresAt = new Date(at + 23 * 60 * 60_000).toISOString();
  return { ...structuredClone(fixture), observations: fixture.observations.map(o => ({ ...o, checkedAt, expiresAt })) };
}
function setup() {
  const db = new LocalDatabase(':memory:');
  db.execute(retailSchema());
  return db;
}
async function scalar(db: LocalDatabase, sql: string): Promise<number> {
  const result = await rows(db, sql);
  return Number(Object.values(result[0] ?? {})[0] ?? 0);
}
async function publishFresh(db: LocalDatabase, data = freshDataset(), at = now()) {
  await configureRetailDataset(db, data);
  return publishRetailObservations(db, data.retailer, data.scope, data.observations,
    data.observations.map(o => o.product.id).sort(), at);
}
function cloneObservation(o: ProductObservation, patch: Partial<ProductObservation> = {}): ProductObservation {
  return { ...structuredClone(o), ...patch };
}

function fakeClient(options: {
  capabilities?: Partial<RetailClient['capabilities']>;
  categories?: () => Promise<Awaited<ReturnType<RetailClient['categories']>>>;
  browse?: (scope: StoreScope, categoryId: string, cursor?: string) => Promise<RetailPage>;
  products?: (scope: StoreScope, ids: string[]) => Promise<ProductObservation[]>;
} = {}): RetailClient {
  const capabilities: RetailClient['capabilities'] = { stores: true, categories: true, browse: true,
    productLookup: true, batchLookup: true, verifiedStorePricing: true, notes: [], ...options.capabilities };
  return { retailer: 'coop', capabilities,
    async stores() { return []; },
    async categories(s) { return options.categories ? options.categories() : [{ id: 'grain', name: 'Grain', children: [] }]; },
    async browse(s, id, cursor) {
      if (!options.browse) throw new Error('unexpected_browse');
      return options.browse(s, id, cursor);
    },
    async products(s, ids) { return options.products ? options.products(s, ids) : []; },
  };
}

test('demo dataset is conspicuously synthetic and contains reviewed everyday ingredients', () => {
  assert.match(fixture.sourceMarker, /SYNTHETIC OFFLINE FIXTURE ONLY/);
  assert.match(fixture.datasetId, /^demo-fixture-only-/);
  assert.equal(fixture.generatedAt.slice(0, 10), '2026-10-08');
  assert.deepEqual(fixture.connections.map(c => c.name), ['rice', 'onion', 'eggs', 'water']);
  assert.ok(fixture.connections.every(c => c.policyVersion === DIETARY_POLICY_VERSION));
  assert.ok(fixture.connections.filter(c => c.status === 'matched').every(c => c.approvedProducts.length <= 3));
});

test('configure is idempotent; unchanged publish writes only run and active-scope metadata', async () => {
  const db = setup();
  try {
    const data = freshDataset();
    await configureRetailDataset(db, data);
    const afterConfigure = await scalar(db, 'SELECT total_changes() AS n');
    await configureRetailDataset(db, data);
    assert.equal(await scalar(db, 'SELECT total_changes() AS n'), afterConfigure);

    const first = await publishRetailObservations(db, data.retailer, data.scope, data.observations,
      data.observations.map(o => o.product.id).sort(), Date.parse(data.observations[0].checkedAt) + 60_000);
    assert.equal(first.changed, 3);
    assert.equal(first.priceChanges, 3);
    const beforeUnchanged = await scalar(db, 'SELECT total_changes() AS n');
    const second = await publishRetailObservations(db, data.retailer, data.scope, data.observations,
      data.observations.map(o => o.product.id).sort(), Date.parse(data.observations[0].checkedAt) + 60_000);
    assert.equal(second.changed, 0);
    assert.equal(second.unchanged, 3);
    assert.equal(second.priceChanges, 0);
    assert.equal((await scalar(db, 'SELECT total_changes() AS n')) - beforeUnchanged, 2);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM retail_price_history'), 3);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM retail_runs'), 2);
    const current = await readRetailObservations(db, data.retailer, data.scope, data.observations.map(o => o.product.id));
    assert.equal(current.length, 3);
  } finally { db.close(); }
});

test('changed product and price append one history row while partial refresh leaves the active run untouched', async () => {
  const db = setup();
  try {
    const data = freshDataset();
    await configureRetailDataset(db, data);
    const at = Date.parse(data.observations[0].checkedAt) + 60_000;
    const first = await publishRetailObservations(db, data.retailer, data.scope, data.observations,
      data.observations.map(o => o.product.id).sort(), at);
    const rice = data.observations[0];
    const changed = data.observations.map(o => o.product.id !== rice.product.id ? o : ({ ...o,
      checkedAt: new Date(at + 60_000).toISOString(), expiresAt: new Date(at + 23 * 60 * 60_000).toISOString(),
      product: { ...o.product, name: 'Demo Long Grain Rice 1 kg changed' },
      price: { ...o.price!, amountOre: o.price!.amountOre + 75 },
    }));
    const second = await publishRetailObservations(db, data.retailer, data.scope, changed,
      changed.map(o => o.product.id).sort(), at + 60_000);
    assert.equal(second.changed, 1);
    assert.equal(second.priceChanges, 1);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM retail_price_history'), 4);

    const activeBefore = (await rows(db, 'SELECT active_run_id FROM retail_scope_state'))[0].active_run_id;
    const runCountBefore = await scalar(db, 'SELECT COUNT(*) FROM retail_runs');
    const historyBefore = await scalar(db, 'SELECT COUNT(*) FROM retail_price_history');
    await assert.rejects(publishRetailObservations(db, data.retailer, data.scope, changed.slice(0, 2),
      changed.map(o => o.product.id).sort(), at + 120_000), /incomplete_tracked_refresh/);
    assert.equal((await rows(db, 'SELECT active_run_id FROM retail_scope_state'))[0].active_run_id, activeBefore);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM retail_runs'), runCountBefore);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM retail_price_history'), historyBefore);
    assert.ok(first.id);
  } finally { db.close(); }
});

test('configuration and publication reject a different store or channel scope', async () => {
  const db = setup();
  try {
    const data = freshDataset();
    await configureRetailDataset(db, data);
    await assert.rejects(configureRetailDataset(db, { ...data, scope: { storeId: 'other-store', channel: 'pickup' } }), /retail_database_scope_mismatch/);
    await assert.rejects(publishRetailObservations(db, data.retailer, { ...data.scope, channel: 'delivery' },
      data.observations, data.observations.map(o => o.product.id).sort()), /retail_database_scope_mismatch/);
    assert.equal((await rows(db, "SELECT value FROM retail_meta WHERE key='reference_scope'"))[0].value,
      JSON.stringify(['coop', 'fixture-store', 'pickup', null]));
  } finally { db.close(); }
});

test('approved identity changes, stale prices, member prices, and minimum-quantity prices are excluded', () => {
  const data = freshDataset();
  const connection = data.connections.find(c => c.ingredientId === 'fixture-rice') as ReviewedConnection;
  const original = data.observations.find(o => o.product.id === 'demo-rice-1kg')!;
  const at = now();
  const renamed = cloneObservation(original, { product: { ...original.product, name: 'Different rice product' } });
  assert.deepEqual(approvedObservations(connection, [renamed], data.retailer, data.scope, at), []);

  const valid = cloneObservation(original, { checkedAt: new Date(at - 60_000).toISOString(), expiresAt: new Date(at + 60_000).toISOString() });
  const stale = cloneObservation(valid, { expiresAt: new Date(at - 1).toISOString() });
  const member = cloneObservation(valid, { price: { ...valid.price!, memberOnly: true } });
  const minimum = cloneObservation(valid, { price: { ...valid.price!, minimumQuantity: 2 } });
  const old = cloneObservation(valid, { checkedAt: new Date(calendarWeekEnd(at - 7 * 86_400_000) - 1).toISOString() });
  assert.deepEqual(approvedObservations(connection, [valid, stale, member, minimum, old], data.retailer, data.scope, at).map(o => o.product.id), [valid.product.id]);
});

test('reference collection validates complete category totals and detects pagination loops', async () => {
  const data = freshDataset();
  const first = data.observations[0], second = data.observations[1];
  const pages: RetailPage[] = [
    { categoryId: 'grain', scope, total: 2, products: [first], nextCursor: 'page-2' },
    { categoryId: 'grain', scope, total: 2, products: [second], nextCursor: null },
  ];
  let browseCalls = 0;
  const client = fakeClient({ browse: async (_scope, _id, cursor) => pages[cursor ? 1 : 0] });
  const collected = await collectReference(client, scope, { onPage: () => { browseCalls++; } });
  assert.equal(collected.products.length, 2);
  assert.equal(collected.pages, 2);
  assert.equal(collected.categories[0].collected, 2);
  assert.equal(browseCalls, 2);

  let loopCalls = 0;
  const loop = fakeClient({ browse: async () => {
    loopCalls++;
    return { categoryId: 'grain', scope, total: null, products: [loopCalls === 1 ? first : second], nextCursor: 'same-cursor' };
  } });
  await assert.rejects(collectReference(loop, scope), /pagination_cursor_loop/);
  assert.equal(loopCalls, 2);

  const incomplete = fakeClient({ browse: async () => ({ categoryId: 'grain', scope, total: 2, products: [first], nextCursor: null }) });
  await assert.rejects(collectReference(incomplete, scope), /incomplete_category/);
});

test('unsupported reference scan refuses before calling the client', async () => {
  let calls = 0;
  const client = fakeClient({ capabilities: { categories: false, browse: false, verifiedStorePricing: false },
    categories: async () => { calls++; return []; }, browse: async () => { calls++; throw new Error('should_not_fetch'); } });
  await assert.rejects(collectReference(client, scope), (error: unknown) => error instanceof RetailerUnsupportedError && error.operation === 'complete_store_scan');
  assert.equal(calls, 0);
});

test('shared navigation categories scan once while conflicts and cycles stop before browse',async()=>{
  const data=freshDataset(),product=data.observations[0];
  const shared={id:'shared',name:'Shared leaf',children:[]};
  let calls=0;
  const client=fakeClient({categories:async()=>[
    {id:'a',name:'A',children:[shared]},
    {id:'b',name:'B',children:[{...shared}]},
  ],browse:async(_s,id)=>{calls++;return{categoryId:id,scope,total:1,nextCursor:null,products:[product]};}});
  const scan=await collectReference(client,scope);
  assert.equal(calls,1);assert.equal(scan.categories.length,1);assert.equal(scan.products.length,1);
  const conflict=fakeClient({categories:async()=>[shared,{...shared,children:[{id:'hidden',name:'Hidden',children:[]}]}],
    browse:async()=>{throw new Error('should_not_browse');}});
  await assert.rejects(collectReference(conflict,scope),/conflicting_category_definition/);
  const cycle:RetailCategory={id:'loop',name:'Loop',children:[]};cycle.children.push(cycle);
  const cyclic=fakeClient({categories:async()=>[cycle],browse:async()=>{throw new Error('should_not_browse');}});
  await assert.rejects(collectReference(cyclic,scope),/duplicate_category_or_cycle/);
});

test('a product in two categories is merged without hiding real product or price changes',async()=>{
  const data=freshDataset(),first=data.observations[0];
  const categories=async()=>[{id:'a',name:'A',children:[]},{id:'b',name:'B',children:[]}];
  const client=fakeClient({categories,browse:async(_s,id)=>({categoryId:id,scope,total:1,nextCursor:null,
    products:[{...first,product:{...first.product,categories:[id]}}]})});
  const scan=await collectReference(client,scope);assert.equal(scan.products.length,1);
  assert.deepEqual(scan.products[0].product.categories,['a','b']);
  const changing=fakeClient({categories,browse:async(_s,id)=>({categoryId:id,scope,total:1,nextCursor:null,
    products:[{...first,price:{...first.price!,amountOre:first.price!.amountOre+(id==='b'?1:0)}}]})});
  await assert.rejects(collectReference(changing,scope),/product_changed_during_scan/);
});

test('resolver reuses a warm observation cache for a reviewed connection', async () => {
  const data = freshDataset();
  const connection = data.connections.find(c => c.ingredientId === 'fixture-rice') as ReviewedConnection;
  const observation = data.observations.find(o => o.product.id === 'demo-rice-1kg')!;
  let calls = 0;
  const client = fakeClient({ capabilities: { batchLookup: false }, products: async (_scope, ids) => {
    calls++;
    return data.observations.filter(o => ids.includes(o.product.id));
  } });
  const resolver = new LocalProductResolver(client, new MemoryObservationCache());
  const at = now();
  const first = await resolver.resolve(scope, [connection], at);
  const second = await resolver.resolve(scope, [connection], at);
  assert.equal(calls, 1);
  assert.deepEqual(first.eligible.get(connection.ingredientId)?.map(o => o.product.id), [observation.product.id]);
  assert.deepEqual(second.eligible.get(connection.ingredientId)?.map(o => o.product.id), [observation.product.id]);
});

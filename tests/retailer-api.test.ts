import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, rows } from '../src/database.ts';
import { productIdentity, type ReviewedConnection } from '../src/retailers/identity.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import { scanIsCurrent } from '../src/price-freshness.ts';
import { retailSchema, configureRetailDataset, publishRetailObservations, type RetailDataset } from '../src/retailers/storage.ts';
import { MemoryObservationCache } from '../src/retailers/resolver.ts';
import { scopeKey, type ProductObservation, type RetailClient, type StoreScope } from '../src/retailers/types.ts';
import { retailMealQuote, retailerRoutes, WorkerQuoteResponseCache, type QuoteResponseCache, type RecipeDocument, type RecipeLoader, type RetailEnv } from '../worker/retailers.ts';

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

function d1WithConflictingDuplicateObservation(db: LocalDatabase): D1Database {
  const base = d1(db);
  return { prepare(sql: string) {
    const statement = base.prepare(sql) as any;
    if (sql.toLowerCase().includes('from retail_products')) {
      const all = statement.all.bind(statement);
      statement.all = async () => {
        const response = await all();
        const rice = response.results.find((row: any) => JSON.parse(row.observation_json).product.id === 'demo-rice-1kg');
        if (!rice) return response;
        const observation = JSON.parse(rice.observation_json);
        observation.product.name = 'Conflicting duplicate identity';
        return { ...response, results: [...response.results, { observation_json: JSON.stringify(observation) }] };
      };
    }
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
  dependencies?: { client?: RetailClient; cache?: MemoryObservationCache; quoteCache?: QuoteResponseCache }) {
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

test('expired cheap approved alternative does not shorten the validity of the selected basket', async () => {
  const data = fixture();
  const rice = data.observations.find(o => o.product.id === 'demo-rice-1kg')!;
  const now = Date.now();
  const alternateId = 'demo-rice-expired-promo';
  const alternate = structuredClone(rice);
  alternate.product = { ...alternate.product, id: alternateId };
  alternate.checkedAt = new Date(now - 60 * 60_000).toISOString();
  alternate.price = { ...alternate.price!, amountOre: 1, validUntil: new Date(now - 1_000).toISOString() };
  alternate.expiresAt = new Date(now + 30 * 60_000).toISOString();
  data.observations.push(alternate);
  const riceConnection = data.connections.find(c => c.mainProductId === rice.product.id)!;
  riceConnection.approvedProducts.push({ productId: alternateId, identity: productIdentity(alternate.product) });
  const { db } = await seed(data);
  try {
    const documents = new Map<number, RecipeDocument>([[1, recipe([
      { ingredient_original: 'rice', unit: 'g', measured_quantity: 100 },
    ])]]);
    const response = await quote(db, data, { retailer: 'coop', recipes: [{ recipeId: 1 }] }, documents);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.basket.complete, true);
    assert.equal(body.basket.lines[0].productId, 'demo-rice-1kg');
    assert.ok(Date.parse(body.earliestPriceExpiry) > Date.now());
  } finally { db.close(); }
});

test('local complete quote cache hits without a local run and rechecks source, mappings, reference run, and price window', async () => {
  const data = fixture();
  const priceBoundary = Date.now() + 5 * 60_000;
  data.observations.find(o => o.product.id === 'demo-rice-1kg')!.price!.validUntil = new Date(priceBoundary).toISOString();
  const { db } = await seed(data);
  const entries = new Map<string,{body:string;expiresAt:number}>();
  const quoteCache: QuoteResponseCache = {
    available: true,
    async match(key, now) {
      const entry = entries.get(key);
      return entry && entry.expiresAt > now
        ? new Response(entry.body,{status:200,headers:{'X-Quote-Cache-Expires':String(entry.expiresAt)}}) : null;
    },
    async put(key, response, expiresAt) { entries.set(key,{body:await response.text(),expiresAt}); },
  };
  const documents = new Map<number,RecipeDocument>([[1,recipe([{ingredient_original:'rice',unit:'g',measured_quantity:100}])]]);
  const localProducts = new Map<string,ProductObservation['product']>();
  const {client} = sourceClient(data,{localProducts});
  let loaderCalls = 0;
  const load = async (ids:number[]) => { loaderCalls++; return new Map(ids.flatMap(id=>documents.has(id)?[[id,documents.get(id)!] as const]:[])); };
  const body = {retailer:'coop',priceMode:'local',storeId:localScope.storeId,channel:localScope.channel,recipes:[{recipeId:1}]};
  const runQuote = () => retailMealQuote(env(db),manifest,body,load,{quoteCache,client});
  try {
    const first = await runQuote();
    assert.equal(first.status,200);
    const firstBody = await first.json() as any;
    assert.equal(firstBody.basket.complete,true);
    assert.equal(loaderCalls,1);
    assert.equal(entries.size,1);
    assert.ok([...entries.values()][0].expiresAt <= priceBoundary);

    const second = await runQuote();
    assert.equal(second.status,200);
    assert.equal(second.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(await second.json(),firstBody);
    assert.equal(loaderCalls,1,'a valid exact-body hit bypasses recipe and quote work');

    const disabled = await retailMealQuote(env(db),manifest,body,load,{quoteCache});
    assert.equal(disabled.status,503,'disabled live pricing must block before any cache hit');
    assert.deepEqual(await disabled.json(),{error:'retailer_live_lookups_disabled'});
    assert.equal(loaderCalls,1);

    const reference = data.observations.find(o=>o.product.id==='demo-rice-1kg')!.product;
    const connection = data.connections.find(c=>c.approvedProducts.some(p=>p.productId===reference.id))!;
    const localProduct = {...reference,id:'cache-local-rice'};
    localProducts.set(localProduct.id,localProduct);
    const mapping = {referenceProductId:reference.id,referenceIdentity:connection.approvedProducts.find(p=>p.productId===reference.id)!.identity,
      localProduct,checkedAt:new Date().toISOString()};
    await db.query('INSERT INTO retail_local_mappings VALUES(?,?,?,?,?)',[
      scopeKey('coop',localScope),reference.id,localProduct.id,JSON.stringify(mapping),mapping.checkedAt,
    ]);
    const afterMappingChange = await runQuote();
    assert.equal(afterMappingChange.status,200);
    const mappedBody = await afterMappingChange.json() as any;
    assert.equal(mappedBody.basket.lines[0].productId,'cache-local-rice');
    assert.equal(loaderCalls,2,'a local mapping change invalidates the response');

    await publishRetailObservations(db,'coop',data.scope,data.observations,data.observations.map(o=>o.product.id),Date.now());
    const afterRunChange = await runQuote();
    assert.equal(afterRunChange.status,200);
    await afterRunChange.json();
    assert.equal(loaderCalls,3,'a new reference active run invalidates the cached quote');
  } finally { db.close(); }
});

test('quote caching preserves unknown amounts and an explicit amount override invalidates the result', async () => {
  const {db} = await seed();
  const entries = new Map<string,{body:string;expiresAt:number}>();
  const quoteCache: QuoteResponseCache = {
    available:true,
    async match(key,now) { const entry=entries.get(key);return entry&&entry.expiresAt>now?new Response(entry.body):null; },
    async put(key,response,expiresAt) { entries.set(key,{body:await response.text(),expiresAt}); },
  };
  const document=recipe([{ingredient_original:'rice',unit:'g',measured_quantity:null}]);
  let calls=0;
  const load=async()=>{calls++;return new Map([[1,document]]);};
  const body={retailer:'coop',recipes:[{recipeId:1}]};
  try {
    const first=await (await retailMealQuote(env(db),manifest,body,load,{quoteCache})).json() as any;
    assert.equal(first.basket.complete,false);
    assert.equal(first.basket.purchaseCostOre,null);
    assert.equal(first.basket.unresolved[0].reason,'quantity_unknown_or_invalid');
    assert.equal(entries.size,1);
    assert.deepEqual(await (await retailMealQuote(env(db),manifest,body,load,{quoteCache})).json(),first);
    assert.equal(calls,1);
    const override={...body,recipes:[{recipeId:1,amountOverrides:{'0':{unit:'g',quantity:100}}}]};
    const resolved=await (await retailMealQuote(env(db),manifest,override,load,{quoteCache})).json() as any;
    assert.equal(resolved.basket.complete,true);
    assert.equal(resolved.basket.purchaseCostOre,1990);
    assert.equal(calls,2);
  } finally {db.close();}
});

test('optional in-memory quote cache is bounded, expires entries, and returns independent responses offline', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:undefined});
  try {
    assert.equal(new WorkerQuoteResponseCache().available,false,'default remains disabled without Cache API');
    const cache = new WorkerQuoteResponseCache({memoryEnabled:true});
    assert.equal(cache.available,true);
    const expiresAt = Date.now()+60_000;

    await cache.put('first',new Response('{"value":1}',{headers:{'Content-Type':'application/json'}}),expiresAt);
    const firstResponse = await cache.match('first',Date.now());
    assert.ok(firstResponse);
    firstResponse!.headers.set('X-Caller-Mutation','yes');
    assert.deepEqual(await (await cache.match('first',Date.now()))!.json(),{value:1},'each hit gets a fresh response body and headers');
    assert.equal((await cache.match('first',Date.now()))!.headers.has('X-Caller-Mutation'),false);
    assert.equal(await cache.match('first',expiresAt),null,'expiry is checked on every hit');

    for(let index=0;index<65;index++) await cache.put(`entry-${index}`,new Response(`v${index}`),expiresAt);
    assert.equal(await cache.match('entry-0',Date.now()),null,'the oldest entry is evicted after the 64-entry cap');
    assert.ok(await cache.match('entry-64',Date.now()));

    const oversized = 'x'.repeat(256*1024+1);
    await cache.put('oversized',new Response(oversized),expiresAt);
    await cache.put('oversized-key-'+'k'.repeat(64*1024),new Response('v'),expiresAt);
    assert.equal(await cache.match('oversized',Date.now()),null,'entries above the per-body limit are skipped');
    assert.equal(await cache.match('oversized-key-'+'k'.repeat(64*1024),Date.now()),null,'oversized keys are skipped');

    const large='z'.repeat(250*1024);
    for(let index=0;index<18;index++) await cache.put(`large-${index}`,new Response(large),expiresAt);
    assert.equal(await cache.match('large-0',Date.now()),null,'the aggregate four-MiB limit evicts oldest entries');
    assert.ok(await cache.match('large-17',Date.now()));
  } finally {
    if(original) Object.defineProperty(globalThis,'caches',original);
    else delete (globalThis as {caches?:unknown}).caches;
  }
});

test('oversized cloned quote body does not await the unread original response branch', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:undefined});
  try {
    const cache = new WorkerQuoteResponseCache({memoryEnabled:true});
    const payload='x'.repeat(300*1024);
    const response=new Response(payload);
    const pending=cache.put('too-large',response.clone(),Date.now()+60_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completedBeforeOriginalConsumed=await Promise.race([
      pending.then(()=>true),
      new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),100);}),
    ]);
    if(timer)clearTimeout(timer);
    assert.equal(completedBeforeOriginalConsumed,true,'cache rejection must not wait for the original tee branch');
    assert.equal(await response.text(),payload,'the cache must leave the caller response readable');
    assert.equal(await cache.match('too-large',Date.now()),null);
  } finally {
    if(original) Object.defineProperty(globalThis,'caches',original);
    else delete (globalThis as {caches?:unknown}).caches;
  }
});

test('enabled environment quote cache is used even when the Cache API is unavailable', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:undefined});
  const data=fixture();
  const {db}=await seed(data);
  try {
    const cache = new WorkerQuoteResponseCache({memoryEnabled:true});
    const documents = new Map<number,RecipeDocument>([[1,recipe([{ingredient_original:'rice',unit:'g',measured_quantity:100}])]]);
    let loads=0;
    const load:RecipeLoader=async ids=>{loads++;return loader(documents)(ids);};
    const quoteEnv=env(db,{COMPUTE_QUOTE_CACHE:cache});
    const body={retailer:'coop',recipes:[{recipeId:1}]};
    const first=await retailMealQuote(quoteEnv,manifest,body,load);
    assert.equal(first.status,200);
    const expected=await first.json();
    const second=await retailMealQuote(quoteEnv,manifest,body,load);
    assert.deepEqual(await second.json(),expected);
    assert.equal(loads,1,'the enabled isolate cache bypasses quote loading on a valid exact hit');
  } finally {
    db.close();
    if(original) Object.defineProperty(globalThis,'caches',original);
    else delete (globalThis as {caches?:unknown}).caches;
  }
});

test('a conflicting duplicate observation keeps its approved product ineligible', async () => {
  const { db, data } = await seed();
  try {
    const docs = new Map<number, RecipeDocument>([[1, recipe([{ ingredient_original: 'rice', unit: 'g', measured_quantity: 100 }])]]);
    const response = await retailMealQuote({ COOP_DB: d1WithConflictingDuplicateObservation(db) }, manifest,
      { retailer: 'coop', recipes: [{ recipeId: 1 }] }, loader(docs));
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.basket.complete, false);
    assert.equal(body.basket.lines.length, 0);
    assert.equal(body.basket.unresolved[0].reason, 'no_approved_compatible_product');
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
  const realNow=Date.now;
  Date.now=()=>Date.parse('2026-10-10T12:00:00.000Z');
  let db:LocalDatabase|undefined;
  try {
    const seeded=await seed();
    db=seeded.db;
    const {data}=seeded;
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
    const checkedAt = new Date(Date.now()-25*60*60_000).toISOString();
    assert.equal(scanIsCurrent(Date.parse(checkedAt)),true,'the legacy run timestamp remains in the active calendar week');
    await db.query('UPDATE retail_runs SET checked_at=?,expires_at=?',[checkedAt,new Date(Date.now()-1).toISOString()]);
    const legacy = await (await retailerRoutes(valid,env(db))).json() as any;
    assert.equal(legacy.products[0].fresh,true,'checked_at under the weekly policy overrides the old 24-hour run expiry');
    assert.equal(legacy.products[0].publicPriceUsable,true);

    const stored = JSON.parse(String((await rows(db,'SELECT observation_json FROM retail_products WHERE product_id=?',['demo-rice-1kg']))[0].observation_json));
    stored.price.validUntil = new Date(Date.now()-1).toISOString();
    await db.query('UPDATE retail_products SET observation_json=? WHERE product_id=?',[JSON.stringify(stored),'demo-rice-1kg']);
    const campaignExpired = await (await retailerRoutes(valid,env(db))).json() as any;
    assert.equal(campaignExpired.products[0].fresh,false,'campaign validUntil continues to constrain the stored observation');
    assert.equal(campaignExpired.products[0].publicPriceUsable,false);
    assert.equal((await retailerRoutes(new Request('https://worker.test/retailers/ica/products?ids=demo-rice-1kg'),env(db))).status,503);
  } finally {db?.close();Date.now=realNow;}
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

test('local quote handles the full three-finalist name, observation, and recipe-row caps offline', async (t) => {
  const now = Date.now(), scope: StoreScope = { storeId: 'perf-store', channel: 'pickup' };
  const observations: ProductObservation[] = [];
  const connections: ReviewedConnection[] = [];
  for (let index = 0; index < 200; index++) {
    const suffix = String(index).padStart(3, '0'), name = `ingredient ${suffix}`;
    const approvedProducts = [];
    for (const variant of ['a', 'b']) {
      const id = `perf-${suffix}-${variant}`;
      const product: ProductObservation['product'] = { id, ean: null, name: `Ingredient ${suffix} standard ${variant}`,
        brand: null, categories: ['Skafferi'], pack: { quantity: 1000, unit: 'g', approximate: false }, ingredientsText: null };
      const observation: ProductObservation = { retailer: 'coop', scope, product,
        price: { amountOre: variant === 'a' ? 200 : 250, basis: 'pack', depositOre: 0, memberOnly: false,
          minimumQuantity: null, validFrom: null, validUntil: null }, availability: 'available',
        checkedAt: new Date(now - 30_000).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), storeScopeVerified: true };
      observations.push(observation);
      approvedProducts.push({ productId: id, identity: productIdentity(product) });
    }
    connections.push({ ingredientId: `perf-ing-${suffix}`, name, foodId: null, status: 'matched',
      mainProductId: approvedProducts[0].productId, approvedProducts, policyVersion: DIETARY_POLICY_VERSION,
      reviewedAt: new Date(now - 60_000).toISOString(), reason: 'Synthetic performance test identity only.' });
  }
  const perfManifest = { datasetId: 'offline-full-cap-perf', inventoryHash: 'full-cap-performance-fixture' };
  const data: RetailDataset = { retailer: 'coop', scope, ...perfManifest, observations, connections };
  const observationById = new Map(observations.map(o => [o.product.id, o]));
  const db = database();
  await configureRetailDataset(db, data);
  await publishRetailObservations(db, 'coop', scope, observations, observations.map(o => o.product.id), now);
  assert.equal((await rows(db, 'SELECT COUNT(*) AS count FROM retail_tracked'))[0].count, 400);
  const documents = new Map<number, RecipeDocument>();
  for (let finalist = 1; finalist <= 3; finalist++) {
    documents.set(finalist, recipe(Array.from({ length: 500 }, (_, row) => ({
      ingredient_original: `ingredient ${String(row % 200).padStart(3, '0')}`, unit: 'g', measured_quantity: 1,
    }))));
  }
  const client: RetailClient = {
    retailer: 'coop', capabilities: { stores: true, categories: true, browse: false, productLookup: true,
      batchLookup: true, verifiedStorePricing: true, notes: [] },
    async stores() { throw new Error('not used'); }, async categories() { throw new Error('not used'); },
    async browse() { throw new Error('not used'); },
    async products(requestedScope, ids) { return ids.map(id => ({
      ...observationById.get(id)!,
      scope: requestedScope, checkedAt: new Date(Date.now() - 30_000).toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() })); },
  };
  try {
    const started = performance.now();
    const response = await retailMealQuote(env(db), perfManifest,
      { retailer: 'coop', priceMode: 'local', storeId: scope.storeId, channel: scope.channel,
        finalists: [1, 2, 3].map(id => ({ id: `menu-${id}`, recipes: [{ recipeId: id }] })) },
      loader(documents), { client, cache: new MemoryObservationCache() });
    const elapsedMs = performance.now() - started;
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.finalists.length, 3);
    assert.deepEqual(body.finalists.map((f: any) => f.id), ['menu-1', 'menu-2', 'menu-3']);
    assert.ok(body.finalists.every((f: any) => f.basket.workExplored <= 6666));
    assert.ok(body.finalists.every((f: any) => f.basket.statesExplored <= 333));
    assert.ok(body.finalists.every((f: any) => f.referenceCostOre === 40_000));
    assert.ok(body.finalists.every((f: any) => f.basket.complete && f.basket.optimizationComplete));
    assert.equal(body.priceSource, 'local-webshop');
    t.diagnostic(`full-cap local quote route: ${elapsedMs.toFixed(1)} ms offline Node wall; finalists work/states/complete=${body.finalists
      .map((f: any) => `${f.basket.workExplored}/${f.basket.statesExplored}/${f.basket.complete}`).join(',')}`);
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

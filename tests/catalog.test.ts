import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, D1DatabaseClient, rows } from '../src/database.ts';
import { normalize, moneyOre } from '../src/products.ts';
import { crawl } from '../src/crawl.ts';
import { publish } from '../src/publish.ts';
import { catalogStorageSchema, seedCatalogStorage } from '../src/catalog-storage.ts';
import { WillysClient, inVisitWindow, validatePage } from '../src/willys.ts';
import { cloudflare } from '../scripts/helpers.ts';
import worker, { handle, packPrice, expiresAt } from '../worker/index.ts';
import type { Category, Database, Page, Scan, SourceProduct, Store } from '../src/types.ts';

const raw = (code = 'TEST_1_ST', price = 16.9): SourceProduct => ({ code, name: 'Test product', priceValue: price,
  priceUnit: 'kr/st', depositPrice: '', online: true, outOfStock: false, addToCartDisabled: false, potentialPromotions: [] });
const store: Store = { storeId: '2110', name: 'TEST store', onlineStore: true };
const category: Category = { id: 'N1', title: 'Test', url: 'test', valid: true, children: [] };
const tree: Category = { ...category, children: [category] };
function page(results: SourceProduct[], currentPage = 0, total = results.length, pageSize = Math.max(1, results.length)): Page {
  return { results, pagination: { currentPage, pageSize, numberOfPages: Math.ceil(total / pageSize), totalNumberOfResults: total } };
}
function fixtureSource(pages: Page[], categoryTree = tree) {
  return { requests: 0, async initialize() { return store; }, async verifyStore() { return store; },
    async categories() { return categoryTree; }, async category(_path: string, number: number) { return pages[number]; } };
}
function scan(products: SourceProduct[], offset = 0): Scan {
  const date = new Date(Date.now() + offset).toISOString();
  return { store, entries: products.map(p => normalize(p, 'Test', date)), categories: [], requests: 0, startedAt: date, completedAt: date };
}
function database() {
  const db = new LocalDatabase(':memory:');
  db.execute(readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8'));
  db.execute(catalogStorageSchema());
  return db;
}
function workerDb(db: LocalDatabase): D1Database {
  return { prepare(sql: string) {
    let params: Array<string | number | null> = [];
    const statement = { bind(...values: typeof params) { params = values; return statement; },
      async first() { return (await rows(db, sql, params))[0] ?? null; },
      async all() { return { results: await rows(db, sql, params), success: true }; } };
    return statement;
  } } as unknown as D1Database;
}
function meteredD1(db: LocalDatabase) {
  return new D1DatabaseClient({ accountId: 'a'.repeat(32), databaseId: 'b'.repeat(36), token: 'test-only',
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { sql?: string; params?: unknown[]; batch?: Array<{ sql: string; params?: unknown[] }> };
      const statements = body.batch ?? [{ sql: body.sql!, params: body.params }];
      if (body.batch) db.db.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const statement of statements) {
          const before = Number(db.db.prepare('SELECT total_changes() AS n').get()?.n ?? 0);
          const resultRows = await rows(db, statement.sql, statement.params as Array<string | number | null> | undefined);
          const after = Number(db.db.prepare('SELECT total_changes() AS n').get()?.n ?? 0);
          result.push({ success: true, results: resultRows, meta: { rows_written: after - before, rows_read: resultRows.length, size_after: 1 } });
        }
        if (body.batch) db.db.exec('COMMIT');
        return Response.json({ success: true, result });
      } catch (error) {
        if (body.batch) db.db.exec('ROLLBACK');
        throw error;
      }
    } });
}
const secret = 'test-token-that-is-more-than-thirty-two-characters';
function request(path: string, body?: unknown, token = secret) {
  return new Request(`https://example.test${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('money is stored as integer öre; unknown values stay unknown', () => {
  assert.equal(moneyOre('1 099,90 kr'), 109990); assert.equal(moneyOre(16.9), 1690);
  assert.equal(moneyOre('unexpected'), null); assert.equal(moneyOre(undefined), null); assert.equal(moneyOre(-1), null);
});
test('promotion object order does not create spurious price changes', () => {
  const a = normalize({ ...raw(), potentialPromotions: [{ code: 'B', qualifyingCount: 3 }, { code: 'A', price: 5 }] }, 'A', '2026-01-01');
  const b = normalize({ ...raw(), potentialPromotions: [{ price: 5, code: 'A' }, { qualifyingCount: 3, code: 'B' }] }, 'A', '2026-01-02');
  assert.equal(a.priceHash, b.priceHash);
  assert.notEqual(a.priceHash, normalize(raw('TEST_1_ST', 19), 'A', '2026-01-02').priceHash);
});
test('other source pricing changes are tracked while stock changes are excluded', () => {
  const original = normalize({ ...raw(), memberPrice: 12.9 }, 'Test', '2026-01-01');
  const changed = normalize({ ...raw(), memberPrice: 10.9 }, 'Test', '2026-01-02');
  assert.notEqual(original.priceHash, changed.priceHash);
  assert.equal(original.priceHash, normalize({ ...raw(), memberPrice: 12.9, outOfStock: true }, 'Test', '2026-01-02').priceHash);
  assert.equal(changed.sourcePricing.memberPrice, 10.9);
});
test('crawler completes every page and retains unavailable products', async () => {
  const source = fixtureSource([page([raw(), { ...raw('TEST_2_ST'), outOfStock: true }], 0, 3, 2), page([raw('TEST_3_ST')], 1, 3, 2)]);
  const result = await crawl(source, store.storeId, 20000, () => {});
  assert.equal(result.entries.length, 3); assert.equal(result.entries[1].available, false);
  assert.equal(result.categories[0].collected, 3);
});
test('crawler rejects shifted pagination and an incomplete last page', async () => {
  await assert.rejects(crawl(fixtureSource([page([raw()], 0, 2, 1), page([raw('TEST_2_ST')], 1, 3, 1)]), '2110', 20, () => {}), /changed/);
  await assert.rejects(crawl(fixtureSource([page([raw()], 0, 2, 1), page([], 1, 2, 1)]), '2110', 20, () => {}), /Missing results/);
});
test('crawler detects duplicate pages and never silently truncates', async () => {
  await assert.rejects(crawl(fixtureSource([page([raw()], 0, 2, 1), page([raw()], 1, 2, 1)]), '2110', 20, () => {}), /Duplicate/);
  await assert.rejects(crawl(fixtureSource([page([raw(), raw('TEST_2_ST')])]), '2110', 1, () => {}), /budget/);
});
test('products repeated across categories are deduplicated with both categories', async () => {
  const source = fixtureSource([page([raw()])], { ...tree, children: [category, { ...category, title: 'Other', url: 'other' }] });
  const result = await crawl(source, '2110', 20, () => {});
  assert.equal(result.entries.length, 1); assert.deepEqual(result.entries[0].categories, ['Other', 'Test']);
});
test('pagination boundary validates the real response contract', () => {
  assert.doesNotThrow(() => validatePage(page([raw()]), 0));
  assert.throws(() => validatePage({ ...page([raw()]), pagination: { currentPage: 1 } }, 0));
});
test('initial publication and subsequent changes create compact history', async () => {
  const db = database();
  try {
    const first = await publish(db, scan([raw(), raw('TEST_2_ST')]));
    await publish(db, scan([raw(), raw('TEST_2_ST')], 1000));
    assert.equal((await rows(db, 'SELECT * FROM price_history')).length, 2);
    await publish(db, scan([raw('TEST_1_ST', 20), raw('TEST_2_ST')], 2000));
    assert.equal((await rows(db, 'SELECT * FROM price_history')).length, 3);
    const active = (await rows(db, "SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0].value;
    assert.notEqual(active, first.snapshotId);
    assert.equal((await rows(db, 'SELECT * FROM snapshots')).length, 2);
  } finally { db.close(); }
});
test('unchanged revalidation advances snapshot freshness without rewriting product versions', async () => {
  const db = database();
  try {
    const products = [raw(), raw('TEST_2_ST')];
    const first = await publish(db, scan(products));
    const env = { DB: workerDb(db), CATALOG_API_TOKEN: secret };
    const beforeApi = await (await handle(request('/products/TEST_1_ST'), env)).json() as any;
    const original = (await rows(db, 'SELECT code,content_hash,valid_from FROM catalog_product_versions ORDER BY code'));
    const historyBefore = Number((await rows(db, 'SELECT COUNT(*) AS n FROM price_history'))[0].n);
    const second = await publish(db, scan(products, 1000));
    const after = await rows(db, 'SELECT code,content_hash,valid_from FROM catalog_product_versions ORDER BY code');
    assert.notEqual(second.snapshotId, first.snapshotId);
    assert.deepEqual(after, original);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS n FROM price_history'))[0].n, historyBefore);
    const oldRow = (await rows(db, 'SELECT observed_at,data_json FROM catalog_entries_read WHERE snapshot_id=? AND code=?', [first.snapshotId, 'TEST_1_ST']))[0];
    const newRow = (await rows(db, 'SELECT observed_at,data_json FROM catalog_entries_read WHERE snapshot_id=? AND code=?', [second.snapshotId, 'TEST_1_ST']))[0];
    assert.notEqual(newRow.observed_at, oldRow.observed_at);
    assert.equal(JSON.parse(String(newRow.data_json)).priceOre, JSON.parse(String(oldRow.data_json)).priceOre);
    assert.equal(JSON.parse(String(newRow.data_json)).available, JSON.parse(String(oldRow.data_json)).available);
    const afterApi = await (await handle(request('/products/TEST_1_ST'), env)).json() as any;
    const { observedAt: _beforeObserved, expiresAt: _beforeExpiry, ...beforeStable } = beforeApi;
    const { observedAt: _afterObserved, expiresAt: _afterExpiry, ...afterStable } = afterApi;
    assert.deepEqual(afterStable, beforeStable);
    assert.notEqual(afterApi.observedAt, beforeApi.observedAt);
  } finally { db.close(); }
});
test('unchanged D1 publication reduces mock-reported row reads and writes', async () => {
  const db = database();
  try {
    const products = Array.from({ length: 40 }, (_, i) => raw(`ITEM_${String(i).padStart(3, '0')}_ST`, 10 + i));
    const client = meteredD1(db);
    await publish(client, scan(products));
    const priorWrites = client.rowsWritten;
    const priorReads = client.rowsRead;
    const second = await publish(client, scan(products, 1000));
    const repeatWrites = client.rowsWritten - priorWrites;
    const repeatReads = client.rowsRead - priorReads;
    assert.equal(second.delta?.unchanged, products.length);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_product_versions'))[0].n, products.length);
    assert.ok(repeatWrites < products.length, `expected metadata-scale writes, got ${repeatWrites} for ${products.length} products`);
    assert.ok(repeatReads < products.length, `expected fewer than one returned row per product, got ${repeatReads} for ${products.length} products`);
  } finally { db.close(); }
});
test('price, stock, pack changes and removals create exact temporal deltas', async () => {
  const db = database();
  try {
    const firstProducts = [raw(), raw('STOCK_ST'), raw('PACK_ST'), raw('REMOVE_ST')];
    firstProducts[2].displayVolume = '500g';
    const first = await publish(db, scan(firstProducts));
    const changed = [raw('TEST_1_ST', 19), { ...raw('STOCK_ST'), outOfStock: true }, raw('PACK_ST'), raw('NEW_ST')];
    changed[2].displayVolume = '750g';
    const second = await publish(db, scan(changed, 1000));
    assert.deepEqual(second.delta, { added: 1, updated: 3, removed: 1, unchanged: 0, priceChanges: 2 });
    const current = await rows(db, 'SELECT code,name,price_hash FROM catalog_entries_read WHERE snapshot_id=? ORDER BY code', [second.snapshotId]);
    const previous = await rows(db, 'SELECT code FROM catalog_entries_read WHERE snapshot_id=? ORDER BY code', [first.snapshotId]);
    assert.deepEqual(current.map(row => row.code), ['NEW_ST', 'PACK_ST', 'STOCK_ST', 'TEST_1_ST']);
    assert.deepEqual(previous.map(row => row.code), ['PACK_ST', 'REMOVE_ST', 'STOCK_ST', 'TEST_1_ST']);
    const stock = JSON.parse(String((await rows(db, 'SELECT data_json FROM catalog_entries_read WHERE snapshot_id=? AND code=?', [second.snapshotId, 'STOCK_ST']))[0].data_json));
    assert.equal(stock.available, false);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_product_versions WHERE code=?', ['REMOVE_ST']))[0].n, 1);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS n FROM price_history'))[0].n, 6);
  } finally { db.close(); }
});
test('legacy catalogue snapshots migrate idempotently and keep their read shape', async () => {
  const db = database();
  try {
    const legacy = scan([raw()]);
    await db.query("INSERT INTO snapshots VALUES('legacy','2110','TEST store',?,?,1,'complete','{}')", [legacy.startedAt, legacy.completedAt]);
    const entry = legacy.entries[0];
    const legacyData = { ...entry, price: { priceOre: entry.priceOre, priceUnit: entry.priceUnit,
      comparePriceOre: entry.comparePriceOre, comparePriceUnit: entry.comparePriceUnit,
      depositOre: entry.depositOre, offers: entry.offers, sourcePricing: entry.sourcePricing } };
    await db.query('INSERT INTO catalog_entries VALUES(?,?,?,?,?,?,?)', ['legacy', entry.code, entry.name,
      entry.brand, entry.priceHash, entry.observedAt, JSON.stringify(legacyData)]);
    await db.query("INSERT INTO catalog_state VALUES('active_snapshot','legacy')");
    const before = (await rows(db, 'SELECT code,name,brand,price_hash,observed_at,data_json FROM catalog_entries_read WHERE snapshot_id=?', ['legacy']))[0];
    const migrated = await seedCatalogStorage(db, 'legacy');
    const after = (await rows(db, 'SELECT code,name,brand,price_hash,observed_at,data_json FROM catalog_entries_read WHERE snapshot_id=?', ['legacy']))[0];
    assert.equal(migrated.seeded, true);
    assert.equal(after.code, before.code); assert.equal(after.name, before.name); assert.equal(after.brand, before.brand);
    assert.equal(after.price_hash, before.price_hash); assert.equal(after.observed_at, before.observed_at);
    assert.deepEqual(JSON.parse(String(after.data_json)), JSON.parse(String(before.data_json)));
    assert.equal((await seedCatalogStorage(db, 'legacy')).seeded, false);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_product_versions'))[0].n, 1);
  } finally { db.close(); }
});
test('legacy snapshots seed chronologically as exact temporal deltas with pinned parity', async () => {
  const db = database();
  const saveLegacy = async (id: string, completedAt: string, entries: ReturnType<typeof scan>['entries']) => {
    await db.query("INSERT INTO snapshots VALUES(?,?,?,?,?,?,'complete','{}')", [id, store.storeId, store.name,
      completedAt, completedAt, entries.length]);
    for (const entry of entries) {
      const data = { ...entry, price: { priceOre: entry.priceOre, priceUnit: entry.priceUnit,
        comparePriceOre: entry.comparePriceOre, comparePriceUnit: entry.comparePriceUnit,
        depositOre: entry.depositOre, offers: entry.offers, sourcePricing: entry.sourcePricing } };
      await db.query('INSERT INTO catalog_entries VALUES(?,?,?,?,?,?,?)', [id, entry.code, entry.name,
        entry.brand, entry.priceHash, entry.observedAt, JSON.stringify(data)]);
    }
  };
  const visible = async (id: string) => rows(db, `SELECT code,name,brand,price_hash,observed_at,data_json
    FROM catalog_entries_read WHERE snapshot_id=? ORDER BY code`, [id]);
  const normalizedRows = (result: Array<Record<string, unknown>>) => result.map(row => ({ ...row, data_json: JSON.parse(String(row.data_json)) }));
  try {
    const time1 = '2026-10-01T00:00:00.000Z', time2 = '2026-10-02T00:00:00.000Z';
    const firstEntries = scan([raw('KEEP_ST', 10), raw('CHANGE_ST', 15), raw('REMOVE_ST', 20)]).entries;
    const secondEntries = scan([raw('KEEP_ST', 10), { ...raw('CHANGE_ST', 25), outOfStock: true }, raw('ADD_ST', 30)], 86400000).entries;
    await saveLegacy('legacy-first', time1, firstEntries);
    await saveLegacy('legacy-second', time2, secondEntries);
    await db.query("INSERT INTO price_history VALUES(?,?,?,?,?)", [store.storeId, 'CHANGE_ST', time1, 'sentinel', '{}']);
    const historyBefore = await rows(db, 'SELECT * FROM price_history ORDER BY store_id,code,observed_at');
    const physicalFirstBefore = await rows(db, 'SELECT code,name,brand,price_hash,observed_at,data_json FROM catalog_entries WHERE snapshot_id=? ORDER BY code', ['legacy-first']);
    const physicalSecondBefore = await rows(db, 'SELECT code,name,brand,price_hash,observed_at,data_json FROM catalog_entries WHERE snapshot_id=? ORDER BY code', ['legacy-second']);

    await seedCatalogStorage(db, 'legacy-first');
    const firstAtSeed = await visible('legacy-first');
    await seedCatalogStorage(db, 'legacy-second');
    assert.deepEqual(await visible('legacy-first'), firstAtSeed);
    assert.deepEqual(normalizedRows(await visible('legacy-first')), normalizedRows(physicalFirstBefore));
    assert.deepEqual(normalizedRows(await visible('legacy-second')), normalizedRows(physicalSecondBefore));
    assert.deepEqual(await rows(db, 'SELECT * FROM price_history ORDER BY store_id,code,observed_at'), historyBefore);

    const versions = JSON.parse(JSON.stringify(await rows(db, `SELECT code,valid_from,valid_to FROM catalog_product_versions
      WHERE store_id=? ORDER BY code,valid_from`, [store.storeId])));
    assert.deepEqual(versions, [
      { code: 'ADD_ST', valid_from: 2, valid_to: null },
      { code: 'CHANGE_ST', valid_from: 1, valid_to: 2 },
      { code: 'CHANGE_ST', valid_from: 2, valid_to: null },
      { code: 'KEEP_ST', valid_from: 1, valid_to: null },
      { code: 'REMOVE_ST', valid_from: 1, valid_to: 2 }
    ]);
    assert.deepEqual((await rows(db, 'SELECT code FROM catalog_entries_read WHERE snapshot_id=? ORDER BY code', ['legacy-first'])).map(row => row.code),
      ['CHANGE_ST', 'KEEP_ST', 'REMOVE_ST']);
    assert.deepEqual((await rows(db, 'SELECT code FROM catalog_entries_read WHERE snapshot_id=? ORDER BY code', ['legacy-second'])).map(row => row.code),
      ['ADD_ST', 'CHANGE_ST', 'KEEP_ST']);

    const versionCount = Number((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_product_versions'))[0].n);
    assert.equal((await seedCatalogStorage(db, 'legacy-second')).seeded, false);
    assert.equal(Number((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_product_versions'))[0].n), versionCount);

    const olderEntries = scan([raw('KEEP_ST', 10)], -86400000).entries;
    await saveLegacy('legacy-older', '2026-09-30T00:00:00.000Z', olderEntries);
    await assert.rejects(seedCatalogStorage(db, 'legacy-older'), /chronological order/);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_snapshot_storage WHERE snapshot_id=?', ['legacy-older']))[0].n, 0);
    assert.equal(Number((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_product_versions'))[0].n), versionCount);
  } finally { db.close(); }
});
test('failed upload leaves the previous catalogue active', async () => {
  const db = database();
  try {
    const first = await publish(db, scan([raw()]));
    const failing: Database = { query: async (sql, params) => { if (sql.startsWith('INSERT INTO catalog_product_versions')) throw new Error('upload interrupted'); return db.query(sql, params); },
      batch: statements => db.batch(statements) };
    await assert.rejects(publish(failing, scan([raw('TEST_1_ST', 30)], 1000)), /interrupted/);
    assert.equal((await rows(db, "SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0].value, first.snapshotId);
  } finally { db.close(); }
});
test('failed interval closure and pointer batch rolls back to the previous as-of catalogue', async () => {
  const db = database();
  try {
    const first = await publish(db, scan([raw(), raw('TEST_2_ST')]));
    const before = await rows(db, 'SELECT code,valid_from,valid_to FROM catalog_product_versions ORDER BY code');
    const failing: Database = { query: (sql, params) => db.query(sql, params),
      batch: statements => db.batch([...statements, { sql: 'UPDATE table_that_does_not_exist SET x=1' }]) };
    await assert.rejects(publish(failing, scan([raw('TEST_1_ST', 30), raw('TEST_2_ST')], 1000)), /table_that_does_not_exist/);
    assert.equal((await rows(db, "SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0].value, first.snapshotId);
    assert.deepEqual(await rows(db, 'SELECT code,valid_from,valid_to FROM catalog_product_versions WHERE valid_from=1 ORDER BY code'), before);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM snapshots WHERE status='staging'"))[0].n, 1);
    assert.deepEqual((await rows(db, 'SELECT code FROM catalog_entries_read WHERE snapshot_id=? ORDER BY code', [first.snapshotId])).map(row => row.code), ['TEST_1_ST', 'TEST_2_ST']);
    const retried = await publish(db, scan([raw('TEST_1_ST', 30), raw('TEST_2_ST')], 2000));
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM snapshots WHERE status='staging'"))[0].n, 0);
    assert.equal((await rows(db, 'SELECT COUNT(*) AS n FROM catalog_product_versions WHERE valid_from=2'))[0].n, 1);
    assert.equal((await rows(db, "SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0].value, retried.snapshotId);
  } finally { db.close(); }
});
test('suspicious shrink and another store cannot replace the catalogue', async () => {
  const db = database();
  try {
    const original = scan([raw(), raw('TEST_2_ST')]); await publish(db, original);
    await assert.rejects(publish(db, scan([raw()])), /shrank/);
    await assert.rejects(publish(db, { ...original, store: { ...store, storeId: '2228' } }), /different store/);
  } finally { db.close(); }
});
test('pack prices convert kg/l only when the mapped quantity is supplied', () => {
  const entry = normalize({ ...raw(), priceValue: 22.9, priceUnit: 'kr/kg' }, 'Test', new Date().toISOString());
  assert.equal(packPrice(entry, {}), null);
  assert.equal(packPrice(entry, { unit: 'g', packQuantity: 275 }), 6.3);
  assert.equal(packPrice(entry, { unit: 'ml', packQuantity: 275 }), null);
  assert.equal(packPrice(normalize(raw(), 'Test', new Date().toISOString()), {}), 16.9);
});
test('freshness expires at an offer boundary', () => {
  const observedAt = '2026-10-01T04:00:00.000Z', until = Date.parse('2026-10-01T08:00:00.000Z');
  assert.equal(expiresAt({ observedAt, offers: [{ validUntil: until }] }), new Date(until).toISOString());
});
test('API authentication fails closed, and price requests match exact codes', async () => {
  const db = database();
  try {
    await publish(db, scan([raw()]));
    const env = { DB: workerDb(db), CATALOG_API_TOKEN: secret };
    assert.equal((await handle(request('/status', undefined, 'wrong'), env)).status, 401);
    const response = await handle(request('/prices/query', { storeId: '2110', currency: 'SEK', products: [
      { productId: 'canonical-id', willysCode: 'TEST_1_ST' }, { productId: 'missing', willysCode: 'UNKNOWN_ST' }
    ] }), env);
    const body = await response.json() as any;
    assert.equal(body.prices.length, 1); assert.equal(body.prices[0].productId, 'canonical-id');
    assert.equal(body.prices[0].price, 16.9); assert.equal(body.prices[0].source, 'snapshot');
    assert.equal(body.unresolved[0].reason, 'unknown_code');
    assert.equal((await handle(request('/prices/query', { storeId: '2228', currency: 'SEK', products: [] }), env)).status, 400);
  } finally { db.close(); }
});
test('stale prices are omitted from planner responses', async () => {
  const db = database();
  try {
    await publish(db, scan([raw()], -25 * 3600000));
    const response = await handle(request('/prices/query', { storeId: '2110', currency: 'SEK', products: [{ productId: 'id', willysCode: 'TEST_1_ST' }] }), { DB: workerDb(db), CATALOG_API_TOKEN: secret });
    const body = await response.json() as any; assert.deepEqual(body.prices, []); assert.equal(body.unresolved[0].reason, 'stale');
  } finally { db.close(); }
});
test('catalogue pagination keeps its snapshot when a new one is published', async () => {
  const db = database();
  try {
    await publish(db, scan([raw(), raw('TEST_2_ST')]));
    const env = { DB: workerDb(db), CATALOG_API_TOKEN: secret };
    const first = await (await handle(request('/catalog?limit=1'), env)).json() as any;
    await publish(db, scan([raw('TEST_1_ST', 30), raw('TEST_2_ST', 35)], 1000));
    const next = await (await handle(request(`/catalog?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`), env)).json() as any;
    assert.equal(first.snapshotId, next.snapshotId); assert.equal(next.products[0].priceOre, 1690);
  } finally { db.close(); }
});
test('network client verifies selected store and obeys pacing/window/robots', async () => {
  let now = Date.parse('2026-10-01T04:00:00Z'); const times: number[] = [], cookies: string[] = [];
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const path = new URL(String(input)).pathname; paths.push(path); times.push(now);
    cookies.push(new Headers(options?.headers).get('Cookie') ?? '');
    const value = path === '/robots.txt' ? 'User-agent: *\nCrawl-delay: 10\nVisit-time: 0400-0845\nDisallow: /blocked/'
      : path.endsWith('csrf-token') ? JSON.stringify('test-csrf') : JSON.stringify(path.endsWith('/active') ? store : {});
    return new Response(value, { headers: { 'Set-Cookie': 'JSESSIONID=test-session; Path=/' } });
  };
  const client = new WillysClient({ fetcher, now: () => now, wait: async ms => { now += ms; } });
  assert.equal((await client.initialize('2110')).storeId, '2110');
  assert.ok(times.slice(1).every((time, i) => time - times[i] >= 10000));
  assert.match(cookies.at(-1)!, /JSESSIONID=test-session/);
  assert.ok(paths.includes('/axfood/rest/v2/store/activate'));
  await assert.rejects(client.request('/blocked/test'), /disallows/);
  now = Date.parse('2026-10-01T09:00:00Z'); await assert.rejects(client.request('/api/config'), /Outside/);
  assert.equal(inVisitWindow(new Date('2026-10-01T08:45:00Z')), false);
});
test('network client rejects a mismatched active store and blocks credentials on foreign URLs', async () => {
  const client = new WillysClient({ now: () => Date.parse('2026-10-01T05:00:00Z'), wait: async () => {},
    fetcher: async () => new Response(JSON.stringify({ ...store, storeId: '2228' })) });
  await assert.rejects(client.verifyStore('2110'), /does not match/);
  await assert.rejects(client.request('https://untrusted.example/'), /Untrusted/);
});
test('D1 REST client handles response metadata without printing credentials', async () => {
  let captured: RequestInit | undefined;
  const client = new D1DatabaseClient({ accountId: 'a'.repeat(32), databaseId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), token: 'secret',
    fetcher: async (_url, init) => { captured = init; return Response.json({ success: true, result: [{ success: true, results: [{ x: 1 }], meta: { rows_written: 2, size_after: 20 } }] }); } });
  await client.query('SELECT ?', ['hello']);
  assert.equal(client.rowsWritten, 2); assert.equal(client.sizeBytes, 20); assert.deepEqual(JSON.parse(String(captured?.body)).params, ['hello']);
});
test('unconnected cron fails visibly instead of silently skipping daily updates', async () => {
  await assert.rejects(worker.scheduled({} as ScheduledEvent, { DB: {} as D1Database, CATALOG_API_TOKEN: secret }), /not connected/);
});
test('connected cron dispatches the full scan and reports rejected credentials', async () => {
  const original = globalThis.fetch;
  const env = { DB: {} as D1Database, CATALOG_API_TOKEN: secret, GITHUB_REPOSITORY: 'example/catalog', GITHUB_DISPATCH_TOKEN: 'test-only' };
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://api.github.com/repos/example/catalog/actions/workflows/sync.yml/dispatches');
      assert.equal(options?.method, 'POST'); assert.deepEqual(JSON.parse(String(options?.body)), { ref: 'main' });
      return new Response(null, { status: 204 });
    };
    await worker.scheduled({} as ScheduledEvent, env);
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(worker.scheduled({} as ScheduledEvent, env), /HTTP 401/);
  } finally { globalThis.fetch = original; }
});
test('first-time Cloudflare address setup recognizes an unregistered subdomain', async () => {
  const original = globalThis.fetch, token = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'test-only';
  try {
    globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 400 });
    assert.equal(await cloudflare('/accounts/test/workers/subdomain', 'GET', undefined, true), null);
    globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 });
    await assert.rejects(cloudflare('/accounts/test/workers/subdomain', 'GET', undefined, true), /HTTP 403/);
  } finally { globalThis.fetch = original; if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = token; }
});


test('a timeout after response headers retries the same page and preserves request pacing/cookies', async () => {
  let now = Date.parse('2026-10-08T04:00:00Z');
  const times: number[] = [], cookies: string[] = [], urls: string[] = [];
  const client = new WillysClient({ now: () => now, wait: async ms => { now += ms; },
    fetcher: async (url, options) => {
      times.push(now); urls.push(String(url)); cookies.push(new Headers(options?.headers).get('Cookie') ?? '');
      if (times.length === 1) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":['));
        controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      } }), { headers: { 'Set-Cookie': 'JSESSIONID=retained-session; Path=/' } });
      return Response.json(page([raw()]));
    } });
  const result = await client.category('mejeri-ost-och-agg', 0);
  assert.equal(result.results.length, 1); assert.equal(client.requests, 2);
  assert.equal(urls[0], urls[1]); assert.equal(times[1] - times[0], 10000);
  assert.match(cookies[1], /JSESSIONID=retained-session/);
});
test('repeated response body failures stop after three attempts without publishing partial data', async () => {
  let now = Date.parse('2026-10-08T04:00:00Z');
  const client = new WillysClient({ now: () => now, wait: async ms => { now += ms; },
    fetcher: async () => new Response(new ReadableStream({ start(controller) {
      controller.error(new DOMException('Disconnected body', 'AbortError'));
    } })) });
  await assert.rejects(client.category('mejeri-ost-och-agg', 4), /body failed after 3 attempts.*page=4.*No catalogue published/);
  assert.equal(client.requests, 3);
});
test('body retries still obey the retailer visit window and request budget', async () => {
  for (const constraint of ['window', 'budget']) {
    let now = Date.parse('2026-10-08T08:44:55Z');
    const client = new WillysClient({ maxRequests: constraint === 'budget' ? 1 : 300,
      now: () => now, wait: async ms => { now += ms; }, fetcher: async () => new Response(new ReadableStream({ start(controller) {
        controller.error(new DOMException('Timed out body', 'TimeoutError'));
      } })) });
    if (constraint === 'budget') now = Date.parse('2026-10-08T04:00:00Z');
    await assert.rejects(client.category('mejeri-ost-och-agg'), constraint === 'window' ? /Outside Willys crawl window/ : /request\/runtime budget/);
    assert.equal(client.requests, 1);
  }
});

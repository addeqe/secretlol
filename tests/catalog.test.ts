import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, D1DatabaseClient, rows } from '../src/database.ts';
import { normalize, moneyOre } from '../src/products.ts';
import { crawl } from '../src/crawl.ts';
import { publish } from '../src/publish.ts';
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
test('failed upload leaves the previous catalogue active', async () => {
  const db = database();
  try {
    const first = await publish(db, scan([raw()]));
    const failing: Database = { query: async (sql, params) => { if (sql.startsWith('INSERT INTO catalog_entries')) throw new Error('upload interrupted'); return db.query(sql, params); },
      batch: statements => db.batch(statements) };
    await assert.rejects(publish(failing, scan([raw('TEST_1_ST', 30)], 1000)), /interrupted/);
    assert.equal((await rows(db, "SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0].value, first.snapshotId);
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

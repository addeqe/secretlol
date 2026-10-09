import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointedClient } from '../src/retailers/checkpoints.ts';
import type { ProductObservation, RetailClient, RetailPage, StoreScope } from '../src/retailers/types.ts';

const capabilities = { stores: true, categories: true, browse: true, productLookup: true,
  batchLookup: false, verifiedStorePricing: true, notes: ['fixture'] } as const;

function observation(scope: StoreScope, id: string, checked: number, retailer: 'coop' | 'ica' = 'coop'): ProductObservation {
  return { retailer, scope, storeScopeVerified: true,
    product: { id, ean: null, name: `Product ${id}`, brand: null, categories: ['fixture'],
      pack: { quantity: 1, unit: 'piece', approximate: false }, ingredientsText: null },
    price: { amountOre: 100, basis: 'pack', depositOre: null, memberOnly: false,
      minimumQuantity: null, validFrom: null, validUntil: null },
    availability: 'available', checkedAt: new Date(checked).toISOString(),
    expiresAt: new Date(checked + 2 * 60 * 60 * 1000).toISOString() };
}

function page(scope: StoreScope, categoryId: string, cursor: string | undefined, checked: number,
  retailer: 'coop' | 'ica' = 'coop'): RetailPage {
  return { scope, categoryId, total: 1, nextCursor: null,
    products: [observation(scope, `p-${cursor ?? 'first'}`, checked, retailer)] };
}

function clientFor(fetchPage: (scope: StoreScope, categoryId: string, cursor: string | undefined) => Promise<RetailPage>) {
  let calls = 0;
  const client: RetailClient = {
    retailer: 'coop', capabilities: { ...capabilities, notes: [...capabilities.notes] },
    async stores() { return []; }, async categories() { return []; },
    async browse(scope, categoryId, cursor) { calls++; return fetchPage(scope, categoryId, cursor); },
    async products() { return []; },
  };
  return { client, calls: () => calls };
}

async function withFolder(run: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'retailer-checkpoint-'));
  try { await run(folder); } finally { await rm(folder, { recursive: true, force: true }); }
}

test('warm page checkpoint serves a verified page without a second upstream browse', async () => {
  await withFolder(async folder => {
    const scope = { storeId: 'store-1', channel: 'pickup' } as const;
    const checked = Date.now() - 1000;
    const fake = clientFor(async (s, category, cursor) => page(s, category, cursor, checked));
    const wrapped = checkpointedClient(fake.client, folder);
    const first = await wrapped.browse(scope, 'dairy');
    const second = await wrapped.browse(scope, 'dairy');
    assert.equal(fake.calls(), 1);
    assert.deepEqual(second, first);
    assert.equal(second.products[0]?.checkedAt, new Date(checked).toISOString());
    assert.equal(wrapped.capabilities, fake.client.capabilities);
    assert.deepEqual(await wrapped.stores('12345'), []);
    assert.equal(await readdir(folder).then(files => files.filter(f => f.endsWith('.json')).length), 1);
  });
});

test('expired checkpoint refetches and cache reads never renew source timestamps', async () => {
  await withFolder(async folder => {
    const scope = { storeId: 'store-1', channel: 'pickup' } as const;
    let now = Date.now();
    const fake = clientFor(async (s, category, cursor) => page(s, category, cursor, now));
    const wrapped = checkpointedClient(fake.client, folder, { now: () => now, maxAgeMs: 60 * 60 * 1000 });
    const initial = await wrapped.browse(scope, 'dairy');
    const sourceTimestamp = initial.products[0]!.checkedAt;
    now += 20 * 60 * 1000;
    const warm = await wrapped.browse(scope, 'dairy');
    assert.equal(warm.products[0]!.checkedAt, sourceTimestamp);
    now += 41 * 60 * 1000;
    const refreshed = await wrapped.browse(scope, 'dairy');
    assert.equal(fake.calls(), 2);
    assert.equal(refreshed.products[0]!.checkedAt, new Date(now).toISOString());
  });
});

test('retailer, store, channel, slot, category and cursor all have separate checkpoint keys', async () => {
  await withFolder(async folder => {
    const scopes: StoreScope[] = [
      { storeId: 'store-1', channel: 'pickup' },
      { storeId: 'store-2', channel: 'pickup' },
      { storeId: 'store-1', channel: 'delivery' },
      { storeId: 'store-1', channel: 'pickup', slotId: 'slot-1' },
    ];
    const checked = Date.now() - 1000;
    const fake = clientFor(async (scope, category, cursor) => page(scope, category, cursor, checked));
    const wrapped = checkpointedClient(fake.client, folder);
    for (const scope of scopes) await wrapped.browse(scope, 'dairy');
    await wrapped.browse(scopes[0]!, 'bakery');
    await wrapped.browse(scopes[0]!, 'dairy', 'page-2');
    assert.equal(fake.calls(), 6);
    for (const scope of scopes) await wrapped.browse(scope, 'dairy');
    await wrapped.browse(scopes[0]!, 'bakery');
    await wrapped.browse(scopes[0]!, 'dairy', 'page-2');
    assert.equal(fake.calls(), 6);

    const otherRetailer: RetailClient = { ...fake.client, retailer: 'ica',
      async browse(scope, category, cursor) { return page(scope, category, cursor, checked, 'ica'); } };
    const other = checkpointedClient(otherRetailer, folder);
    await other.browse(scopes[0]!, 'dairy');
    assert.equal(fake.calls(), 6, 'the ICA key does not read the Coop checkpoint');
  });
});

test('corrupt checkpoint is a cache miss and is replaced from the client', async () => {
  await withFolder(async folder => {
    const scope = { storeId: 'store-1', channel: 'pickup' } as const;
    const checked = Date.now() - 1000;
    const fake = clientFor(async (s, category, cursor) => page(s, category, cursor, checked));
    const wrapped = checkpointedClient(fake.client, folder);
    await wrapped.browse(scope, 'dairy');
    const file = (await readdir(folder)).find(name => name.endsWith('.json'))!;
    const path = join(folder, file);
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.replace('Product p-first', 'Tampered p-first'));
    const result = await wrapped.browse(scope, 'dairy');
    assert.equal(fake.calls(), 2);
    assert.equal(result.products[0]!.product.name, 'Product p-first');
  });
});

test('an interrupted partial file is never treated as a checkpoint', async () => {
  await withFolder(async folder => {
    const scope = { storeId: 'store-1', channel: 'pickup' } as const;
    const checked = Date.now() - 1000;
    const fake = clientFor(async (s, category, cursor) => page(s, category, cursor, checked));
    const wrapped = checkpointedClient(fake.client, folder);
    await wrapped.browse(scope, 'dairy');
    const checkpoint = (await readdir(folder)).find(name => name.endsWith('.json'))!;
    await writeFile(join(folder, `${checkpoint}.deadbeef.partial`), '{"half":');
    const result = await wrapped.browse(scope, 'dairy');
    assert.equal(fake.calls(), 1);
    assert.equal(result.products.length, 1);
  });
});

test('freshness requires verified observations in the requested store scope', async () => {
  await withFolder(async folder => {
    const requested = { storeId: 'store-1', channel: 'pickup' } as const;
    const wrong = { storeId: 'store-2', channel: 'pickup' } as const;
    const fake = clientFor(async (_scope, category, cursor) => page(wrong, category, cursor, Date.now() - 1000));
    const wrapped = checkpointedClient(fake.client, folder);
    await assert.rejects(wrapped.browse(requested, 'dairy'), /invalid_product_observation|invalid_checkpoint_page/);
    assert.equal(fake.calls(), 1);
  });
});

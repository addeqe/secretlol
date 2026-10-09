import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { IcaClient } from '../src/retailers/ica.ts';
import { RetailerUnsupportedError } from '../src/retailers/types.ts';

const storeFixture = JSON.parse(await readFile(new URL('./fixtures/retailers/ica-stores-11455.json', import.meta.url), 'utf8'));
const categoryFixture = JSON.parse(await readFile(new URL('./fixtures/retailers/ica-categories-1003714.json', import.meta.url), 'utf8'));

test('ICA postcode resolution uses account IDs and merges available delivery channels', async () => {
  let requestedUrl = '';
  const client = new IcaClient({
    transport: async (url) => {
      requestedUrl = url;
      return Response.json(storeFixture);
    },
  });

  const stores = await client.stores('114 55');
  const request = new URL(requestedUrl);
  assert.equal(request.origin + request.pathname, 'https://handla.ica.se/api/store/v1');
  assert.equal(request.searchParams.get('zip'), '11455');
  assert.equal(request.searchParams.get('customerType'), 'B2C');
  assert.deepEqual(stores.map(({ id }) => id), ['1004414', '1003714']);
  assert.deepEqual(stores[0]?.channels, ['delivery']);
  assert.deepEqual(stores[1]?.channels, ['delivery', 'pickup']);
  assert.equal(stores[1]?.url, 'https://handlaprivatkund.ica.se/stores/1003714');
});

test('ICA resolves categories through the selected store base path', async () => {
  let requestedUrl = '';
  const client = new IcaClient({ transport: async (url) => {
    requestedUrl = url;
    return Response.json(categoryFixture);
  } });
  assert.equal(client.capabilities.stores, true);
  assert.equal(client.capabilities.categories, true);
  assert.equal(client.capabilities.browse, false);
  assert.equal(client.capabilities.productLookup, false);
  assert.equal(client.capabilities.batchLookup, false);
  assert.equal(client.capabilities.verifiedStorePricing, false);
  const categories = await client.categories({ storeId: '1003714', channel: 'pickup' });
  const request = new URL(requestedUrl);
  assert.equal(request.origin + request.pathname,
    'https://handlaprivatkund.ica.se/stores/1003714/api/webproductpagews/v1/categories');
  assert.equal(request.searchParams.get('decoration'), 'false');
  assert.equal(request.searchParams.get('categoryDepth'), '2');
  assert.equal(categories.length, 26);
  assert.equal(categories[0]?.name, categoryFixture[0].name);
  assert.equal(categories[0]?.id, categoryFixture[0].categoryId);
  await assert.rejects(client.browse({ storeId: '1003714', channel: 'pickup' }, '123'),
    (error: unknown) => error instanceof RetailerUnsupportedError && error.operation === 'browse');
  await assert.rejects(client.products({ storeId: '1003714', channel: 'pickup' }, ['123']),
    (error: unknown) => error instanceof RetailerUnsupportedError && error.operation === 'product_lookup');
});

test('ICA category parser rejects malformed category trees and HTTP errors', async () => {
  const malformed = new IcaClient({ transport: async () => Response.json([{ categoryId: 'x', name: 'Bad', childCategories: {} }]) });
  await assert.rejects(malformed.categories({ storeId: '1003714', channel: 'pickup' }), /ica_categories_invalid_category/);
  const unavailable = new IcaClient({ transport: async () => new Response('unavailable', { status: 503 }) });
  await assert.rejects(unavailable.categories({ storeId: '1003714', channel: 'pickup' }), /ica_categories_http_503/);
});

test('ICA store resolver rejects invalid postcodes and failed responses', async () => {
  const client = new IcaClient({
    transport: async () => new Response('unavailable', { status: 503 }),
  });
  await assert.rejects(client.stores('1234'), /invalid_postal_code/);
  await assert.rejects(client.stores('11455'), /ica_store_lookup_http_503/);
  const invalidShape = new IcaClient({ transport: async () => Response.json({ stores: [] }) });
  await assert.rejects(invalidShape.stores('11455'), /ica_store_lookup_invalid_response/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectProductNutrition } from '../scripts/collect-product-nutrition.ts';
import { parseCoopProduct } from '../src/retailers/coop.ts';
import { productIdentity } from '../src/retailers/identity.ts';

const scope = { storeId: '256600', channel: 'pickup' } as const;
const originalCheckedAt = '2026-10-09T08:00:00.000Z';
const fixtureCheckedAt = '2026-10-08T09:10:11.000Z';
function raw(id = '7300156587121', nutrition = true): Record<string, unknown> {
  return { id, ean: id, name: 'Havredryck Till Kaffe', manufacturerName: 'Coop', packageSize: '1l',
    salesUnit: 'ST', piecePriceData: { b2cPrice: 20.95 }, availableOnline: true,
    ...(nutrition ? { nutrientBasis: { quantity: 100 }, nutrientInformation: [{ header: {
      nutrientBasisQuantity: 100, nutrientBasisQuantityType: 'BY_MEASURE',
      nutrientBasisQuantityUnit: { code: 'MLT', value: 'Milliliter' } } }],
    nutrientLinks: [{ amount: ['60'], description: 'Energi', unit: 'Kilokalori' }] } : {}) };
}
function dataset(products = [raw()], retain = false) {
  const observations = products.map(product => parseCoopProduct(product, scope, new Date(originalCheckedAt), true));
  if (!retain) for (const observation of observations) delete observation.product.nutritionSource;
  return { retailer: 'coop', scope, datasetId: 'reviewed-dataset', inventoryHash: 'reviewed-inventory', observations,
    connections: observations.map((o, index) => ({ ingredientId: `ingredient-${index}`, status: 'matched',
      approvedProducts: [{ productId: o.product.id, identity: productIdentity(o.product) }] })) };
}
async function withFiles(run: (files: { folder: string; input: string; output: string; fixture: string }) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'collect-nutrition-'));
  try { await run({ folder, input: join(folder, 'reviewed.json'), output: join(folder, 'new-labels.json'),
    fixture: join(folder, 'fixture.json') }); }
  finally { await rm(folder, { recursive: true, force: true }); }
}
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value)); }

test('offline collection preserves approved nutrition and source time without any fetch', async () => {
  await withFiles(async ({ input, output }) => {
    const source = dataset([raw()], true);
    source.connections.push(source.connections[0]!);
    await json(input, source);
    let calls = 0;
    const result = await collectProductNutrition({ input, output }, { fetch: async () => { calls++; throw new Error('network'); } });
    assert.equal(calls, 0);
    assert.equal(result.artifact.counts.approvedProducts, 1);
    assert.equal(result.artifact.counts.preserved, 1);
    assert.equal(result.artifact.counts.requests, 0);
    assert.equal(result.artifact.products[0]!.checkedAt, originalCheckedAt);
    assert.deepEqual(result.artifact.products[0]!.nutritionSource, source.observations[0]!.product.nutritionSource);
    assert.equal(result.artifact.products[0]!.identityHash, createHash('sha256')
      .update(source.connections[0]!.approvedProducts[0]!.identity).digest('hex'));
    assert.equal(result.artifact.source.inputSha256, createHash('sha256').update(await readFile(input)).digest('hex'));
  });
});

test('offline mode reports uncollected labels without requesting a product', async () => {
  await withFiles(async ({ input, output }) => {
    await json(input, dataset());
    let calls = 0;
    const result = await collectProductNutrition({ input, output }, { fetch: async () => { calls++; throw new Error('network'); } });
    assert.equal(calls, 0);
    assert.equal(result.artifact.counts.requested, 0);
    assert.equal(result.artifact.counts.notCollected, 1);
    assert.equal(result.artifact.products[0]!.checkedAt, null);
  });
});

test('raw archive fixture retains exact declared labels, reports missing products and never re-dates them', async () => {
  await withFiles(async ({ input, output, fixture }) => {
    await json(input, dataset([raw(), raw('7300156587122')]));
    await json(fixture, { results: { count: 1, items: [raw()] } });
    await assert.rejects(collectProductNutrition({ input, output, fixture }), /fixture_source_checked_at_required/);
    const result = await collectProductNutrition({ input, output, fixture, fixtureCheckedAt });
    assert.equal(result.artifact.counts.requested, 2);
    assert.equal(result.artifact.counts.requests, 0);
    assert.equal(result.artifact.counts.missing, 1);
    assert.equal(result.artifact.counts.nutritionPresent, 1);
    assert.equal(result.artifact.products[0]!.checkedAt, fixtureCheckedAt);
    assert.equal(result.artifact.products[1]!.checkedAt, null);
    assert.equal(result.artifact.products[1]!.status, 'product_missing');
    assert.deepEqual(result.artifact.products[0]!.nutritionSource!.sourcePayload.nutrientLinks, raw().nutrientLinks);
  });
});

test('selection rejects unmatched IDs, conflicting approvals, missing observations and changed identities', async () => {
  await withFiles(async ({ input, output }) => {
    const source = dataset();
    await json(input, source);
    await assert.rejects(collectProductNutrition({ input, output, productIds: ['unreviewed'] }), /unapproved_requested_product/);
    source.observations[0]!.product.name = 'Changed product';
    await json(input, source);
    await assert.rejects(collectProductNutrition({ input, output }), /reviewed_product_identity_mismatch/);
    source.observations = [];
    await json(input, source);
    await assert.rejects(collectProductNutrition({ input, output }), /approved_product_observation_missing/);
    const conflicting = dataset();
    conflicting.connections.push({ ...conflicting.connections[0]!, approvedProducts: [
      { productId: conflicting.observations[0]!.product.id, identity: 'different' }] });
    await json(input, conflicting);
    await assert.rejects(collectProductNutrition({ input, output }), /conflicting_product_approvals/);
  });
});

test('output cannot overwrite an input or existing artifact, before any live request', async () => {
  await withFiles(async ({ input, output }) => {
    await json(input, dataset()); await writeFile(output, 'keep this');
    let calls = 0;
    const deps = { subscriptionKey: 'test', fetch: async () => { calls++; throw new Error('network'); } };
    await assert.rejects(collectProductNutrition({ input, output: input, allowLive: true }, deps), /collection_output_is_input/);
    await assert.rejects(collectProductNutrition({ input, output, allowLive: true }, deps), /collection_output_exists/);
    assert.equal(calls, 0);
    assert.equal(await readFile(output, 'utf8'), 'keep this');
  });
});

test('explicit live mode batches only approved IDs and enforces product/request budgets', async () => {
  await withFiles(async ({ input, output }) => {
    const products = Array.from({ length: 26 }, (_, n) => raw(String(7300156587000 + n)));
    await json(input, dataset(products));
    let calls = 0;
    const result = await collectProductNutrition({ input, output, allowLive: true, maxProducts: 25, maxRequests: 1 }, {
      subscriptionKey: 'not-recorded', now: () => new Date('2026-10-12T10:00:00Z'),
      fetch: async (_url, init) => {
        calls++;
        const ids = JSON.parse(String(init?.body)) as string[];
        assert.equal(ids.length, 25);
        assert.equal(ids.every(id => products.some(p => p.id === id)), true);
        return new Response(JSON.stringify({ results: { count: ids.length,
          items: ids.map(id => products.find(p => p.id === id)) } }), { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.artifact.selectionTruncated, true);
    assert.equal(result.artifact.counts.requests, 1);
    assert.equal(result.artifact.counts.nutritionPresent, 25);
    assert.equal(result.artifact.products[0]!.checkedAt, '2026-10-12T10:00:00.000Z');
    const otherOutput = `${output}.second`;
    await assert.rejects(collectProductNutrition({ input, output: otherOutput, allowLive: true,
      maxProducts: 26, maxRequests: 1 }, { subscriptionKey: 'test', fetch: async () => { throw new Error('network'); } }),
    /lookup_batches_exceed_request_budget/);
  });
});

test('changed product identity is quarantined while other approved products are collected', async () => {
  await withFiles(async ({ input, output, fixture }) => {
    await json(input, dataset([raw(), raw('7300156587122')]));
    await json(fixture, { results: { count: 2,
      items: [{ ...raw(), name: 'Different food' }, raw('7300156587122')] } });
    const result = await collectProductNutrition({ input, output, fixture, fixtureCheckedAt });
    const changed = result.artifact.products[0]!, valid = result.artifact.products[1]!;
    assert.equal(result.artifact.counts.identityChanged, 1);
    assert.equal(result.artifact.counts.nutritionPresent, 1);
    assert.equal(changed.status, 'product_identity_changed');
    assert.equal(changed.expectedIdentityHash, changed.identityHash);
    assert.match(changed.observedIdentityHash!, /^[a-f0-9]{64}$/);
    assert.notEqual(changed.observedIdentityHash, changed.identityHash);
    assert.equal(changed.nutritionSource, undefined);
    assert.equal(changed.checkedAt, fixtureCheckedAt);
    assert.equal(valid.status, 'collected');
    assert.equal(valid.nutritionSource!.productId, valid.productId);
  });
});

test('absent nutrients remain unknown after a successful product lookup', async () => {
  await withFiles(async ({ input, output, fixture }) => {
    await json(input, dataset());
    await json(fixture, { results: { count: 1, items: [raw(undefined, false)] } });
    const result = await collectProductNutrition({ input, output, fixture, fixtureCheckedAt });
    assert.equal(result.artifact.counts.nutritionUnavailable, 1);
    assert.equal(result.artifact.counts.nutritionPresent, 0);
    assert.equal(result.artifact.products[0]!.nutritionSource, undefined);
    assert.equal(result.artifact.products[0]!.checkedAt, fixtureCheckedAt);
  });
});

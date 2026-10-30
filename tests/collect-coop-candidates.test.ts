import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCoopCandidates } from '../scripts/collect-coop-candidates.ts';

const scope = { storeId: '256600', channel: 'pickup' } as const;
const checkedAt = '2026-10-14T08:00:00.000Z';
function candidate(id: string, name = `Product ${id}`) {
  return { productId: id, observedName: name, brand: 'Coop', ean: id, categories: ['cat-1'],
    pack: { quantity: 200, unit: 'g', approximate: false }, ingredientsText: 'Plain product.' };
}
function overlay(candidates = [candidate('7300156587121'), candidate('7300156587122'), candidate('7300156587123')]) {
  return { schemaVersion: 1, kind: 'local-coop-product-identity-review-overlay', status: 'proposal_only_not_approval',
    sourceSnapshot: { datasetId: 'snapshot-1', inventoryHash: 'inventory-1', scope: { ...scope } },
    policy: { version: 'owner-halal-brands-strict-2' },
    proposals: [{ foodId: 'test-food', sourceIdentity: 'test food', candidates }] };
}
function raw(item: ReturnType<typeof candidate>, changes: Record<string, unknown> = {}) {
  return { id: item.productId, ean: item.ean, name: item.observedName, manufacturerName: item.brand,
    categories: item.categories, package: item.pack, ingredientsText: item.ingredientsText,
    availableOnline: true, piecePriceData: { b2cPrice: 12.34 },
    nutrientBasis: { quantity: 100 },
    nutrientInformation: [{ header: { nutrientBasisQuantity: 100, nutrientBasisQuantityType: 'BY_MEASURE',
      nutrientBasisQuantityUnit: { code: 'GRM', value: 'Gram' } } }],
    nutrientLinks: [{ amount: ['2.1'], description: 'Protein', unit: 'Gram' }], ...changes };
}
async function withFiles(run: (paths: { dir: string; overlay: string; fixture: string; output: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'coop-candidate-observation-'));
  try { await run({ dir, overlay: join(dir, 'overlay.json'), fixture: join(dir, 'fixture.json'), output: join(dir, 'new-observations.json') }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value)); }

test('fixture collection reads only listed IDs and records unchanged, changed, missing, and nutrition evidence', async () => {
  await withFiles(async ({ overlay: overlayPath, fixture, output }) => {
    const candidates = [candidate('7300156587121'), candidate('7300156587122'), candidate('7300156587123')];
    await json(overlayPath, overlay(candidates));
    await json(fixture, { retailer: 'coop', scope, checkedAt, response: { results: { count: 2,
      items: [raw(candidates[0]!), raw(candidates[1]!, { name: 'Changed product name' })] } } });
    let calls = 0;
    const result = await collectCoopCandidates({ overlay: overlayPath, output, fixture }, { fetch: async () => {
      calls++; throw new Error('network must not be used for fixture mode');
    } });
    assert.equal(calls, 0);
    assert.equal(result.artifact.mode, 'fixture');
    assert.deepEqual(result.artifact.limits, { maxProductIds: 23, batchSize: 25, maxRequests: 2 });
    assert.deepEqual(result.artifact.counts, { candidateIds: 3, requestedIds: 3, requests: 1, retries: 0,
      unchanged: 1, changed: 1, missing: 1, nutritionSources: 2 });
    assert.deepEqual(result.artifact.products.map(item => item.productId), candidates.map(item => item.productId).sort());
    const unchanged = result.artifact.products.find(item => item.status === 'unchanged')!;
    assert.equal(unchanged.identityOld, unchanged.identityNew);
    assert.equal(unchanged.nutritionSource!.productId, unchanged.productId);
    assert.equal(unchanged.nutritionSource!.sourcePayload.nutrientLinks instanceof Array, true);
    const changed = result.artifact.products.find(item => item.status === 'changed')!;
    assert.notEqual(changed.identityOldHash, changed.identityNewHash);
    assert.equal(changed.observation!.product.name, 'Changed product name');
    const missing = result.artifact.products.find(item => item.status === 'missing')!;
    assert.equal(missing.identityNew, null);
    assert.equal(missing.observation, null);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).counts.missing, 1);
  });
});

test('live mode is opt-in and requires the public key before any request', async () => {
  await withFiles(async ({ overlay: overlayPath, output }) => {
    await json(overlayPath, overlay());
    let calls = 0;
    await assert.rejects(collectCoopCandidates({ overlay: overlayPath, output }, { fetch: async () => {
      calls++; throw new Error('unexpected request');
    } }), /candidate_fixture_or_allow_live_required/);
    await assert.rejects(collectCoopCandidates({ overlay: overlayPath, output, allowLive: true }, {
      subscriptionKey: '', fetch: async () => { calls++; throw new Error('unexpected request'); },
    }), /coop_public_subscription_key_required/);
    assert.equal(calls, 0);
  });
});

test('live mode chunks only overlay IDs, remains inside its one-request budget, and never exposes the key', async () => {
  await withFiles(async ({ overlay: overlayPath, output }) => {
    const candidates = Array.from({ length: 23 }, (_, index) => candidate(String(7300156587100 + index)));
    await json(overlayPath, overlay(candidates));
    let calls = 0;
    const result = await collectCoopCandidates({ overlay: overlayPath, output, allowLive: true }, {
      subscriptionKey: 'do-not-record-this-key', now: () => new Date(checkedAt),
      fetch: async (_url, init) => {
        calls++;
        const ids = JSON.parse(String(init?.body)) as string[];
        assert.equal(ids.length, 23);
        assert.deepEqual(ids, candidates.map(item => item.productId).sort());
        return new Response(JSON.stringify({ results: { count: ids.length, items: ids.map(item =>
          raw(candidates.find(candidateItem => candidateItem.productId === item)!)) } }),
        { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.artifact.counts.requests, 1);
    assert.equal(result.artifact.counts.unchanged, 23);
    assert.equal(JSON.stringify(result.artifact).includes('do-not-record-this-key'), false);
  });
});

test('overlay scope, duplicate IDs, and a candidate list beyond the fixed budget are rejected', async () => {
  await withFiles(async ({ overlay: overlayPath, output }) => {
    const wrongScope = overlay();
    (wrongScope.sourceSnapshot.scope as { storeId: string; channel: string }).storeId = 'other';
    await json(overlayPath, wrongScope);
    await assert.rejects(collectCoopCandidates({ overlay: overlayPath, output, fixture: 'unused' }), /candidate_overlay_scope_or_snapshot_invalid/);
    const repeated = overlay([candidate('7300156587121'), candidate('7300156587121')]);
    await json(overlayPath, repeated);
    await assert.rejects(collectCoopCandidates({ overlay: overlayPath, output, fixture: 'unused' }), /candidate_id_budget_or_duplicate_violation/);
    const tooMany = overlay(Array.from({ length: 24 }, (_, index) => candidate(String(7300156587100 + index))));
    await json(overlayPath, tooMany);
    await assert.rejects(collectCoopCandidates({ overlay: overlayPath, output, fixture: 'unused' }), /candidate_id_budget_or_duplicate_violation/);
  });
});

test('fixture cannot override a listed product with an unrequested ID and output never overwrites', async () => {
  await withFiles(async ({ overlay: overlayPath, fixture, output }) => {
    const candidates = [candidate('7300156587121')];
    await json(overlayPath, overlay(candidates));
    await json(fixture, { retailer: 'coop', scope, checkedAt, response: { results: { count: 1,
      items: [raw(candidate('7300156587999'))] } } });
    await assert.rejects(collectCoopCandidates({ overlay: overlayPath, output, fixture }), /coop_incomplete_products_response/);
    await writeFile(output, 'preserve');
    await assert.rejects(collectCoopCandidates({ overlay: overlayPath, output, fixture }), /candidate_output_exists/);
    assert.equal(await readFile(output, 'utf8'), 'preserve');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/products.ts';

test('a malformed recipe line is isolated while the long-lived bridge serves later requests', t => {
  const asOf = Date.parse('2026-10-11T12:00:00Z');
  const product = normalize({ code: 'FLOUR_ST', name: 'Vetemjöl', manufacturer: 'Eldorado',
    displayVolume: '1000g', priceValue: 20, priceUnit: 'kr/st', comparePrice: '20,00 kr',
    comparePriceUnit: 'kg', depositPrice: '', online: true, outOfStock: false,
    addToCartDisabled: false, potentialPromotions: [] }, 'Skafferi', new Date(asOf).toISOString());
  const catalogue = { schemaVersion: 1, retailer: 'willys', snapshotId: 'isolation-test',
    completedAt: new Date(asOf).toISOString(), storeId: 'TEST', products: [product], reviews: {} };
  const malformed = { raw: '100 g flour', name: 'flour', query: 'flour', names: null,
    status: 'parsed', amount: { quantity: 100, unit: 'g' }, size: null, preparation: null };
  const valid = { ...malformed, names: ['flour'] };
  const input = [
    { op: 'match', lines: [malformed, valid] },
    { op: 'policy', texts: ['flour\u2028milk', 'flour\u2029milk', 'flour'] },
  ].map(request => JSON.stringify(request)).join('\n') + '\n';

  const temp = mkdtempSync(join(tmpdir(), 'recipe-bridge-isolation-'));
  const cataloguePath = join(temp, 'catalogue.json');
  writeFileSync(cataloguePath, JSON.stringify(catalogue));
  try {
    const bridge = fileURLToPath(new URL('../scripts/recipe-ingredient-bridge.ts', import.meta.url));
    const processResult = spawnSync(process.execPath,
      [bridge, '--catalogue', cataloguePath, '--as-of', new Date(asOf).toISOString()],
      { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if ((processResult.error as (Error & { code?: string }) | undefined)?.code === 'EPERM') {
      t.skip('This runtime blocks child-process creation; run in a process-enabled test environment');
      return;
    }
    assert.equal(processResult.error, undefined, processResult.error?.message);
    assert.equal(processResult.status, 0, processResult.stderr);
    assert.equal(processResult.stderr, '');

    const responses = processResult.stdout.trimEnd().split('\n').map(row => JSON.parse(row));
    assert.equal(responses.length, 3); // startup metadata and both requests
    assert.ok(responses[0].metadata.contextHash);

    const [failed, succeeded] = responses[1].results;
    assert.equal(failed.status, 'processing_error');
    assert.equal(typeof failed.errorType, 'string');
    assert.ok(failed.errorType.length > 0);
    assert.equal(typeof failed.errorMessage, 'string');
    assert.ok(failed.errorMessage.length > 0);
    assert.equal(failed.policy?.blockedReason, null);
    assert.equal(failed.selectedCode ?? null, null);
    assert.equal(failed.selectedProduct ?? null, null);

    assert.notEqual(succeeded.status, 'processing_error');
    assert.equal(succeeded.selectedCode, 'FLOUR_ST');
    assert.equal(responses[2].results.length, 3);
    assert.ok(responses[2].results.every((policy: unknown) => !!policy && typeof policy === 'object'
      && 'blockedReason' in policy && 'meat' in policy));
    assert.equal(responses[2].results[2].blockedReason, null);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

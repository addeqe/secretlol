import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCoopProduct } from '../src/retailers/coop.ts';
import { initializeCoopParserRuntime } from '../src/retailers/coop-parser-runtime.ts';
import type { StoreScope } from '../src/retailers/types.ts';

test('Coop parser runtime initialization is pure, idempotent, and does not alter real parse output', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/coop-product.json', import.meta.url), 'utf8'));
  const scope: StoreScope = { storeId: 'selected-test-store', channel: 'pickup' };
  const checkedAt = new Date('2026-10-09T13:00:00.000Z');
  const before = parseCoopProduct(fixture, scope, checkedAt, true);

  const started = performance.now();
  initializeCoopParserRuntime();
  initializeCoopParserRuntime();
  assert.ok(performance.now() - started < 1000, 'startup initialization remains bounded below one second');

  assert.deepEqual(parseCoopProduct(fixture, scope, checkedAt, true), before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.ts';
import type { Env } from '../worker/index.ts';

const baseEnv = (): Env => ({ DB: {} as D1Database, MEAL_DB: {} as D1Database, CATALOG_API_TOKEN: 'test-token',
  GITHUB_REPOSITORY: 'example/catalog', GITHUB_DISPATCH_TOKEN: 'dispatch-test-token' });
const event = (cron: string) => ({ cron } as ScheduledEvent);

test('Cloudflare cron schedules Willys and Coop once at their configured times', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, ['17 4 * * *', '50 4 * * *']);
  const workflow = readFileSync(new URL('../.github/workflows/retailers.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+schedule:/m, 'Cloudflare is the only Coop scheduler');
});

test('Willys cron dispatches sync workflow while the legacy missing-cron event stays compatible', async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  try {
    globalThis.fetch = async (url) => { paths.push(String(url)); return new Response(null, { status: 204 }); };
    await worker.scheduled(event('17 4 * * *'), baseEnv());
    await worker.scheduled({} as ScheduledEvent, baseEnv());
    assert.deepEqual(paths, [
      'https://api.github.com/repos/example/catalog/actions/workflows/sync.yml/dispatches',
      'https://api.github.com/repos/example/catalog/actions/workflows/sync.yml/dispatches',
    ]);
  } finally { globalThis.fetch = original; }
});

test('Coop cron dispatches retailers workflow only with Coop binding and propagates auth failures', async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  try {
    globalThis.fetch = async (url) => { paths.push(String(url)); return new Response(null, { status: 204 }); };
    await worker.scheduled(event('50 4 * * *'), baseEnv());
    assert.deepEqual(paths, [], 'an unconfigured Coop database must not dispatch');
    const env = { ...baseEnv(), COOP_DB: {} as D1Database };
    await worker.scheduled(event('50 4 * * *'), env);
    assert.deepEqual(paths, ['https://api.github.com/repos/example/catalog/actions/workflows/retailers.yml/dispatches']);
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(worker.scheduled(event('50 4 * * *'), env), /Coop refresh dispatch failed \(HTTP 401\)/);
  } finally { globalThis.fetch = original; }
});

test('unknown Cloudflare cron fails closed without dispatching a workflow', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('should not fetch'); };
    await assert.rejects(worker.scheduled(event('0 12 * * *'), baseEnv()), /Unknown scheduled cron/);
  } finally { globalThis.fetch = original; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.ts';
import type { Env } from '../worker/index.ts';

const baseEnv = (): Env => ({ DB: {} as D1Database, MEAL_DB: {} as D1Database, CATALOG_API_TOKEN: 'test-token',
  GITHUB_REPOSITORY: 'example/catalog', GITHUB_DISPATCH_TOKEN: 'dispatch-test-token' });
const event = (cron: string) => ({ cron } as ScheduledEvent);

test('Cloudflare schedules both retailers and the Willys workflow gates automatic collection', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, ['17 4 * * *', '50 4 * * *']);
  const syncWorkflow = readFileSync(new URL('../.github/workflows/sync.yml', import.meta.url), 'utf8');
  assert.match(syncWorkflow, /schedule:\n(?:\s+- cron: '17 [4-7] \* \* \*'\n){4}/);
  assert.match(syncWorkflow, /workflow_dispatch:/);
  assert.match(syncWorkflow, /scheduled_refresh:/);
  assert.match(syncWorkflow, /allow_outside_window:/);
  assert.match(syncWorkflow, /WILLYS_MANUAL_OUTSIDE_WINDOW:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.scheduled_refresh && inputs\.allow_outside_window \}\}/);
  assert.match(syncWorkflow, /id: refresh\n\s+if: \$\{\{ github\.event_name == 'schedule' \|\| inputs\.scheduled_refresh \}\}\n\s+run: node scripts\/check-catalogue-refresh\.ts/);
  assert.match(syncWorkflow, /Collect and publish catalogue\n\s+if: [^\n]*steps\.refresh\.outputs\.refresh == 'true'/);
  assert.match(syncWorkflow, /Refresh ingredient connections\n\s+if: [^\n]*steps\.refresh\.outputs\.refresh == 'true'/);
  const workflow = readFileSync(new URL('../.github/workflows/retailers.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+schedule:/m, 'Cloudflare is the only Coop scheduler');
});

test('Willys cron dispatches an automatic sync with no manual overrides', async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), method: options?.method, body: JSON.parse(String(options?.body)) });
      return new Response(null, { status: 204 });
    };
    await worker.scheduled(event('17 4 * * *'), baseEnv());
    assert.deepEqual(requests, [{
      url: 'https://api.github.com/repos/example/catalog/actions/workflows/sync.yml/dispatches',
      method: 'POST',
      body: { ref: 'main', inputs: { scheduled_refresh: true } },
    }]);
    globalThis.fetch = async () => new Response(null, { status: 403 });
    await assert.rejects(worker.scheduled(event('17 4 * * *'), baseEnv()), /Willys refresh dispatch failed \(HTTP 403\)/);
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

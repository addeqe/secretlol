import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectedConfig } from '../scripts/helpers.ts';
import { initializeRetailerDatabases, type RetailerInitOperations } from '../scripts/init-retailers.ts';

const uuid = (letter: string) => `${letter.repeat(8)}-${letter.repeat(4)}-${letter.repeat(4)}-${letter.repeat(4)}-${letter.repeat(12)}`;
const baseEnv = (): NodeJS.ProcessEnv => ({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'private-test-token', CLOUDFLARE_DATABASE_ID: uuid('b'), MEAL_DATABASE_ID: uuid('c'),
  RETAILERS_CLOUD_ENABLED: 'true' });

function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'retailer-setup-'));
  return { path, close: () => rmSync(path, { recursive: true, force: true }) };
}

test('connected config keeps Willys IDs and adds only configured retailer databases', () => {
  const temp = tempDir();
  try {
    const input = join(temp.path, 'wrangler.jsonc'), output = join(temp.path, 'connected.json');
    writeFileSync(input, JSON.stringify({ account_id: 'old', d1_databases: [
      { binding: 'DB', database_name: 'willys-catalog', database_id: 'willys-old', migrations_dir: 'migrations' },
      { binding: 'MEAL_DB', database_name: 'mealplanner-recipes', database_id: 'meal-old', migrations_dir: 'meal-migrations' },
    ] }));
    const env: NodeJS.ProcessEnv = { ...baseEnv(), COOP_DATABASE_ID: uuid('d'), GITHUB_REPOSITORY: 'owner/catalogue' };
    connectedConfig(env, input, output);
    const config = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(config.vars.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY);
    assert.equal(config.vars.RETAILERS_LIVE_ENABLED, 'false');
    assert.equal(config.d1_databases[0].database_id, env.CLOUDFLARE_DATABASE_ID);
    assert.equal(config.d1_databases[1].database_id, env.MEAL_DATABASE_ID);
    assert.deepEqual(config.d1_databases.slice(2), [{ binding: 'COOP_DB', database_name: 'coop-catalog',
      database_id: env.COOP_DATABASE_ID, migrations_dir: 'retail-migrations' }]);
  } finally { temp.close(); }
});

test('default retailer setup returns a local plan without loading env or contacting Cloudflare', async () => {
  const calls: string[] = [];
  const operations: RetailerInitOperations = {
    async findDatabase() { calls.push('find'); return null; }, async createDatabase() { calls.push('create'); return { uuid: uuid('d') }; },
    save() { calls.push('save'); }, writeConfig() { calls.push('config'); }, async migrate() { calls.push('migrate'); },
  };
  const result = await initializeRetailerDatabases({ operations, env: {} });
  assert.equal(result.mode, 'local-plan');
  assert.deepEqual(result.retailers.map(item => item.retailer), ['coop', 'ica']);
  assert.match(result.instructions, /No Cloudflare access was attempted/);
  assert.deepEqual(calls, []);
});

test('existing retailer database ID is reused and only its migration is applied behind every gate', async () => {
  const env = { ...baseEnv(), COOP_DATABASE_ID: uuid('d') };
  const calls: string[] = [];
  const operations: RetailerInitOperations = {
    async findDatabase() { calls.push('find'); throw new Error('existing ID must skip discovery'); },
    async createDatabase() { calls.push('create'); throw new Error('existing ID must never be recreated'); },
    save() { calls.push('save'); }, writeConfig(current) { calls.push(`config:${current.COOP_DATABASE_ID}`); },
    async migrate(name) { calls.push(`migrate:${name}`); },
  };
  const result = await initializeRetailerDatabases({ retailers: ['coop'], remote: true, confirmCloudflare: true, env, operations });
  assert.equal(result.mode, 'cloud-initialized');
  assert.deepEqual(calls, [`config:${env.COOP_DATABASE_ID}`, 'migrate:coop-catalog']);
});

test('new database creation saves its ID and applies only the requested retailer migration', async () => {
  const env = baseEnv();
  const calls: string[] = [];
  const operations: RetailerInitOperations = {
    async findDatabase(_account, name) { calls.push(`find:${name}`); return null; },
    async createDatabase(_account, name) { calls.push(`create:${name}`); return { uuid: uuid('e'), name }; },
    save(updates) { calls.push(`save:${Object.keys(updates).join(',')}`); },
    writeConfig(current) { calls.push(`config:${current.ICA_DATABASE_ID}`); },
    async migrate(name) { calls.push(`migrate:${name}`); },
  };
  await initializeRetailerDatabases({ retailers: ['ica'], remote: true, confirmCloudflare: true, env, operations });
  assert.deepEqual(calls, [
    'find:ica-catalog', 'create:ica-catalog', 'save:ICA_DATABASE_ID',
    `config:${uuid('e')}`, 'migrate:ica-catalog',
  ]);
  assert.equal(env.ICA_DATABASE_ID, uuid('e'));
});

test('invalid configured database ID is rejected before any Cloudflare or migration operation', async () => {
  const calls: string[] = [];
  const operations: Partial<RetailerInitOperations> = {
    async findDatabase() { calls.push('find'); return null; }, async createDatabase() { calls.push('create'); return { uuid: uuid('e') }; },
    save() { calls.push('save'); }, writeConfig() { calls.push('config'); }, async migrate() { calls.push('migrate'); },
  };
  await assert.rejects(initializeRetailerDatabases({ retailers: ['coop'], remote: true, confirmCloudflare: true,
    env: { ...baseEnv(), COOP_DATABASE_ID: 'not-a-database-id' }, operations }), /Invalid COOP_DATABASE_ID/);
  assert.deepEqual(calls, []);
});

test('partial cloud gates remain local and missing account credentials block before cloud calls', async () => {
  const calls: string[] = [];
  const operations: Partial<RetailerInitOperations> = {
    async findDatabase() { calls.push('find'); return null; }, async createDatabase() { calls.push('create'); return { uuid: uuid('e') }; },
  };
  const plan = await initializeRetailerDatabases({ retailers: ['coop'], remote: true, env: baseEnv(), operations });
  assert.equal(plan.mode, 'local-plan');
  await assert.rejects(initializeRetailerDatabases({ retailers: ['coop'], remote: true, confirmCloudflare: true,
    env: { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), RETAILERS_CLOUD_ENABLED: 'true' }, operations }), /CLOUDFLARE_API_TOKEN/);
  assert.deepEqual(calls, []);
});

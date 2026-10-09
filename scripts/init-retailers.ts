import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connectedConfig, cloudflare, saveEnv, wrangler } from './helpers.ts';
import type { RetailerId } from '../src/retailers/types.ts';

const retailerDatabases: Record<RetailerId, { envKey: string; name: string; binding: string }> = {
  coop: { envKey: 'COOP_DATABASE_ID', name: 'coop-catalog', binding: 'COOP_DB' },
  ica: { envKey: 'ICA_DATABASE_ID', name: 'ica-catalog', binding: 'ICA_DB' },
};

type DatabaseRecord = { uuid: string; name?: string };
export type RetailerInitOperations = {
  findDatabase: (accountId: string, name: string) => Promise<DatabaseRecord | null>;
  createDatabase: (accountId: string, name: string) => Promise<DatabaseRecord>;
  save: (updates: Record<string, string>) => void;
  writeConfig: (env: NodeJS.ProcessEnv) => void;
  migrate: (databaseName: string) => Promise<unknown>;
};
export type RetailerInitOptions = {
  retailers?: RetailerId[];
  remote?: boolean;
  confirmCloudflare?: boolean;
  env?: NodeJS.ProcessEnv;
  operations?: Partial<RetailerInitOperations>;
};

const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const defaults = (env: NodeJS.ProcessEnv): RetailerInitOperations => ({
  async findDatabase(accountId, name) {
    const result = await cloudflare(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`) as DatabaseRecord[];
    return result.find(database => database.name === name) ?? null;
  },
  async createDatabase(accountId, name) {
    return await cloudflare(`/accounts/${accountId}/d1/database`, 'POST', { name, primary_location_hint: 'weur' }) as DatabaseRecord;
  },
  save: saveEnv,
  writeConfig: currentEnv => connectedConfig(currentEnv),
  async migrate(databaseName) { wrangler(['d1', 'migrations', 'apply', databaseName, '--remote']); },
});

/**
 * The default path is deliberately a local plan. Cloud setup requires every
 * explicit gate and injected operations keep the destructive boundary testable.
 */
export async function initializeRetailerDatabases(options: RetailerInitOptions = {}) {
  const env = options.env ?? process.env;
  const requested = options.retailers ?? [];
  if (requested.some(id => id !== 'coop' && id !== 'ica') || new Set(requested).size !== requested.length) {
    throw new Error('Choose each of coop or ica at most once');
  }
  const selected = requested.length ? requested : (['coop', 'ica'] as RetailerId[]);
  const gates = options.remote === true && options.confirmCloudflare === true && env.RETAILERS_CLOUD_ENABLED === 'true';
  if (!gates) {
    return { mode: 'local-plan' as const, retailers: selected.map(id => ({ retailer: id, ...retailerDatabases[id] })),
      instructions: 'No Cloudflare access was attempted. To initialize a selected retailer, use --retailer <coop|ica> --remote --confirm-cloudflare with RETAILERS_CLOUD_ENABLED=true.' };
  }

  // Validate all inputs before the first API/CLI operation.
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Invalid or missing CLOUDFLARE_ACCOUNT_ID');
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) throw new Error('Missing CLOUDFLARE_API_TOKEN');
  for (const id of ['coop','ica'] as const) {
    const existing = env[retailerDatabases[id].envKey]?.trim();
    if (existing && !validId(existing)) throw new Error(`Invalid ${retailerDatabases[id].envKey}`);
  }
  // Validate the base application IDs as connectedConfig will require them.
  for (const key of ['CLOUDFLARE_DATABASE_ID', 'MEAL_DATABASE_ID']) {
    const value = env[key]?.trim() ?? '';
    if (!validId(value)) throw new Error(`Invalid or missing ${key}`);
  }

  const ops = { ...defaults(env), ...options.operations };
  const chosen: Array<{ retailer: RetailerId; name: string; id: string }> = [];
  for (const retailer of selected) {
    const config = retailerDatabases[retailer];
    let id = env[config.envKey]?.trim();
    if (!id) {
      const found = await ops.findDatabase(accountId, config.name);
      const database = found ?? await ops.createDatabase(accountId, config.name);
      if (database.name && database.name !== config.name || !validId(database.uuid)) {
        throw new Error(`Cloudflare returned an invalid ${retailer} database record`);
      }
      id = database.uuid;
      // Save each confirmed ID immediately so a later migration failure is resumable.
      ops.save({ [config.envKey]: id });
      env[config.envKey] = id;
    }
    chosen.push({ retailer, name: config.name, id });
  }

  ops.writeConfig(env);
  for (const database of chosen) await ops.migrate(database.name);
  return { mode: 'cloud-initialized' as const, databases: chosen };
}

async function main() {
  const { values } = parseArgs({ options: {
    retailer: { type: 'string', multiple: true }, remote: { type: 'boolean', default: false },
    'confirm-cloudflare': { type: 'boolean', default: false },
  } });
  const retailers = (values.retailer ?? []) as RetailerId[];
  const result = await initializeRetailerDatabases({ retailers, remote: values.remote,
    confirmCloudflare: values['confirm-cloudflare'] });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Retailer database setup failed'); process.exitCode = 1; });
}

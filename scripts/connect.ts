import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, storeId } from '../src/config.ts';
import { D1DatabaseClient } from '../src/database.ts';
import { ask, cloudflare, hidden, saveEnv } from './helpers.ts';
import { deploy } from './deploy.ts';
import { connectGitHub } from './connect-github.ts';
import { cloudflareDeploymentKey, cloudflareSettingsComplete, deploymentSource, fingerprint, savedAnswers, SetupProgress } from './setup-progress.ts';

type CloudflareIO = { env: NodeJS.ProcessEnv; ask: typeof ask; hidden: typeof hidden; save: typeof saveEnv; cloudflare: typeof cloudflare;
  query: (sql: string) => Promise<unknown>; deploy: () => Promise<unknown>; log: (message: string) => void };

export async function connectCloudflare(progress: SetupProgress, options: Partial<CloudflareIO> = {}) {
  const io: CloudflareIO = { env: process.env, ask, hidden, save: saveEnv, cloudflare, query: sql => new D1DatabaseClient().query(sql), deploy, log: console.log, ...options };
  const answers = savedAnswers(io);
  const deploymentKey = () => cloudflareDeploymentKey(io.env, deploymentSource());
  // Older versions saved this URL only after deployment and API-secret upload succeeded.
  // Adopt that completed setup instead of forcing existing users through it again.
  if (cloudflareSettingsComplete(io.env) && !progress.done('Cloudflare setup recorded', 'v1')) {
    if (!io.env.CLOUDFLARE_FREE_CONFIRMED) { io.save({ CLOUDFLARE_FREE_CONFIRMED: 'free' }); io.env.CLOUDFLARE_FREE_CONFIRMED = 'free'; }
    progress.mark('Cloudflare address', fingerprint(io.env.CLOUDFLARE_ACCOUNT_ID, io.env.CLOUDFLARE_API_TOKEN));
    const schema = readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8');
    progress.mark('Database tables', fingerprint(io.env.CLOUDFLARE_ACCOUNT_ID, io.env.CLOUDFLARE_DATABASE_ID, schema));
    progress.mark('Cloudflare deployment', deploymentKey());
    progress.mark('Cloudflare setup recorded', 'v1');
    io.log('Found your completed Cloudflare setup. Continuing without repeating it.');
  }
  if (cloudflareSettingsComplete(io.env) && progress.done('Cloudflare deployment', deploymentKey())) {
    io.log('Cloudflare is already connected. Continuing with GitHub.'); return;
  }
  io.log('Use Cloudflare Workers Free. Your valid answers are saved immediately; rerunning continues from the last unfinished step.');
  await answers.value('CLOUDFLARE_FREE_CONFIRMED', 'Confirm your Cloudflare Workers plan is Free (type free)', v => v.toLowerCase() === 'free');
  io.log('Cloudflare token permissions: Account / D1 / Edit, Account / Workers Scripts / Edit, and Account / Account Settings / Read.');
  const accountId = await answers.value('CLOUDFLARE_ACCOUNT_ID', 'Cloudflare account ID', v => /^[a-f0-9]{32}$/i.test(v));
  const token = await answers.secret('CLOUDFLARE_API_TOKEN', 'Cloudflare API token');
  await answers.value('WILLYS_STORE_ID', 'Online catalogue store ID (2110 is Kungsbacka Hede)', v => /^\d{4,8}$/.test(v), storeId());
  if (!io.env.CATALOG_API_TOKEN) { const value = randomBytes(32).toString('base64url'); io.save({ CATALOG_API_TOKEN: value }); io.env.CATALOG_API_TOKEN = value; }
  await progress.run('Cloudflare address', fingerprint(accountId, token), async () => {
    const address = await io.cloudflare(`/accounts/${accountId}/workers/subdomain`, 'GET', undefined, true);
    if (!address?.subdomain) {
      const subdomain = await answers.value('CLOUDFLARE_WORKERS_SUBDOMAIN', 'Free workers.dev address prefix', v => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v), `willys-${accountId.slice(0, 8)}`);
      await io.cloudflare(`/accounts/${accountId}/workers/subdomain`, 'PUT', { subdomain });
    }
  });
  if (!io.env.CLOUDFLARE_DATABASE_ID) {
    const databases = await io.cloudflare(`/accounts/${accountId}/d1/database?name=willys-catalog`);
    let database = databases.find((d: any) => d.name === 'willys-catalog');
    if (!database) database = await io.cloudflare(`/accounts/${accountId}/d1/database`, 'POST', { name: 'willys-catalog', primary_location_hint: 'weur' });
    if (!database?.uuid) throw new Error('Cloudflare did not return a database ID');
    io.save({ CLOUDFLARE_DATABASE_ID: database.uuid }); io.env.CLOUDFLARE_DATABASE_ID = database.uuid;
  }
  const schema = readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8');
  await progress.run('Database tables', fingerprint(accountId, io.env.CLOUDFLARE_DATABASE_ID, schema), () => io.query(schema));
  mkdirSync('data', { recursive: true });
  await progress.run('Cloudflare deployment', deploymentKey(), io.deploy);
  progress.mark('Cloudflare setup recorded', 'v1');
}

export async function connect() {
  loadEnv();
  const progress = new SetupProgress();
  await connectCloudflare(progress);
  const answers = savedAnswers();
  const choice = await answers.value('CONNECT_GITHUB', 'Connect GitHub and enable daily refresh now? yes/no', v => ['yes', 'no'].includes(v.toLowerCase()), 'yes');
  if (choice.toLowerCase() === 'yes') await connectGitHub(progress);
  else console.log('Cloudflare is connected. Run npm run connect:github when ready.');
}
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try { await connect(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Connection setup failed'); console.error('Completed steps and valid answers are saved. Run npm run connect to resume.'); process.exitCode = 1; }
}

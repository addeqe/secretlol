import { loadEnv, storeId } from '../src/config.ts';
import { D1DatabaseClient, rows } from '../src/database.ts';
loadEnv();
try {
  const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_API_TOKEN', 'CATALOG_API_TOKEN',
    'CATALOG_API_URL', 'GITHUB_REPOSITORY', 'GITHUB_DISPATCH_TOKEN'];
  const missing = names.filter(name => !process.env[name]);
  console.table(names.map(name => ({ setting: name, configured: !!process.env[name] })));
  if (missing.length) throw new Error(`Connection still needs: ${missing.join(', ')}. Run npm run connect.`);
  const db = new D1DatabaseClient();
  const state = await rows(db, "SELECT s.* FROM snapshots s JOIN catalog_state c ON c.value=s.id WHERE c.key='active_snapshot'");
  if (!state.length) console.log('Database connected. The first full catalogue refresh has not completed yet.');
  else console.log(`Catalogue: ${state[0].product_count} products; ${state[0].store_name}; refreshed ${state[0].completed_at}`);
  const url = new URL('/status', process.env.CATALOG_API_URL);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.CATALOG_API_TOKEN}` } });
  if (response.status !== 200 && response.status !== 503) throw new Error(`Price service connection failed (HTTP ${response.status}).`);
  if (response.ok) {
    const status = await response.json() as any;
    if (status.store?.id !== storeId()) throw new Error('Worker store differs from sync configuration.');
    console.log(`Price service connected; catalogue ${status.fresh ? 'fresh' : 'stale'}.`);
  } else {
    const body = await response.json() as any;
    if (body.error !== 'catalogue_not_ready') throw new Error('Worker database/secret is not correctly connected.');
    console.log('Price service connected and waiting for its first catalogue.');
  }
  const github = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/sync.yml`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json' } });
  if (!github.ok) throw new Error(`GitHub trigger token/workflow check failed (HTTP ${github.status}).`);
  console.log('GitHub workflow/token connected. Verify the cron is listed in Cloudflare > Worker > Settings > Trigger Events.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Connection check failed'); process.exitCode = 1; }

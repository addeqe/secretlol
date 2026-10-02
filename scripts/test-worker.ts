import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalize } from '../src/products.ts';

const folder = resolve('data/worker-test'); mkdirSync(folder, { recursive: true });
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
const config = resolve('wrangler.jsonc');
const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_ACCOUNT_ID;
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/catalog.json', import.meta.url), 'utf8'));
const id = randomUUID(), date = new Date().toISOString(), token = 'local-worker-test-token-not-a-production-secret';
const quote = (value: unknown) => value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
let sql = readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8');
sql += '\nDELETE FROM catalog_entries; DELETE FROM snapshots; DELETE FROM price_history; DELETE FROM catalog_state;\n';
sql += `INSERT INTO snapshots VALUES(${[id, fixture.store.storeId, fixture.store.name, date, date, fixture.products.length, 'complete', '{}'].map(quote).join(',')});\n`;
for (const product of fixture.products) {
  const entry = normalize(product, 'TEST FIXTURE', date);
  sql += `INSERT INTO catalog_entries VALUES(${[id, entry.code, entry.name, entry.brand, entry.priceHash, date, JSON.stringify(entry)].map(quote).join(',')});\n`;
}
sql += `INSERT INTO catalog_state VALUES('active_snapshot',${quote(id)});\n`;
const seed = resolve(folder, 'seed.sql'); writeFileSync(seed, sql);
const seeded = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--local', '--config', config,
  '--persist-to', folder, '--file', seed], { env, encoding: 'utf8' });
if (seeded.status !== 0) throw new Error(`Local D1 test setup failed: ${seeded.stderr}`);
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); const chosen = typeof address === 'object' && address ? address.port : 0;
    server.close(() => resolvePort(chosen)); });
});
const child = spawn(process.execPath, [cli, 'dev', '--local', '--config', config, '--persist-to', folder,
  '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--var', `CATALOG_API_TOKEN:${token}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
const base = `http://127.0.0.1:${port}`, headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Local Worker exited before starting.');
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (ready) break; await sleep(100);
  }
  assert.ok(ready, 'Worker starts locally');
  assert.equal((await fetch(`${base}/status`)).status, 401);
  const status = await (await fetch(`${base}/status`, { headers })).json() as any;
  assert.equal(status.products, 2); assert.equal(status.store.id, 'TEST'); assert.equal(status.fresh, true);
  const list = await (await fetch(`${base}/catalog?limit=1`, { headers })).json() as any;
  assert.equal(list.products.length, 1); assert.ok(list.nextCursor);
  const next = await (await fetch(`${base}/catalog?limit=1&cursor=${encodeURIComponent(list.nextCursor)}`, { headers })).json() as any;
  assert.equal(next.products.length, 1); assert.notEqual(next.products[0].code, list.products[0].code);
  const prices = await (await fetch(`${base}/prices/query`, { method: 'POST', headers,
    body: JSON.stringify({ storeId: 'TEST', currency: 'SEK', products: [
      { productId: 'milk', willysCode: 'TEST_MILK_ST' }, { productId: 'orange', willysCode: 'TEST_ORANGE_KG', unit: 'g', packQuantity: 275 }
    ] }) })).json() as any;
  assert.equal(prices.prices.length, 2); assert.equal(prices.prices[1].price, 6.3);
  console.log('Local Cloudflare runtime: schema, private API, freshness, pagination and pack prices passed. No remote resources were used.');
} catch (error) {
  console.error(output.slice(-4000)); throw error;
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), sleep(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

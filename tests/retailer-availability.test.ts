import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, rows } from '../src/database.ts';
import { retailSchema, configureRetailDataset, publishRetailObservations, type RetailDataset } from '../src/retailers/storage.ts';
import { productIdentity } from '../src/retailers/identity.ts';
import { calendarWeekEnd } from '../src/price-freshness.ts';
import { retailerAvailability, lookupRetailConnections, lookupRetailContext } from '../worker/retailer-availability.ts';

const fixtureSource = JSON.parse(readFileSync(new URL('./fixtures/retailers/demo-coop.json', import.meta.url), 'utf8')) as RetailDataset;
const start = Date.parse('2026-10-08T10:00:00.000Z');
const manifest = { datasetId: 'a'.repeat(64), inventoryHash: fixtureSource.inventoryHash,
  distinctIngredients: fixtureSource.connections.length };

function makeFixture(now = start): RetailDataset {
  const data = structuredClone(fixtureSource);
  data.datasetId = manifest.datasetId;
  for (const observation of data.observations) {
    observation.checkedAt = new Date(now - 60_000).toISOString();
    observation.expiresAt = new Date(now + 60 * 60_000).toISOString();
  }
  for (const connection of data.connections) for (const approved of connection.approvedProducts) {
    const source = data.observations.find(observation => observation.product.id === approved.productId)!;
    approved.identity = productIdentity(source.product);
  }
  return data;
}

function makeDb() {
  const db = new LocalDatabase(':memory:');
  db.execute(retailSchema());
  const metrics = { connections: 0, products: 0, metadata: 0, activeRuns: 0, activeChecks: 0,
    batchCalls: 0, failActiveCheck: false };
  const d1 = { prepare(sql: string) {
    let params: Array<string | number | null> = [];
    const statement: any = { bind(...values: Array<string | number | null>) { params = values; return statement; },
      async first() {
        const normalized = sql.toLowerCase();
        if (normalized.includes('join retail_runs')) metrics.activeRuns++;
        if (normalized.includes('select s.active_run_id')) metrics.activeChecks++;
        const result = (await rows(db, sql, params))[0] ?? null;
        return metrics.failActiveCheck && normalized.includes('select s.active_run_id') && result
          ? { ...result, active_run_id: 'changed-active-run' } : result;
      },
      async all() {
        const normalized = sql.toLowerCase();
        if (normalized.includes('select s.active_run_id')) metrics.activeChecks++;
        if (normalized.includes('join retail_runs')) metrics.activeRuns++;
        if (normalized.includes('from retail_connections')) metrics.connections++;
        if (normalized.includes('from retail_products')) metrics.products++;
        if (normalized.includes('from retail_meta')) metrics.metadata++;
        let results=await rows(db, sql, params);
        if(metrics.failActiveCheck&&normalized.includes('select s.active_run_id'))results=results.map(row=>({...row,active_run_id:'changed-active-run'}));
        return { results, success: true };
      },
      async run() { await db.query(sql, params); return { success: true }; },
    };
    return statement;
  } } as unknown as D1Database;
  return { db, d1, metrics };
}

function withReadBatch(seeded: D1Database,
  db: LocalDatabase, metrics: ReturnType<typeof makeDb>['metrics']): D1Database {
  return { ...seeded, async batch(statements: D1PreparedStatement[]) {
    metrics.batchCalls++;
    assert.ok(statements.length===2||statements.length===3,'publication and selected names use bounded read batches');
    db.execute('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      db.execute('COMMIT');
      return results;
    } catch (error) {
      db.execute('ROLLBACK');
      throw error;
    }
  } } as unknown as D1Database;
}

async function seed(now = start, mutate?: (data: RetailDataset) => void) {
  const database = makeDb(), data = makeFixture(now);
  mutate?.(data);
  await configureRetailDataset(database.db, data);
  const tracked = new Set(data.connections.flatMap(connection => connection.approvedProducts.map(product => product.productId)));
  const observations = data.observations.filter(observation => tracked.has(observation.product.id));
  await publishRetailObservations(database.db, data.retailer, data.scope, observations,
    observations.map(observation => observation.product.id), now);
  return { ...database, data };
}

async function removeAvailabilitySummary(db: LocalDatabase) {
  const run = (await rows(db, 'SELECT id,report_json FROM retail_runs ORDER BY checked_at DESC LIMIT 1'))[0];
  const report = JSON.parse(String(run.report_json));
  delete report.availabilitySummary;
  await db.query('UPDATE retail_runs SET report_json=? WHERE id=?', [JSON.stringify(report), String(run.id)]);
}

test('legacy 24-hour run expiry supports current-week search and named links without full-table reads', async () => {
  const {db,d1,metrics} = await seed();
  try {
    const run = (await rows(db,'SELECT id,checked_at,report_json FROM retail_runs'))[0];
    const oldExpiry = new Date(Date.parse(String(run.checked_at)) + 86_400_000).toISOString();
    const report = JSON.parse(String(run.report_json));
    report.expiresAt = oldExpiry;
    await db.query('UPDATE retail_runs SET expires_at=?,report_json=? WHERE id=?',
      [oldExpiry,JSON.stringify(report),String(run.id)]);
    const now = start + 48 * 60 * 60_000;
    assert.ok(Date.parse(oldExpiry) < now);
    const env = {COOP_DB:d1};
    const current = await retailerAvailability(env,manifest,'coop',now);
    assert.equal(current.current,true);
    assert.deepEqual(current.brokenNames,[]);
    assert.equal(current.expiresAt,new Date(calendarWeekEnd(start)).toISOString());
    assert.equal(metrics.connections,0,'weekly policy preserves the publication-summary fast path');
    assert.equal(metrics.products,0);
    const links = await lookupRetailConnections(env,manifest,'coop',['rice','onion'],now);
    assert.ok(links.every(link=>link.status==='matched'));
    assert.ok(links.every(link=>Date.parse(link.expiresAt!)===calendarWeekEnd(start)));
    assert.equal((await retailerAvailability(env,manifest,'coop',calendarWeekEnd(start))).current,false);
  } finally {db.close();}
});

test('cold availability trusts the atomic publication summary; named lookup reads only requested rows', async () => {
  const { d1, metrics, data } = await seed();
  const env = { COOP_DB: d1 };
  const current = await retailerAvailability(env, manifest, 'coop', start);
  assert.equal(current.current, true);
  assert.equal(current.scope?.storeId, data.scope.storeId);
  assert.ok(current.runId);
  assert.equal(current.brokenNames.length, 0);
  assert.equal(metrics.connections, 0);
  assert.equal(metrics.products, 0);
  const links = await lookupRetailConnections(env, manifest, 'coop', ['rice', 'onion', 'not in inventory'], start);
  assert.equal(links.length, 3);
  assert.equal(links[0].productId, 'demo-rice-1kg');
  assert.equal(links[0].referencePrice?.amountOre, 1990);
  assert.equal(links[2].status, 'needs_review');
  assert.equal(links[2].productId, null);
  assert.equal(metrics.connections, 1);
  assert.equal(metrics.products, 1);
});

test('D1 publication batch returns a coherent metadata and active-run snapshot', async () => {
  const seeded = await seed();
  const batchedDb = withReadBatch(seeded.d1, seeded.db, seeded.metrics);
  const current = await retailerAvailability({ COOP_DB: batchedDb }, manifest, 'coop', start);
  const meta = Object.fromEntries((await rows(seeded.db, 'SELECT key,value FROM retail_meta')).map(row => [row.key, row.value]));
  const active = (await rows(seeded.db, `SELECT s.active_run_id,r.id,r.report_json FROM retail_scope_state s
    JOIN retail_runs r ON r.id=s.active_run_id WHERE s.scope_key=?`, [meta.reference_scope]))[0];
  const summary = JSON.parse(String(active.report_json)).availabilitySummary;
  assert.equal(current.current, true);
  assert.equal(current.runId, active.id);
  assert.equal(current.runId, active.active_run_id);
  assert.equal(meta.retailer, 'coop');
  assert.equal(meta.reference_scope, JSON.stringify(['coop', seeded.data.scope.storeId, 'pickup', null]));
  assert.equal(meta.connections_version, summary.connectionsVersion);
  assert.equal(meta.dataset_id, summary.datasetId);
  assert.equal(meta.inventory_hash, summary.inventoryHash);
  assert.equal(seeded.metrics.batchCalls, 1);
  assert.equal(seeded.metrics.activeRuns, 1);
  assert.equal(seeded.metrics.connections, 0);
  assert.equal(seeded.metrics.products, 0);
});

test('invalid publication summary returned by the D1 batch fails closed without legacy reads', async () => {
  const seeded = await seed();
  const run = (await rows(seeded.db, 'SELECT id,report_json FROM retail_runs'))[0];
  const report = JSON.parse(String(run.report_json));
  report.availabilitySummary.checkedProductCount++;
  await seeded.db.query('UPDATE retail_runs SET report_json=? WHERE id=?', [JSON.stringify(report), String(run.id)]);
  const batchedDb = withReadBatch(seeded.d1, seeded.db, seeded.metrics);
  const current = await retailerAvailability({ COOP_DB: batchedDb }, manifest, 'coop', start);
  assert.equal(current.current, false);
  assert.deepEqual(current.brokenNames, ['invalid_availability_summary']);
  assert.equal(seeded.metrics.batchCalls, 1);
  assert.equal(seeded.metrics.activeRuns, 1);
  assert.equal(seeded.metrics.connections, 0);
  assert.equal(seeded.metrics.products, 0);
});

test('batched named reads isolate malformed reviews and reject a changed active publication', async () => {
  const seeded=await seed();
  await seeded.db.query("UPDATE retail_connections SET document_json='invalid json' WHERE ingredient_name='onion'");
  const db=withReadBatch(seeded.d1,seeded.db,seeded.metrics);
  const context=await lookupRetailContext({COOP_DB:db},manifest,'coop',['rice','onion'],start);
  assert.equal(context.availability.current,true);
  assert.equal(context.links[0].productId,'demo-rice-1kg');
  assert.equal(context.links[1].productId,null);
  assert.equal(context.links[1].status,'needs_review');
  assert.equal(seeded.metrics.batchCalls,2,'publication and selected rows each need one binding call');
  seeded.metrics.failActiveCheck=true;
  const changed=await lookupRetailContext({COOP_DB:db},manifest,'coop',['rice'],start);
  assert.equal(changed.availability.current,false);
  assert.deepEqual(changed.links,[]);
});

test('lookup context performs one availability assessment and one strict active-run check', async () => {
  const seeded = await seed();
  const context = await lookupRetailContext({ COOP_DB: seeded.d1 }, manifest, 'coop', ['rice', 'onion'], start);
  assert.equal(context.availability.current, true);
  assert.deepEqual(context.links.map(link => link.name), ['rice', 'onion']);
  assert.equal(seeded.metrics.metadata, 1);
  assert.equal(seeded.metrics.activeRuns, 1);
  assert.equal(seeded.metrics.activeChecks, 1);
  assert.equal(seeded.metrics.connections, 1);
  assert.equal(seeded.metrics.products, 1);
});

test('lookup context fails availability closed when the active run changes before named reads', async () => {
  const seeded = await seed();
  seeded.metrics.failActiveCheck = true;
  const context = await lookupRetailContext({ COOP_DB: seeded.d1 }, manifest, 'coop', ['rice'], start);
  assert.equal(context.availability.current, false);
  assert.equal(context.availability.runId !== null, true);
  assert.deepEqual(context.availability.brokenNames, ['active_run_changed']);
  assert.deepEqual(context.links, []);
  assert.equal(seeded.metrics.activeRuns, 1);
  assert.equal(seeded.metrics.activeChecks, 1);
  assert.equal(seeded.metrics.connections, 0);
  assert.equal(seeded.metrics.products, 0);
});

test('new active run and connection version each invalidate the weak-map cache', async () => {
  const { db, d1, metrics, data } = await seed();
  const env = { COOP_DB: d1 };
  await retailerAvailability(env, manifest, 'coop', start);
  await retailerAvailability(env, manifest, 'coop', start);
  assert.equal(metrics.connections, 0);
  const later = start + 120_000;
  const refreshed = makeFixture(later);
  await publishRetailObservations(db, 'coop', refreshed.scope, refreshed.observations,
    refreshed.observations.map(observation => observation.product.id), later);
  assert.notEqual((await retailerAvailability(env, manifest, 'coop', later)).runId, null);
  assert.equal(metrics.connections, 0);
  await db.query("UPDATE retail_meta SET value='v2' WHERE key='connections_version'");
  assert.equal((await retailerAvailability(env, manifest, 'coop', later)).current, false);
  assert.equal(metrics.connections, 0);
  assert.equal(data.connections.length, manifest.distinctIngredients);
});

test('publication summary contains unavailable names and invalid summaries fail closed', async () => {
  const unavailable = await seed(start, data => {
    const eggs = data.connections.find(connection => connection.name === 'eggs')!;
    eggs.status = 'unavailable'; eggs.mainProductId = null; eggs.approvedProducts = [];
  });
  const current = await retailerAvailability({ COOP_DB: unavailable.d1 }, manifest, 'coop', start);
  assert.equal(current.current, true);
  assert.deepEqual(current.brokenNames, ['eggs']);
  assert.equal(unavailable.metrics.connections, 0);
  const reportRow = (await rows(unavailable.db, 'SELECT report_json FROM retail_runs'))[0];
  const report = JSON.parse(String(reportRow.report_json));
  assert.equal(report.availabilitySummary.distinctIngredients, manifest.distinctIngredients);
  assert.equal(report.availabilitySummary.checkedProductCount, unavailable.data.connections
    .flatMap(connection => connection.approvedProducts).length);
  assert.deepEqual(report.availabilitySummary.brokenNames, ['eggs']);

  const invalid = await seed();
  const row = (await rows(invalid.db, 'SELECT id,report_json FROM retail_runs'))[0];
  const bad = JSON.parse(String(row.report_json));
  bad.availabilitySummary.checkedProductCount += 1;
  await invalid.db.query('UPDATE retail_runs SET report_json=? WHERE id=?', [JSON.stringify(bad), String(row.id)]);
  const rejected = await retailerAvailability({ COOP_DB: invalid.d1 }, manifest, 'coop', start);
  assert.equal(rejected.current, false);
  assert.deepEqual(rejected.brokenNames, ['invalid_availability_summary']);
  assert.equal(invalid.metrics.connections, 0);
  assert.equal(invalid.metrics.products, 0);

  const missingRunId = await seed();
  const activeRun = (await rows(missingRunId.db, 'SELECT r.id,r.checked_ids_json FROM retail_scope_state s JOIN retail_runs r ON r.id=s.active_run_id'))[0];
  const checked = JSON.parse(String(activeRun.checked_ids_json)) as string[];
  checked.pop();
  await missingRunId.db.query('UPDATE retail_runs SET checked_ids_json=? WHERE id=?', [JSON.stringify(checked), String(activeRun.id)]);
  assert.equal((await retailerAvailability({ COOP_DB: missingRunId.d1 }, manifest, 'coop', start)).current, false);
});

test('publisher refuses stale policy metadata before creating a trusted summary', async () => {
  const seeded = await seed();
  await seeded.db.query("UPDATE retail_meta SET value='older-policy' WHERE key='policy_version'");
  await assert.rejects(() => publishRetailObservations(seeded.db, 'coop', seeded.data.scope,
    seeded.data.observations, seeded.data.observations.map(observation => observation.product.id), start),
  /retail_policy_version_mismatch/);
});

test('legacy runs without a summary use the old full validation path', async () => {
  const legacy = await seed();
  await removeAvailabilitySummary(legacy.db);
  const current = await retailerAvailability({ COOP_DB: legacy.d1 }, manifest, 'coop', start);
  assert.equal(current.current, true);
  assert.equal(legacy.metrics.connections, 1);
  assert.equal(legacy.metrics.products, 1);
});

test('named lookup reads only requested records and missing connection IDs stay unresolved', async () => {
  const seeded = await seed();
  await seeded.db.query("DELETE FROM retail_connections WHERE ingredient_name='rice'");
  const links = await lookupRetailConnections({ COOP_DB: seeded.d1 }, manifest, 'coop', ['rice'], start);
  assert.equal(links[0].status, 'needs_review');
  assert.equal(links[0].productId, null);
  assert.equal(seeded.metrics.connections, 1);
  assert.equal(seeded.metrics.products, 0);
});

test('batched validation isolates a malformed selected connection while sharing identities', async () => {
  const seeded = await seed(start, data => {
    const rice = data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
    const onion = data.connections.find(connection => connection.name === 'onion')!;
    onion.mainProductId = rice.product.id;
    onion.approvedProducts = [{ productId: rice.product.id, identity: productIdentity(rice.product) }];
  });
  const onionRow = (await rows(seeded.db, "SELECT document_json FROM retail_connections WHERE ingredient_name='onion'"))[0];
  const onion = JSON.parse(String(onionRow.document_json));
  onion.policyVersion = 'stale-policy';
  await seeded.db.query("UPDATE retail_connections SET document_json=? WHERE ingredient_name='onion'", [JSON.stringify(onion)]);
  const links = await lookupRetailConnections({ COOP_DB: seeded.d1 }, manifest, 'coop', ['rice', 'onion'], start);
  assert.equal(links[0].status, 'matched');
  assert.equal(links[0].productId, 'demo-rice-1kg');
  assert.equal(links[1].status, 'needs_review');
  assert.equal(links[1].productId, null);
});

test('stale prices and changed identities break only affected names; missing connections fail closed', async () => {
  const stale = await seed();
  await removeAvailabilitySummary(stale.db);
  const rice = stale.data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
  rice.price!.validUntil = new Date(start - 1).toISOString();
  await stale.db.query('UPDATE retail_products SET observation_json=? WHERE product_id=?', [JSON.stringify(rice), rice.product.id]);
  const staleResult = await retailerAvailability({ COOP_DB: stale.d1 }, manifest, 'coop', start);
  assert.equal(staleResult.current, true);
  assert.ok(staleResult.brokenNames.includes('rice'));

  const changed = await seed();
  await removeAvailabilitySummary(changed.db);
  const changedRice = changed.data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
  changedRice.product.name = 'Different product';
  await changed.db.query('UPDATE retail_products SET observation_json=? WHERE product_id=?', [JSON.stringify(changedRice), changedRice.product.id]);
  const changedResult = await retailerAvailability({ COOP_DB: changed.d1 }, manifest, 'coop', start);
  assert.equal(changedResult.current, true);
  assert.ok(changedResult.brokenNames.includes('rice'));
  assert.equal(changedResult.brokenNames.length, 1);

  const missing = await seed();
  await removeAvailabilitySummary(missing.db);
  await missing.db.query("DELETE FROM retail_connections WHERE ingredient_name='rice'");
  await missing.db.query("UPDATE retail_meta SET value='v2' WHERE key='connections_version'");
  const missingResult = await retailerAvailability({ COOP_DB: missing.d1 }, manifest, 'coop', start);
  assert.equal(missingResult.current, false);
  assert.ok(missingResult.brokenNames.includes('inventory_incomplete'));

  const noVersion = await seed();
  await noVersion.db.query("DELETE FROM retail_meta WHERE key='connections_version'");
  assert.equal((await retailerAvailability({ COOP_DB: noVersion.d1 }, manifest, 'coop', start)).current, false);

  const invalidWater = await seed();
  await removeAvailabilitySummary(invalidWater.db);
  const invalidRice = invalidWater.data.connections.find(connection => connection.name === 'rice')!;
  invalidRice.status = 'non_purchased'; invalidRice.mainProductId = null; invalidRice.approvedProducts = [];
  await invalidWater.db.query("UPDATE retail_connections SET status='non_purchased',document_json=? WHERE ingredient_name='rice'", [JSON.stringify(invalidRice)]);
  await invalidWater.db.query("UPDATE retail_meta SET value='invalid-water-version' WHERE key='connections_version'");
  const invalidWaterResult = await retailerAvailability({ COOP_DB: invalidWater.d1 }, manifest, 'coop', start);
  assert.equal(invalidWaterResult.current, true);
  assert.deepEqual(invalidWaterResult.brokenNames, ['rice']);
});

test('a fresh coherent run remains current when some connections need review; valid reserves are selected', async () => {
  const { db, d1, data } = await seed();
  await removeAvailabilitySummary(db);
  const unavailable = data.connections.find(connection => connection.name === 'eggs')!;
  unavailable.status = 'unavailable'; unavailable.mainProductId = null; unavailable.approvedProducts = [];
  await db.query("UPDATE retail_connections SET status='unavailable',document_json=? WHERE ingredient_name='eggs'", [JSON.stringify(unavailable)]);
  await db.query("UPDATE retail_meta SET value='version-with-unavailable-eggs' WHERE key='connections_version'");
  const availability = await retailerAvailability({ COOP_DB: d1 }, manifest, 'coop', start);
  assert.equal(availability.current, true);
  assert.deepEqual(availability.brokenNames, ['eggs']);

  const reserve = await seed();
  await removeAvailabilitySummary(reserve.db);
  const riceConnection = reserve.data.connections.find(connection => connection.name === 'rice')!;
  const rice = reserve.data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
  const onion = reserve.data.observations.find(observation => observation.product.id === 'demo-onion-each')!;
  riceConnection.approvedProducts.push({ productId: onion.product.id, identity: productIdentity(onion.product) });
  await reserve.db.query('UPDATE retail_connections SET document_json=? WHERE ingredient_name=?', [JSON.stringify(riceConnection), 'rice']);
  await reserve.db.query("UPDATE retail_meta SET value='version-with-reserve' WHERE key='connections_version'");
  rice.availability = 'unavailable';
  await reserve.db.query('UPDATE retail_products SET observation_json=? WHERE product_id=?', [JSON.stringify(rice), rice.product.id]);
  const links = await lookupRetailConnections({ COOP_DB: reserve.d1 }, manifest, 'coop', ['rice'], start);
  assert.equal(links[0].status, 'matched');
  assert.equal(links[0].productId, onion.product.id);
  assert.equal(links[0].referencePrice?.amountOre, onion.price?.amountOre);
});

test('more than 400 approved IDs remain within full-inventory bounds', async () => {
  const db = makeDb(), observations: RetailDataset['observations'] = [], connections: RetailDataset['connections'] = [];
  const data = makeFixture();
  for (let i = 0; i < 134; i++) {
    const approvedProducts = [];
    for (let j = 0; j < 3; j++) {
      const id = `bulk-${i}-${j}`;
      const product = { id, ean: null, name: `Demo dry item ${i}-${j}`, brand: 'Demo', categories: ['Skafferi'],
        pack: { quantity: 1, unit: 'g' as const, approximate: false }, ingredientsText: null };
      const observation = { retailer: 'coop' as const, scope: data.scope, product,
        price: { amountOre: 100, basis: 'pack' as const, depositOre: 0, memberOnly: false,
          minimumQuantity: null, validFrom: null, validUntil: null }, availability: 'available' as const,
        checkedAt: new Date(start - 60_000).toISOString(), expiresAt: new Date(start + 60 * 60_000).toISOString(),
        storeScopeVerified: true };
      observations.push(observation);
      approvedProducts.push({ productId: id, identity: productIdentity(product) });
    }
    connections.push({ ingredientId: `bulk-ing-${i}`, name: `bulk ingredient ${i}`, foodId: null,
      status: 'matched', mainProductId: approvedProducts[0].productId, approvedProducts,
      policyVersion: data.connections[0].policyVersion, reviewedAt: new Date(start - 60_000).toISOString(), reason: 'Reviewed fixture mapping' });
  }
  const expanded = { ...data, observations, connections };
  await configureRetailDataset(db.db, expanded);
  await publishRetailObservations(db.db, 'coop', expanded.scope, observations, observations.map(o => o.product.id), start);
  const expandedManifest = { ...manifest, distinctIngredients: connections.length };
  const availability = await retailerAvailability({ COOP_DB: db.d1 }, expandedManifest, 'coop', start);
  assert.equal(availability.current, true);
  assert.deepEqual(availability.brokenNames, []);
});

test('future valid-from price boundaries trigger a current-time health recomputation', async () => {
  const seeded = await seed();
  const rice = seeded.data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
  rice.checkedAt = new Date(start + 1_000).toISOString();
  rice.price!.validFrom = new Date(start + 5 * 60_000).toISOString();
  await publishRetailObservations(seeded.db, 'coop', seeded.data.scope, seeded.data.observations,
    seeded.data.observations.map(observation => observation.product.id), start);
  const result = await retailerAvailability({ COOP_DB: seeded.d1 }, manifest, 'coop', start);
  assert.equal(result.current, true);
  assert.ok(result.expiresAt);
  assert.equal(Date.parse(result.expiresAt!), start + 5 * 60_000);
  assert.ok(result.brokenNames.includes('rice'));
  const afterBoundary = await retailerAvailability({ COOP_DB: seeded.d1 }, manifest, 'coop', start + 5 * 60_000);
  assert.equal(afterBoundary.current, true);
  assert.ok(!afterBoundary.brokenNames.includes('rice'));
  assert.equal(seeded.metrics.connections, 1);
  assert.equal(seeded.metrics.products, 1);
});

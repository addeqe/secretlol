import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, rows } from '../src/database.ts';
import { retailSchema, configureRetailDataset, publishRetailObservations, type RetailDataset } from '../src/retailers/storage.ts';
import { productIdentity } from '../src/retailers/identity.ts';
import { retailerAvailability, lookupRetailConnections } from '../worker/retailer-availability.ts';

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
  const metrics = { connections: 0, products: 0 };
  const d1 = { prepare(sql: string) {
    let params: Array<string | number | null> = [];
    const statement: any = { bind(...values: Array<string | number | null>) { params = values; return statement; },
      async first() { return (await rows(db, sql, params))[0] ?? null; },
      async all() {
        const normalized = sql.toLowerCase();
        if (normalized.includes('from retail_connections')) metrics.connections++;
        if (normalized.includes('from retail_products')) metrics.products++;
        return { results: await rows(db, sql, params), success: true };
      },
      async run() { await db.query(sql, params); return { success: true }; },
    };
    return statement;
  } } as unknown as D1Database;
  return { db, d1, metrics };
}

async function seed(now = start) {
  const database = makeDb(), data = makeFixture(now);
  await configureRetailDataset(database.db, data);
  await publishRetailObservations(database.db, data.retailer, data.scope, data.observations,
    data.observations.map(observation => observation.product.id), now);
  return { ...database, data };
}

test('cold availability validates all connections and products; warm lookup reuses cached state', async () => {
  const { d1, metrics, data } = await seed();
  const env = { COOP_DB: d1 };
  const current = await retailerAvailability(env, manifest, 'coop', start);
  assert.equal(current.current, true);
  assert.equal(current.scope?.storeId, data.scope.storeId);
  assert.ok(current.runId);
  assert.equal(current.brokenNames.length, 0);
  assert.equal(metrics.connections, 1);
  assert.equal(metrics.products, 1);
  const links = await lookupRetailConnections(env, manifest, 'coop', ['rice', 'onion', 'not in inventory'], start);
  assert.equal(links.length, 3);
  assert.equal(links[0].productId, 'demo-rice-1kg');
  assert.equal(links[0].referencePrice?.amountOre, 1990);
  assert.equal(links[2].status, 'needs_review');
  assert.equal(links[2].productId, null);
  assert.equal(metrics.connections, 1);
  assert.equal(metrics.products, 1);
});

test('new active run and connection version each invalidate the weak-map cache', async () => {
  const { db, d1, metrics, data } = await seed();
  const env = { COOP_DB: d1 };
  await retailerAvailability(env, manifest, 'coop', start);
  await retailerAvailability(env, manifest, 'coop', start);
  assert.equal(metrics.connections, 1);
  const later = start + 120_000;
  const refreshed = makeFixture(later);
  await publishRetailObservations(db, 'coop', refreshed.scope, refreshed.observations,
    refreshed.observations.map(observation => observation.product.id), later);
  assert.notEqual((await retailerAvailability(env, manifest, 'coop', later)).runId, null);
  assert.equal(metrics.connections, 2);
  await db.query("UPDATE retail_meta SET value='v2' WHERE key='connections_version'");
  assert.equal((await retailerAvailability(env, manifest, 'coop', later)).current, true);
  assert.equal(metrics.connections, 3);
  assert.equal(data.connections.length, manifest.distinctIngredients);
});

test('stale prices and changed identities break only affected names; missing connections fail closed', async () => {
  const stale = await seed();
  const rice = stale.data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
  rice.price!.validUntil = new Date(start - 1).toISOString();
  await stale.db.query('UPDATE retail_products SET observation_json=? WHERE product_id=?', [JSON.stringify(rice), rice.product.id]);
  const staleResult = await retailerAvailability({ COOP_DB: stale.d1 }, manifest, 'coop', start);
  assert.equal(staleResult.current, true);
  assert.ok(staleResult.brokenNames.includes('rice'));

  const changed = await seed();
  const changedRice = changed.data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
  changedRice.product.name = 'Different product';
  await changed.db.query('UPDATE retail_products SET observation_json=? WHERE product_id=?', [JSON.stringify(changedRice), changedRice.product.id]);
  const changedResult = await retailerAvailability({ COOP_DB: changed.d1 }, manifest, 'coop', start);
  assert.equal(changedResult.current, true);
  assert.ok(changedResult.brokenNames.includes('rice'));
  assert.equal(changedResult.brokenNames.length, 1);

  const missing = await seed();
  await missing.db.query("DELETE FROM retail_connections WHERE ingredient_name='rice'");
  await missing.db.query("UPDATE retail_meta SET value='v2' WHERE key='connections_version'");
  const missingResult = await retailerAvailability({ COOP_DB: missing.d1 }, manifest, 'coop', start);
  assert.equal(missingResult.current, false);
  assert.ok(missingResult.brokenNames.includes('inventory_incomplete'));

  const noVersion = await seed();
  await noVersion.db.query("DELETE FROM retail_meta WHERE key='connections_version'");
  assert.equal((await retailerAvailability({ COOP_DB: noVersion.d1 }, manifest, 'coop', start)).current, false);

  const invalidWater = await seed();
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
  const unavailable = data.connections.find(connection => connection.name === 'eggs')!;
  unavailable.status = 'unavailable'; unavailable.mainProductId = null; unavailable.approvedProducts = [];
  await db.query("UPDATE retail_connections SET status='unavailable',document_json=? WHERE ingredient_name='eggs'", [JSON.stringify(unavailable)]);
  await db.query("UPDATE retail_meta SET value='version-with-unavailable-eggs' WHERE key='connections_version'");
  const availability = await retailerAvailability({ COOP_DB: d1 }, manifest, 'coop', start);
  assert.equal(availability.current, true);
  assert.deepEqual(availability.brokenNames, ['eggs']);

  const reserve = await seed();
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

test('future valid-from price boundaries expire cached state at the boundary', async () => {
  const seeded = await seed();
  const rice = seeded.data.observations.find(observation => observation.product.id === 'demo-rice-1kg')!;
  rice.price!.validFrom = new Date(start + 5 * 60_000).toISOString();
  await seeded.db.query('UPDATE retail_products SET observation_json=? WHERE product_id=?', [JSON.stringify(rice), rice.product.id]);
  const result = await retailerAvailability({ COOP_DB: seeded.d1 }, manifest, 'coop', start);
  assert.equal(result.current, true);
  assert.ok(result.expiresAt);
  assert.equal(Date.parse(result.expiresAt!), start + 5 * 60_000);
  assert.ok(result.brokenNames.includes('rice'));
});

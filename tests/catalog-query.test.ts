import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase, rows } from '../src/database.ts';
import { normalize } from '../src/products.ts';
import { publish } from '../src/publish.ts';
import { catalogStorageSchema, seedCatalogStorage } from '../src/catalog-storage.ts';
import { catalogProductLookupSql, catalogAvailabilityLookupSql, catalogPageSql } from '../src/catalog-query.ts';
import type { SourceProduct, Store } from '../src/types.ts';

const store: Store = { storeId: '2110', name: 'Test store', onlineStore: true };
const source: SourceProduct = { code: 'LOOKUP_ST', name: 'Lookup product', priceValue: 3.5, priceUnit: 'kr/st',
  depositPrice: '', online: true, outOfStock: false, addToCartDisabled: false, potentialPromotions: [] };
function dbFixture() {
  const db = new LocalDatabase(':memory:');
  db.execute(readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8'));
  db.execute(catalogStorageSchema());
  return db;
}
function plan(db: LocalDatabase, expression: string, snapshotId: string) {
  return rows(db, `EXPLAIN QUERY PLAN SELECT ${expression} FROM (SELECT 'LOOKUP_ST' AS selected_code) l`,
    [snapshotId, snapshotId]);
}

test('catalog scalar hydration stays indexed and matches the compatibility view across legacy and temporal snapshots', async () => {
  const db = dbFixture();
  try {
    const entry = normalize(source, 'Test', new Date().toISOString());
    const first = await publish(db, { store, entries: [entry], categories: [], requests: 0,
      startedAt: entry.observedAt, completedAt: entry.observedAt });
    const legacySql = catalogProductLookupSql('l.selected_code');
    const legacyPlan = await plan(db, legacySql, first.snapshotId);
    const legacyDetails = legacyPlan.map(row => String(row.detail));
    assert.ok(legacyDetails.some(detail => /SEARCH e USING PRIMARY KEY \(snapshot_id=\? AND code=\?\)/.test(detail)), legacyDetails.join('\n'));
    assert.ok(!legacyDetails.some(detail => /MATERIALIZE catalog_entries_read/.test(detail)), legacyDetails.join('\n'));
    const legacy = (await rows(db, `SELECT ${legacySql} AS result FROM (SELECT 'LOOKUP_ST' AS selected_code) l`,
      [first.snapshotId, first.snapshotId]))[0];
    const legacyView = (await rows(db, 'SELECT data_json FROM catalog_entries_read WHERE snapshot_id=? AND code=?', [first.snapshotId, 'LOOKUP_ST']))[0];
    const legacyHydrated = JSON.parse(String(legacy.result));
    assert.equal(legacyHydrated.product.code, 'LOOKUP_ST');
    assert.equal(legacyHydrated.product.observedAt, JSON.parse(String(legacyView.data_json)).observedAt);

    await seedCatalogStorage(db, first.snapshotId);
    const temporalPlan = await plan(db, legacySql, first.snapshotId);
    const temporalDetails = temporalPlan.map(row => String(row.detail));
    assert.ok(temporalDetails.some(detail => /SEARCH v USING PRIMARY KEY \(store_id=\? AND code=\? AND valid_from<\?\)/.test(detail)), temporalDetails.join('\n'));
    assert.ok(!temporalDetails.some(detail => /MATERIALIZE catalog_entries_read/.test(detail)), temporalDetails.join('\n'));
    const temporal = (await rows(db, `SELECT ${legacySql} AS result FROM (SELECT 'LOOKUP_ST' AS selected_code) l`,
      [first.snapshotId, first.snapshotId]))[0];
    const temporalView = (await rows(db, 'SELECT data_json FROM catalog_entries_read WHERE snapshot_id=? AND code=?', [first.snapshotId, 'LOOKUP_ST']))[0];
    const temporalHydrated = JSON.parse(String(temporal.result));
    assert.equal(temporalHydrated.product.code, 'LOOKUP_ST');
    assert.equal(temporalHydrated.product.observedAt, JSON.parse(String(temporalView.data_json)).observedAt);

    const availabilitySql = catalogAvailabilityLookupSql('l.selected_code');
    const availabilityPlan = await plan(db, availabilitySql, first.snapshotId);
    const availabilityDetails = availabilityPlan.map(row => String(row.detail));
    assert.ok(availabilityDetails.some(detail => /SEARCH v USING PRIMARY KEY \(store_id=\? AND code=\? AND valid_from<\?\)/.test(detail)), availabilityDetails.join('\n'));
    assert.ok(!availabilityDetails.some(detail => /MATERIALIZE catalog_entries_read/.test(detail)), availabilityDetails.join('\n'));
    const availability = (await rows(db, `SELECT ${availabilitySql} AS result FROM (SELECT 'LOOKUP_ST' AS selected_code) l`,
      [first.snapshotId, first.snapshotId]))[0];
    assert.deepEqual(JSON.parse(String(availability.result)), { available: 1, offers: [], observedAt: entry.observedAt });
  } finally { db.close(); }
});

test('catalog pages bound each storage branch and preserve keyset order for legacy and temporal snapshots', async () => {
  const db = dbFixture();
  try {
    const observedAt = new Date().toISOString();
    const entries = ['PAGE_A_ST', 'PAGE_B_ST', 'PAGE_C_ST', 'PAGE_D_ST'].map(code => normalize({ ...source, code }, 'Test', observedAt));
    const scan = { store, entries, categories: [], requests: 0, startedAt: observedAt, completedAt: observedAt };
    const temporal = await publish(db, scan);
    const temporalId = temporal.snapshotId;
    const legacyId = 'legacy-page-snapshot';
    await db.query("INSERT INTO snapshots VALUES(?,?,?,?,?,?,'complete','{}')", [legacyId, store.storeId, store.name, observedAt, observedAt, entries.length]);
    for (const entry of entries) {
      const data = { ...entry, price: { priceOre: entry.priceOre, priceUnit: entry.priceUnit,
        comparePriceOre: entry.comparePriceOre, comparePriceUnit: entry.comparePriceUnit,
        depositOre: entry.depositOre, offers: entry.offers, sourcePricing: entry.sourcePricing } };
      await db.query('INSERT INTO catalog_entries VALUES(?,?,?,?,?,?,?)', [legacyId, entry.code, entry.name,
        entry.brand, entry.priceHash, entry.observedAt, JSON.stringify(data)]);
    }

    const sql = catalogPageSql();
    const plan = await rows(db, `EXPLAIN QUERY PLAN ${sql}`, [temporalId, '', 3, temporalId, '', 3, 3]);
    const details = plan.map(row => String(row.detail));
    assert.ok(details.some(detail => /SEARCH e USING PRIMARY KEY \(snapshot_id=\? AND code>\?\)/.test(detail)), details.join('\n'));
    assert.ok(details.some(detail => /SEARCH v USING PRIMARY KEY \(store_id=\? AND code>\?\)/.test(detail)), details.join('\n'));
    assert.ok(!details.some(detail => /SCAN catalog_entries_read/.test(detail)), details.join('\n'));

    for (const snapshotId of [legacyId, temporalId]) {
      for (const after of ['', 'PAGE_B_ST']) {
        const pageRows = await rows(db, sql, [snapshotId, after, 3, snapshotId, after, 3, 3]);
        const expected = await rows(db, `SELECT code,json_remove(data_json,'$.raw','$.price','$.priceHash') AS data_json
          FROM catalog_entries_read WHERE snapshot_id=? AND code>? ORDER BY code LIMIT 3`, [snapshotId, after]);
        assert.deepEqual(pageRows.map(row => row.code), expected.map(row => row.code));
        assert.deepEqual(pageRows.map(row => JSON.parse(String(row.data_json))), expected.map(row => JSON.parse(String(row.data_json))));
      }
    }
  } finally { db.close(); }
});

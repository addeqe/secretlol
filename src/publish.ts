import { randomUUID } from 'node:crypto';
import { integer } from './config.ts';
import { D1DatabaseClient, rows } from './database.ts';
import type { Database, Entry, Scan } from './types.ts';

const priceView = (entry: Entry) => ({ priceOre: entry.priceOre, priceUnit: entry.priceUnit,
  comparePriceOre: entry.comparePriceOre, comparePriceUnit: entry.comparePriceUnit,
  depositOre: entry.depositOre, offers: entry.offers, sourcePricing: entry.sourcePricing });
export async function publish(database: Database, scan: Scan, options: { allowShrink?: boolean; historyDays?: number } = {}) {
  const id = randomUUID(), now = new Date().toISOString();
  await database.query(`INSERT INTO sync_lock(id, owner, expires_at) VALUES(1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
    WHERE sync_lock.expires_at < ?`, [id, new Date(Date.now() + 20 * 60000).toISOString(), now]);
  if ((await rows(database, 'SELECT owner FROM sync_lock WHERE id=1'))[0]?.owner !== id) throw new Error('Another sync is publishing. Retry later.');
  try {
    const previousId = String((await rows(database, "SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0]?.value ?? '');
    const previous = (await rows(database, 'SELECT * FROM snapshots WHERE id=?', [previousId]))[0];
    if (previous && previous.store_id !== scan.store.storeId) throw new Error('Database belongs to a different store. Use a separate database for another store.');
    if (previous && !options.allowShrink && scan.entries.length < Number(previous.product_count) * 0.8) {
      throw new Error('Catalogue shrank by more than 20%. Previous catalogue retained. Verify the source, then use --allow-shrink for a confirmed change.');
    }
    // Reclaim previous abandoned/stale staging data in small bounded batches.
    let deleted = 0;
    while (true) {
      const old = await rows(database, 'SELECT snapshot_id, code FROM catalog_entries WHERE snapshot_id != ? LIMIT 500', [previousId]);
      if (!old.length) break;
      await database.query(`DELETE FROM catalog_entries WHERE (snapshot_id, code) IN
        (SELECT json_extract(value,'$.snapshot_id'), json_extract(value,'$.code') FROM json_each(?))`, [JSON.stringify(old)]);
      deleted += old.length;
      if (deleted > 40000) throw new Error('Cleanup budget exceeded. Retry before collecting another catalogue.');
    }
    await database.query('DELETE FROM snapshots WHERE id != ?', [previousId]);
    const oldest = new Date(Date.now() - (options.historyDays ?? integer('HISTORY_DAYS', 90, 1, 365)) * 86400000).toISOString();
    await database.query(`DELETE FROM price_history WHERE (store_id, code, observed_at) IN
      (SELECT store_id, code, observed_at FROM price_history WHERE observed_at < ? LIMIT 2000)`, [oldest]);
    if (database instanceof D1DatabaseClient) {
      // Estimate staging + maximum initial history writes, leave headroom for publication.
      if (database.rowsWritten + scan.entries.length * 2 + 100 > integer('MAX_D1_ROWS_WRITTEN', 80000)) {
        throw new Error('This catalogue cannot fit this run’s write budget. No new snapshot published.');
      }
      const bytes = Buffer.byteLength(JSON.stringify(scan.entries));
      if (database.sizeBytes + bytes * 1.5 > integer('MAX_D1_SIZE_MB', 400) * 1024 * 1024) throw new Error('Catalogue would exceed the configured storage budget.');
    }
    const report = JSON.stringify({ categories: scan.categories, requests: scan.requests });
    await database.query(`INSERT INTO snapshots(id, store_id, store_name, started_at, completed_at, product_count, status, report_json)
      VALUES(?, ?, ?, ?, NULL, ?, 'staging', ?)`, [id, scan.store.storeId, scan.store.name, scan.startedAt, scan.entries.length, report]);
    // JSON parameters avoid D1's 100-bind-parameter limit; each request stays small.
    for (let offset = 0; offset < scan.entries.length; offset += 100) {
      const batch = scan.entries.slice(offset, offset + 100).map(entry => ({ ...entry, price: priceView(entry) }));
      await database.query(`INSERT INTO catalog_entries(snapshot_id, code, name, brand, price_hash, observed_at, data_json)
        SELECT ?, json_extract(value,'$.code'), json_extract(value,'$.name'), json_extract(value,'$.brand'),
        json_extract(value,'$.priceHash'), json_extract(value,'$.observedAt'), value FROM json_each(?)`, [id, JSON.stringify(batch)]);
    }
    const count = Number((await rows(database, 'SELECT COUNT(*) AS n FROM catalog_entries WHERE snapshot_id=?', [id]))[0]?.n);
    if (count !== scan.entries.length) throw new Error('Staged catalogue count mismatch. Previous snapshot retained.');
    if ((await rows(database, 'SELECT owner FROM sync_lock WHERE id=1 AND expires_at > ?', [new Date().toISOString()]))[0]?.owner !== id) {
      throw new Error('Publication lock expired. Previous snapshot retained.');
    }
    // History rows are derived in SQL. The final pointer swap publishes the entire
    // validated snapshot at once; requests already reading the old ID remain valid.
    await database.batch([
      { sql: `INSERT OR IGNORE INTO price_history(store_id, code, observed_at, price_hash, price_json)
        SELECT ?, n.code, n.observed_at, n.price_hash, json_extract(n.data_json,'$.price')
        FROM catalog_entries n LEFT JOIN catalog_entries p ON p.snapshot_id=? AND p.code=n.code
        WHERE n.snapshot_id=? AND (p.code IS NULL OR p.price_hash != n.price_hash)`, params: [scan.store.storeId, previousId, id] },
      { sql: "UPDATE snapshots SET status='complete', completed_at=? WHERE id=?", params: [scan.completedAt, id] },
      { sql: "INSERT INTO catalog_state(key, value) VALUES('active_snapshot', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [id] }
    ]);
    return { snapshotId: id, products: count, store: scan.store, completedAt: scan.completedAt,
      ...(database instanceof D1DatabaseClient ? { rowsWritten: database.rowsWritten, rowsRead: database.rowsRead, sizeBytes: database.sizeBytes } : {}) };
  } finally {
    await database.query('DELETE FROM sync_lock WHERE id=1 AND owner=?', [id]).catch(() => {});
  }
}

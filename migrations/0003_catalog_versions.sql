CREATE TABLE IF NOT EXISTS catalog_snapshot_storage (
  snapshot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, oldest_observation_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS catalog_product_versions (
  store_id TEXT NOT NULL, code TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
  name TEXT NOT NULL, brand TEXT, price_hash TEXT NOT NULL, content_hash TEXT NOT NULL, data_json TEXT NOT NULL,
  PRIMARY KEY(store_id,code,valid_from)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS catalog_closed_versions ON catalog_product_versions(store_id,valid_to) WHERE valid_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_history_expiry ON price_history(observed_at);
CREATE TABLE IF NOT EXISTS catalog_hash_index (
  store_id TEXT NOT NULL, part INTEGER NOT NULL, snapshot_id TEXT NOT NULL, records_json TEXT NOT NULL,
  PRIMARY KEY(store_id,part)
) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS catalog_entries_read AS
  SELECT e.snapshot_id,e.code,e.name,e.brand,e.price_hash,e.observed_at,e.data_json FROM catalog_entries e
    WHERE NOT EXISTS (SELECT 1 FROM catalog_snapshot_storage m WHERE m.snapshot_id=e.snapshot_id)
  UNION ALL
  SELECT m.snapshot_id,v.code,v.name,v.brand,v.price_hash,m.oldest_observation_at AS observed_at,
    json_set(v.data_json,'$.observedAt',m.oldest_observation_at) AS data_json
  FROM catalog_snapshot_storage m JOIN snapshots s ON s.id=m.snapshot_id
    JOIN catalog_product_versions v ON v.store_id=s.store_id AND v.valid_from<=m.revision
      AND (v.valid_to IS NULL OR v.valid_to>m.revision);

CREATE TABLE IF NOT EXISTS catalog_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  store_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  product_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging', 'complete')),
  report_json TEXT NOT NULL
) WITHOUT ROWID;

-- One B-tree, no extra per-product indexes. The active snapshot is read via
-- catalog_state, so readers never see half of a new catalogue.
CREATE TABLE IF NOT EXISTS catalog_entries (
  snapshot_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  price_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, code)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS price_history (
  store_id TEXT NOT NULL,
  code TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  price_hash TEXT NOT NULL,
  price_json TEXT NOT NULL,
  PRIMARY KEY(store_id, code, observed_at)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingredient_runs (
  id TEXT PRIMARY KEY,
  catalogue_snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging','complete')),
  requirements INTEGER NOT NULL,
  inventory_hash TEXT NOT NULL,
  report_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ingredient_links (
  run_id TEXT NOT NULL,
  ingredient_name TEXT NOT NULL,
  occurrences INTEGER NOT NULL,
  status TEXT NOT NULL,
  selected_code TEXT,
  data_json TEXT NOT NULL,
  PRIMARY KEY(run_id, ingredient_name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ingredient_reviews (
  ingredient_name TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  decision_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ingredient_review_history (
  id TEXT PRIMARY KEY,
  ingredient_name TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  decision_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ingredient_change_history (
  ingredient_name TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  previous_code TEXT,
  selected_code TEXT,
  status TEXT NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY(ingredient_name,changed_at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ingredient_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

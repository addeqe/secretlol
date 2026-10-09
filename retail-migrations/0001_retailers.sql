CREATE TABLE IF NOT EXISTS retail_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retail_stores (store_id TEXT PRIMARY KEY, document_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retail_connections (
  ingredient_id TEXT PRIMARY KEY, ingredient_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, document_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retail_tracked (product_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS retail_products (
  scope_key TEXT NOT NULL, product_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  price_hash TEXT NOT NULL, observation_json TEXT NOT NULL,
  PRIMARY KEY (scope_key, product_id)
);
CREATE TABLE IF NOT EXISTS retail_runs (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, checked_ids_json TEXT NOT NULL, report_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retail_scope_state (scope_key TEXT PRIMARY KEY, active_run_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retail_price_history (
  scope_key TEXT NOT NULL, product_id TEXT NOT NULL, changed_at TEXT NOT NULL,
  price_json TEXT NOT NULL, PRIMARY KEY (scope_key, product_id, changed_at)
);
CREATE TABLE IF NOT EXISTS retail_local_mappings (
  scope_key TEXT NOT NULL, reference_product_id TEXT NOT NULL, local_product_id TEXT NOT NULL,
  identity_json TEXT NOT NULL, checked_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, reference_product_id)
);
CREATE TABLE IF NOT EXISTS retail_connection_health (
  ingredient_id TEXT PRIMARY KEY, document_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS retail_history_age ON retail_price_history(changed_at);
CREATE INDEX IF NOT EXISTS retail_runs_age ON retail_runs(checked_at);

-- Versioned overlay for revised recipe classifications and per-serving profiles.
-- The active manifest in meal_meta is switched only after all chunks are verified.
CREATE TABLE IF NOT EXISTS meal_enrichment_chunks (
  dataset_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('recipes','ingredients','sets','planning')),
  chunk_id INTEGER NOT NULL CHECK(chunk_id >= 0),
  document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  PRIMARY KEY(dataset_id,revision,kind,chunk_id)
) WITHOUT ROWID;

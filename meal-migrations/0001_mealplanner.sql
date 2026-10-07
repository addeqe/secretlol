-- Immutable recipe documents preserve all source fields, ingredient evidence,
-- reviews and filter evidence in one row rather than hundreds of writes.
CREATE TABLE IF NOT EXISTS meal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meal_recipes (
  dataset_id TEXT NOT NULL, recipe_id INTEGER NOT NULL, name TEXT NOT NULL,
  ingredient_names_json TEXT NOT NULL, summary_json TEXT NOT NULL,
  document_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(dataset_id,recipe_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meal_ingredients (
  dataset_id TEXT NOT NULL, ingredient_name TEXT NOT NULL, occurrences INTEGER NOT NULL,
  document_json TEXT NOT NULL, PRIMARY KEY(dataset_id,ingredient_name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meal_filter_sets (
  dataset_id TEXT NOT NULL, filter_key TEXT NOT NULL, recipe_ids_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,filter_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meal_import_progress (
  dataset_id TEXT NOT NULL, part INTEGER NOT NULL, content_hash TEXT NOT NULL,
  completed_at TEXT NOT NULL, recipe_count INTEGER NOT NULL,
  PRIMARY KEY(dataset_id,part)
) WITHOUT ROWID;

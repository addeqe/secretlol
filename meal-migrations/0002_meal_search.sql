-- Optional title acceleration. It stays inactive until the bounded backfill
-- helper verifies the complete immutable recipe set.
CREATE VIRTUAL TABLE IF NOT EXISTS meal_recipe_search USING fts5(
  dataset_id UNINDEXED, recipe_id UNINDEXED, name, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS meal_recipe_search_state (
  dataset_id TEXT PRIMARY KEY, expected_count INTEGER NOT NULL,
  indexed_count INTEGER NOT NULL, last_recipe_id INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

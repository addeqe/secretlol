-- A small serving projection derived from the immutable source document.
-- Keep evidence/reviews in meal_recipes; request-time pricing needs neither.
CREATE TABLE IF NOT EXISTS meal_quote_projections (
  dataset_id TEXT NOT NULL, recipe_id INTEGER NOT NULL, content_hash TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,recipe_id)
) WITHOUT ROWID;

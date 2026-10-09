import type { Database } from './types.ts';
import { rows } from './database.ts';

/** SQL runs once at import/backfill, rather than parsing ingredient evidence in every quote. */
export const quoteProjectionSql = `json_object(
  'servings',json_extract(r.document_json,'$.source.RecipeServings'),
  'recipe_yield',json_extract(r.document_json,'$.source.RecipeYield'),
  'ingredients',(SELECT json_group_array(json_patch(json_object(
    'ingredient_original',json_extract(j.value,'$.ingredient_original'),
    'unit',json_extract(j.value,'$.unit'),
    'measured_quantity',json_extract(j.value,'$.measured_quantity'),
    'quantity_conflict',json_extract(j.value,'$.quantity_conflict')),
    CASE WHEN json_extract(j.value,'$.qualitative_amount') IS NULL THEN '{}'
      ELSE json_object('qualitative_amount',json_extract(j.value,'$.qualitative_amount')) END))
    FROM json_each(r.document_json,'$.ingredients') j),
  'nutrition',json_object('nutrients_per_serving',json_extract(r.document_json,'$.profile.nutrition_metrics.nutrients_per_serving')))`;

export async function backfillMealQuoteProjections(database: Database, dataset: string, after = 0, limit = 100) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid quote projection page');
  // Keyset pages keep both reads and writes bounded; retrying an interrupted page is idempotent.
  const page = await rows(database, 'SELECT recipe_id FROM meal_recipes WHERE dataset_id=? AND recipe_id>? ORDER BY recipe_id LIMIT ?', [dataset, after, limit]);
  if (!page.length) return { after, processed: 0, done: true };
  const last = Number(page.at(-1)!.recipe_id);
  await database.query(`INSERT INTO meal_quote_projections SELECT r.dataset_id,r.recipe_id,r.content_hash,${quoteProjectionSql}
    FROM meal_recipes r WHERE r.dataset_id=? AND r.recipe_id>? AND r.recipe_id<=?
    ON CONFLICT(dataset_id,recipe_id) DO UPDATE SET content_hash=excluded.content_hash,document_json=excluded.document_json
    WHERE meal_quote_projections.content_hash<>excluded.content_hash
      OR meal_quote_projections.document_json<>excluded.document_json`, [dataset, after, last]);
  return { after: last, processed: page.length, done: page.length < limit };
}

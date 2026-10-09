import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDatabase, rows } from '../src/database.ts';
import { mealSchema } from '../src/meal-import.ts';
import { backfillMealQuoteProjections } from '../src/meal-quote-projection.ts';
import { canonicalAmount } from '../src/meal-cost.ts';

test('compact quote projection preserves costing fields, order, unknowns and nutrition', async () => {
  const db = new LocalDatabase(':memory:'); db.execute(mealSchema());
  const ingredients = [
    { ingredient_original: 'sugar', unit: 'gram', measured_quantity: '12', quantity_conflict: 0, evidence_text: 'long original evidence' },
    { ingredient_original: 'sugar', unit: 'cup', measured_quantity: '1 1/2', quantity_conflict: 0 },
    { ingredient_original: 'salt', unit: 'teaspoon', measured_quantity: null, amount_kind: 'qualitative', qualitative_amount: 'to taste' },
    { ingredient_original: 'milk', unit: 'ml', measured_quantity: 20, quantity_conflict: 1 },
  ];
  const source = { source: { RecipeServings: 2, RecipeYield: '1 loaf' }, ingredients,
    profile: { nutrition_metrics: { nutrients_per_serving: { Calories: 120 } } }, reviews: [{ Review: 'audit only' }] };
  try {
    for (const id of [1, 7, 12]) await db.query('INSERT INTO meal_recipes VALUES(?,?,?,?,?,?,?)', ['dataset', id, 'Recipe', '[]', '{}', JSON.stringify(source), `hash${id}`]);
    const first = await backfillMealQuoteProjections(db, 'dataset', 0, 2);
    assert.deepEqual(first, { after: 7, processed: 2, done: false });
    const second = await backfillMealQuoteProjections(db, 'dataset', first.after, 2);
    assert.deepEqual(second, { after: 12, processed: 1, done: true });
    await backfillMealQuoteProjections(db, 'dataset', 0, 2);
    const stored = await rows(db, 'SELECT * FROM meal_quote_projections ORDER BY recipe_id');
    assert.equal(stored.length, 3);
    const projected = JSON.parse(String(stored[0].document_json));
    assert.equal(projected.servings, 2); assert.equal(projected.recipe_yield, '1 loaf');
    assert.deepEqual(projected.nutrition, source.profile.nutrition_metrics);
    assert.equal(projected.ingredients[2].qualitative_amount,'to taste');
    assert.deepEqual(projected.ingredients.map((i: any) => canonicalAmount(i, 2)), ingredients.map(i => canonicalAmount(i, 2)));
    assert.deepEqual(projected.ingredients.map((i: any) => canonicalAmount(i, 2, { unit: 'g', quantity: 50 })), ingredients.map(i => canonicalAmount(i, 2, { unit: 'g', quantity: 50 })));
    assert.equal(projected.reviews, undefined); assert.equal(projected.ingredients[0].evidence_text, undefined);
    await db.query("UPDATE meal_recipes SET content_hash='changed',document_json=? WHERE recipe_id=1", [JSON.stringify({ ...source, source: { RecipeServings: null, RecipeYield: null } })]);
    await backfillMealQuoteProjections(db, 'dataset', 0, 1);
    const changed = (await rows(db, 'SELECT * FROM meal_quote_projections WHERE recipe_id=1'))[0];
    assert.equal(changed.content_hash, 'changed'); assert.equal(JSON.parse(String(changed.document_json)).servings, null);
  } finally { db.close(); }
});

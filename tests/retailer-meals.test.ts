import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalDatabase, rows } from '../src/database.ts';
import { mealSchema } from '../src/meal-import.ts';
import { retailSchema, configureRetailDataset, publishRetailObservations, type RetailDataset } from '../src/retailers/storage.ts';
import { productIdentity } from '../src/retailers/identity.ts';
import { scopeKey, type ProductObservation, type RetailerId, type StoreScope } from '../src/retailers/types.ts';
import { handle } from '../worker/index.ts';

const token = 'offline-meal-test-token-at-least-32-characters';
const datasetId = 'a'.repeat(64), inventoryHash = 'b'.repeat(64);
const now = Date.now();
const scope: StoreScope = { storeId: 'fixture-reference-store', channel: 'pickup' };
const manifest = { datasetId, sourceSha256: datasetId, inventoryHash, recipes: 3,
  ingredientOccurrences: 4, distinctIngredients: 3, reviews: 0, releaseTag: 'fixture',
  repository: 'local/test', schemaVersion: 1 };

function binding(db: LocalDatabase, queryCount?: { count: number }) {
  return { prepare(sql: string) {
    let params: Array<string | number | null> = [];
    const statement: any = { bind(...values: Array<string | number | null>) { params = values; return statement; },
      async first() { if (queryCount) queryCount.count++; return (await rows(db, sql, params))[0] ?? null; },
      async all() { if (queryCount) queryCount.count++; return { results: await rows(db, sql, params), success: true }; },
      async run() { if (queryCount) queryCount.count++; await db.query(sql, params); return { success: true }; },
    };
    return statement;
  } } as unknown as D1Database;
}

function makeObservation(retailer: RetailerId, id: string, name: string, priceOre: number,
  availability: ProductObservation['availability'] = 'available'): ProductObservation {
  const product = { id, ean: null, name, brand: null, categories: ['Skafferi'],
    pack: { quantity: 1000, unit: 'g' as const, approximate: false }, ingredientsText: null };
  return { retailer, scope, product,
    price: { amountOre: priceOre, basis: 'pack', depositOre: 0, memberOnly: false,
      minimumQuantity: null, validFrom: null, validUntil: null },
    availability, checkedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(), storeScopeVerified: true };
}

function retailData(retailer: RetailerId): RetailDataset {
  const rice = makeObservation(retailer, `${retailer}-rice-main`, 'Long grain rice 1 kg', 1900, 'unavailable');
  const reserve = makeObservation(retailer, `${retailer}-rice-reserve`, 'Long grain rice 1 kg', 2400);
  const salt = makeObservation(retailer, `${retailer}-salt`, 'Table salt 1 kg', 800);
  const connection = (name: string, id: string, observations: ProductObservation[], status: 'matched' | 'unavailable' = 'matched') => ({
    ingredientId: `${retailer}-${name}`, name, foodId: name, status,
    mainProductId: status === 'matched' ? id : null,
    approvedProducts: status === 'matched' ? observations.map(o => ({ productId: o.product.id, identity: productIdentity(o.product) })) : [],
    policyVersion: 'owner-halal-brands-strict-2', reviewedAt: new Date(now - 60_000).toISOString(),
    reason: status === 'matched' ? 'Reviewed offline fixture mapping' : 'No approved current product',
  });
  return { retailer, scope, datasetId, inventoryHash, observations: [rice, reserve, salt], connections: [
    connection('rice', rice.product.id, [rice, reserve]),
    connection('salt', salt.product.id, [salt]),
    connection('eggs', '', [], 'unavailable'),
  ] };
}

function ingredient(name: string, quantity: string) {
  return { ingredient_index: 0, ingredient_original: name, unit: 'g', measured_quantity: quantity,
    qualitative_amount: null, quantity_conflict: null, source_text: `${quantity} g ${name}` };
}

async function seedMeals(db: LocalDatabase) {
  db.execute(mealSchema());
  const ingredientsById = [[ingredient('rice', '100'), ingredient('salt', '2')],
    [ingredient('eggs', '100'), ingredient('rice', '50')], [ingredient('rice', '250')]];
  for (let id = 1; id <= 3; id++) {
    const ingredients = ingredientsById[id - 1];
    const names = ingredients.map(item => item.ingredient_original);
    const doc = { source: { RecipeId: String(id), Name: `Meal ${id}`, RecipeServings: 2, RecipeYield: '2 servings' },
      ingredients, profile: { nutrition_metrics: { nutrients_per_serving: { Calories: 300 } } }, reviews: [] };
    const summary = { id, name: `Meal ${id}`, ingredients: names };
    await db.query('INSERT INTO meal_recipes VALUES(?,?,?,?,?,?,?)', [datasetId, id, `Meal ${id}`,
      JSON.stringify(names), JSON.stringify(summary), JSON.stringify(doc), `hash-${id}`]);
  }
  const inventoryNames = [{ name: 'eggs', occurrences: 1 }, { name: 'rice', occurrences: 3 }, { name: 'salt', occurrences: 1 }];
  for (const req of inventoryNames) await db.query('INSERT INTO meal_ingredients VALUES(?,?,?,?)',
    [datasetId, req.name, req.occurrences, JSON.stringify({ name: req.name, occurrences: req.occurrences })]);
  const sets = [['1:yes', [1, 2, 3]], ['1:no', []]];
  for (const [key, ids] of sets) await db.query('INSERT INTO meal_filter_sets VALUES(?,?,?)', [datasetId, String(key), JSON.stringify(ids)]);
  for (const [key, value] of Object.entries({ manifest: JSON.stringify(manifest), active_dataset: datasetId,
    ready: datasetId, definitions: '[]' })) await db.query('INSERT INTO meal_meta VALUES(?,?)', [key, value]);
}

async function setup() {
  const meal = new LocalDatabase(':memory:'); await seedMeals(meal);
  const coop = new LocalDatabase(':memory:'); coop.execute(retailSchema());
  const data = retailData('coop'); await configureRetailDataset(coop, data);
  await publishRetailObservations(coop, 'coop', scope, data.observations, data.observations.map(o => o.product.id), now);
  const ica = new LocalDatabase(':memory:'); ica.execute(retailSchema());
  const icaData = retailData('ica'); await configureRetailDataset(ica, icaData);
  await publishRetailObservations(ica, 'ica', scope, icaData.observations, icaData.observations.map(o => o.product.id), now);
  const willysReads = { count: 0 };
  const env = { DB: { prepare() { willysReads.count++; throw new Error('Willys database must not be queried'); } } as unknown as D1Database,
    MEAL_DB: binding(meal), COOP_DB: binding(coop), ICA_DB: binding(ica), CATALOG_API_TOKEN: token };
  return { meal, coop, ica, env, willysReads, data };
}

function request(path: string, body?: unknown) {
  return new Request(`https://offline.test${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function jsonResponse(response: Response) { return await response.json() as any; }

test('retailer search filters only recipes containing broken ingredients and never reads Willys DB', async () => {
  const s = await setup();
  try {
    const filtered = await jsonResponse(await handle(request('/meal/recipes?retailer=coop'), s.env));
    assert.deepEqual(filtered.recipes.map((recipe: any) => recipe.id), [1, 3]);
    assert.equal(filtered.connectionsCurrent, true);
    const all = await jsonResponse(await handle(request('/meal/recipes?retailer=coop&availableOnly=false'), s.env));
    assert.deepEqual(all.recipes.map((recipe: any) => recipe.id), [1, 2, 3]);
    assert.equal(s.willysReads.count, 0);
  } finally { s.meal.close(); s.coop.close(); s.ica.close(); }
});

test('retailer detail and ingredient lookup use the healthy approved reserve product', async () => {
  const s = await setup();
  try {
    const detail = await jsonResponse(await handle(request('/meal/recipes/1?retailer=coop'), s.env));
    assert.equal(detail.retailer, 'coop');
    assert.equal(detail.ingredients[0].connection.productId, 'coop-rice-reserve');
    assert.equal(detail.ingredients[0].connection.status, 'matched');
    assert.equal(detail.ingredients[1].connection.productId, 'coop-salt');
    const lookup = await jsonResponse(await handle(request('/meal/ingredients/lookup?retailer=coop', { names: ['rice', 'eggs'] }), s.env));
    assert.equal(lookup.connectionsCurrent, true);
    assert.equal(lookup.ingredients[0].connection.productId, 'coop-rice-reserve');
    assert.equal(lookup.ingredients[1].connection.status, 'unavailable');
    assert.equal(s.willysReads.count, 0);
  } finally { s.meal.close(); s.coop.close(); s.ica.close(); }
});

test('retailer recipe cost uses reference observation and preserves measured-unit conversion', async () => {
  const s = await setup();
  try {
    const response = await handle(request('/meal/recipes/1/cost?retailer=coop'), s.env);
    assert.equal(response.status, 200);
    const cost = await jsonResponse(response);
    assert.equal(cost.priceSource, 'reference-webshop');
    assert.equal(cost.basket.complete, true);
    assert.equal(cost.basket.lines[0].productId, 'coop-rice-reserve');
    assert.equal(cost.basket.lines[0].consumedQuantity, 100);
    assert.equal(cost.basket.lines[0].consumedCostOre, 240);
    assert.equal(cost.basket.purchaseCostOre, 3200);
    assert.equal(s.willysReads.count, 0);
  } finally { s.meal.close(); s.coop.close(); s.ica.close(); }
});

test('manifest mismatch and invalid retailer fail closed; cursors cannot cross retailer scope', async () => {
  const s = await setup();
  try {
    await s.coop.query("UPDATE retail_meta SET value=? WHERE key='inventory_hash'", ['c'.repeat(64)]);
    assert.equal((await handle(request('/meal/recipes?retailer=coop'), s.env)).status, 503);
    assert.equal((await handle(request('/meal/recipes/1/cost?retailer=coop'), s.env)).status, 503);
    assert.equal((await handle(request('/meal/recipes?retailer=target'), s.env)).status, 400);
    await s.coop.query("UPDATE retail_meta SET value=? WHERE key='inventory_hash'", [inventoryHash]);
    const first = await jsonResponse(await handle(request('/meal/recipes?retailer=coop&limit=1'), s.env));
    assert.ok(first.nextCursor);
    const otherStore = await handle(request(`/meal/recipes?retailer=ica&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`), s.env);
    assert.equal(otherStore.status, 409);
  } finally { s.meal.close(); s.coop.close(); s.ica.close(); }
});

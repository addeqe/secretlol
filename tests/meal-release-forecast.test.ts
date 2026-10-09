import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unpackAsset } from '../src/meal-import.ts';
import type { MealManifest, MealRecord } from '../src/meal-import.ts';

const IMPORT_BATCH_BYTES = 700_000; // Mirrors the production part importer flush bound.

function sourceDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE filter_definitions(filter_id INTEGER,domain TEXT,key TEXT,label_sv TEXT,label_en TEXT,description TEXT,rule_json TEXT);
    CREATE TABLE recipes(RecipeId TEXT PRIMARY KEY,Name TEXT,AuthorId INTEGER,AuthorName TEXT,CookTime TEXT,PrepTime TEXT,TotalTime TEXT,DatePublished TEXT,Description TEXT,Images TEXT,RecipeCategory TEXT,Keywords TEXT,RecipeIngredientQuantities TEXT,RecipeIngredientParts TEXT,AggregatedRating REAL,ReviewCount INTEGER,Calories REAL,FatContent REAL,SaturatedFatContent REAL,CholesterolContent REAL,SodiumContent REAL,CarbohydrateContent REAL,FiberContent REAL,SugarContent REAL,ProteinContent REAL,RecipeServings INTEGER,RecipeYield TEXT,RecipeInstructions TEXT);
    CREATE TABLE ingredients(RecipeId TEXT,ingredient_index INTEGER,ingredient_original TEXT,quantity_raw TEXT,alignment_status TEXT,unit TEXT,measured_quantity TEXT,recovery_status TEXT,model_unit TEXT,model_confidence REAL,evidence_id INTEGER,source_id TEXT,evidence_ref TEXT,evidence_text TEXT,amount_kind TEXT,qualitative_amount TEXT,amount_source_text TEXT,quantity_conflict INTEGER);
    CREATE TABLE reviews(ReviewId INTEGER,RecipeId TEXT,AuthorId INTEGER,AuthorName TEXT,Rating INTEGER,Review TEXT,DateSubmitted TEXT,DateModified TEXT);
    CREATE TABLE recipe_filter_classifications(RecipeId TEXT,filter_id INTEGER,state TEXT,reason TEXT,evidence TEXT,method TEXT);
    CREATE TABLE recipe_filter_profiles(RecipeId TEXT,nutrition_metrics_json TEXT);
    CREATE TABLE recipe_ingredient_quality(RecipeId TEXT,state TEXT);
    CREATE TABLE ingredient_product_connections(ingredient_name TEXT,run_id TEXT,status TEXT,willys_item_id TEXT,data_json TEXT);
    CREATE TABLE ingredient_filter_subjects(ingredient_name TEXT,occurrences INTEGER);
    CREATE TABLE ingredient_filter_classifications(ingredient_name TEXT,filter_id INTEGER,state TEXT);
    CREATE TABLE classification_runs(run_id TEXT);
    INSERT INTO metadata VALUES('willys_connections','{"dietaryPolicy":{"version":"fixture-policy"}}');
    INSERT INTO filter_definitions VALUES(1,'diet','vegetarian','Vegetarisk','Vegetarian','Fixture rule','{}');
    INSERT INTO ingredient_product_connections VALUES('salt','fixture-run','matched','FIXTURE','{"method":"manual"}');
    INSERT INTO ingredient_filter_subjects VALUES('salt',10);
  `);
  const insertRecipe = db.prepare(`INSERT INTO recipes VALUES(${Array(28).fill('?').join(',')})`);
  const insertIngredient = db.prepare('INSERT INTO ingredients VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertFilter = db.prepare('INSERT INTO recipe_filter_classifications VALUES(?,?,?,?,?,?)');
  const insertProfile = db.prepare('INSERT INTO recipe_filter_profiles VALUES(?,?)');
  const insertQuality = db.prepare('INSERT INTO recipe_ingredient_quality VALUES(?,?)');
  for (let id = 1; id <= 10; id++) {
    insertRecipe.run(String(id), `Forecast recipe ${id}`, 1, 'Fixture author', null, null, null, null,
      'x'.repeat(360_000), '[]', 'Fixture', '', '1', 'salt', null, 0, null, null, null, null, null, null, null, null,
      null, 2, '2 servings', '[]');
    insertIngredient.run(String(id), 0, 'salt', '1', 'matched', 'gram', '1', 'source', 'gram', 1,
      null, null, null, null, 'measured', null, null, 0);
    insertFilter.run(String(id), 1, 'yes', 'fixture', 'fixture evidence', 'fixture');
    insertProfile.run(String(id), '{"nutrients_per_serving":{"Calories":10}}');
    insertQuality.run(String(id), 'consistent');
  }
  return db;
}

function batchCount(records: MealRecord[]) {
  let batches = 0, bytes = 0;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (bytes && bytes + size > IMPORT_BATCH_BYTES) { batches++; bytes = 0; }
    bytes += size;
  }
  if (bytes) batches++;
  return batches;
}

test('release forecasts include quote projections and every importer counter flush', () => {
  const folder = mkdtempSync(join(tmpdir(), 'meal-release-forecast-'));
  try {
    const source = join(folder, 'source.sqlite'), output = join(folder, 'release');
    const db = sourceDatabase(source); db.close();
    mkdirSync(join(folder, 'meal-data'));
    execFileSync('python3', [resolve('scripts/export-meal-data.py'), source, '--output', output], { cwd: folder });
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as MealManifest;
    const common = JSON.parse(unpackAsset(readFileSync(join(output, manifest.common.file)), manifest.common));
    assert.equal(manifest.parts.length, 5);
    for (const part of manifest.parts) {
      const payload = unpackAsset(readFileSync(join(output, part.file)), part);
      const records = payload.trimEnd().split('\n').map(line => JSON.parse(line)) as MealRecord[];
      const forecast = records.length * 2 + batchCount(records) + 1 + (part.day === 5 ? 1 : 0)
        + (part.day === 1 ? common.subjects.length + Object.keys(common.sets).length + 8 : 0);
      assert.equal(part.maxEstimatedWrites, forecast, `part ${part.day} forecast`);
      assert.ok(part.maxEstimatedWrites < 9_000, `part ${part.day} fits the daily write guard`);
      if (part.day === 1) assert.equal(batchCount(records), 2, 'fixture exercises two counter updates in one part');
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

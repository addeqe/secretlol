import {readFileSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {LocalDatabase,rows} from '../src/database.ts';
import {mealSchema,prepareCommon,uploadPart,nextImportPart,unpackAsset,loadCloudRequirements} from '../src/meal-import.ts';
import type {MealManifest,MealRecord} from '../src/meal-import.ts';
const m=JSON.parse(readFileSync('meal-data/manifest.json','utf8')) as MealManifest;
const path='data/meal-validation.sqlite';if(existsSync(path))throw new Error('Validation database already exists; choose a fresh validation run');
const db=new LocalDatabase(path);db.execute(mealSchema());
const source=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  await prepareCommon(db,m,unpackAsset(readFileSync(join('data/meal-release',m.common.file)),m.common));
  const recipe=source.prepare('SELECT * FROM recipes WHERE RecipeId=?'),ingredients=source.prepare('SELECT * FROM ingredients WHERE RecipeId=? ORDER BY ingredient_index'),reviews=source.prepare('SELECT * FROM reviews WHERE RecipeId=? ORDER BY ReviewId'),filters=source.prepare('SELECT * FROM recipe_filter_classifications WHERE RecipeId=? ORDER BY filter_id');
  let ingredientCount=0,reviewCount=0,filterCount=0;
  for(const part of m.parts){
    const records=unpackAsset(readFileSync(join('data/meal-release',part.file)),part).trimEnd().split('\n').map(line=>JSON.parse(line)) as MealRecord[];
    const next=await nextImportPart(db,m,`2026-10-${String(6+part.day).padStart(2,'0')}`);assert.equal(next.part?.day,part.day);
    await uploadPart(db,m,part,records,`2026-10-${String(6+part.day).padStart(2,'0')}T05:30:00Z`);
    for(const r of records){
      const doc=JSON.parse(r.document);const id=String(r.id);
      const plain=(v:Record<string,unknown>)=>({...v});const child=(v:Record<string,unknown>)=>{const row=plain(v);delete row.RecipeId;return row;};
      assert.deepEqual(doc.source,plain(recipe.get(id)!));
      assert.deepEqual(doc.ingredients,ingredients.all(id).map(child));assert.deepEqual(doc.reviews,reviews.all(id).map(child));assert.deepEqual(doc.filters,filters.all(id).map(child));
      ingredientCount+=doc.ingredients.length;reviewCount+=doc.reviews.length;filterCount+=doc.filters.length;
    }
    console.log(`Verified part ${part.day}: ${part.recipes} recipes and every original source/ingredient/review/filter field.`);
  }
  assert.equal(ingredientCount,m.ingredientOccurrences);assert.equal(reviewCount,m.reviews);assert.equal(filterCount,m.sourceCounts.recipe_filter_classifications);
  assert.equal((await loadCloudRequirements(db)).requirements.length,m.distinctIngredients);
  assert.equal(db.db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');assert.equal((await nextImportPart(db,m)).complete,true);
  console.log(JSON.stringify({recipes:m.recipes,ingredients:ingredientCount,reviews:reviewCount,recipeFilterRecords:filterCount,distinctIngredients:m.distinctIngredients,sizeBytes:Number(db.db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.db.prepare('PRAGMA page_size').get()!.page_size),checks:'all passed'}));
}finally{db.close();source.close();}

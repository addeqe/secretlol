import {rows} from './database.ts';
import type {Database} from './types.ts';
import {mealSearchPhrase} from './meal-search.ts';
export {mealSearchPhrase} from './meal-search.ts';

/** Index one bounded page. Call only as deliberate maintenance work, not from requests. */
export async function backfillMealSearchIndex(database:Database,datasetId:string,batchSize=100){
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>250)throw new Error('Invalid meal search batch size');
  const meta=Object.fromEntries((await rows(database,"SELECT key,value FROM meal_meta WHERE key IN ('manifest','ready','active_dataset','uploaded_recipe_count')")).map(r=>[String(r.key),String(r.value)]));
  if(!meta.manifest)throw new Error('Meal manifest is not available');
  const manifest=JSON.parse(meta.manifest);
  if(manifest.datasetId!==datasetId||!Number.isSafeInteger(manifest.recipes)||manifest.recipes<1)throw new Error('Search index dataset does not match the active manifest');
  if(meta.ready!==datasetId||meta.active_dataset!==datasetId)return {ready:false,indexed:0,total:manifest.recipes,reason:'recipe_import_incomplete'};
  if(meta.uploaded_recipe_count===undefined)return {ready:false,indexed:0,total:manifest.recipes,reason:'recipe_count_unavailable'};
  if(Number(meta.uploaded_recipe_count)!==manifest.recipes)return {ready:false,indexed:Number(meta.uploaded_recipe_count),total:manifest.recipes,reason:'recipe_import_incomplete'};
  let state:Record<string,unknown>|undefined=(await rows(database,'SELECT expected_count,indexed_count,last_recipe_id,ready FROM meal_recipe_search_state WHERE dataset_id=?',[datasetId]))[0];
  if(state&&Number(state.expected_count)!==manifest.recipes){
    return {ready:false,indexed:Number(state.indexed_count),total:manifest.recipes,reason:'index_state_mismatch'};
  }
  if(!state){await database.query('INSERT OR IGNORE INTO meal_recipe_search_state(dataset_id,expected_count,indexed_count,last_recipe_id,ready) VALUES(?,?,0,0,0)',[datasetId,manifest.recipes]);
    state=(await rows(database,'SELECT expected_count,indexed_count,last_recipe_id,ready FROM meal_recipe_search_state WHERE dataset_id=?',[datasetId]))[0];}
  if(Number(state.ready)===1&&Number(state.indexed_count)===manifest.recipes)return {ready:true,indexed:manifest.recipes,total:manifest.recipes};
  const source=await rows(database,'SELECT recipe_id,name FROM meal_recipes WHERE dataset_id=? AND recipe_id>? ORDER BY recipe_id LIMIT ?',[datasetId,Number(state.last_recipe_id),batchSize]);
  if(source.length){
    const last=Number(source.at(-1)!.recipe_id);
    await database.batch([
      {sql:`INSERT INTO meal_recipe_search(dataset_id,recipe_id,name)
        SELECT ?,json_extract(value,'$.recipe_id'),json_extract(value,'$.name') FROM json_each(?)
        WHERE EXISTS(SELECT 1 FROM meal_recipe_search_state WHERE dataset_id=? AND ready=0 AND last_recipe_id=?)`,params:[datasetId,JSON.stringify(source),datasetId,Number(state.last_recipe_id)]},
      {sql:`UPDATE meal_recipe_search_state SET indexed_count=indexed_count+changes(),
        last_recipe_id=CASE WHEN changes()>0 THEN ? ELSE last_recipe_id END
        WHERE dataset_id=? AND ready=0 AND last_recipe_id=?`,params:[last,datasetId,Number(state.last_recipe_id)]}
    ]);
  }
  state=(await rows(database,'SELECT expected_count,indexed_count,last_recipe_id,ready FROM meal_recipe_search_state WHERE dataset_id=?',[datasetId]))[0];
  if(Number(state.indexed_count)!==manifest.recipes)return {ready:false,indexed:Number(state.indexed_count),total:manifest.recipes};
  // Full parity is deliberately checked once, at final activation, rather than
  // recounting all source rows on every bounded page.
  const allSource=await rows(database,'SELECT recipe_id,name FROM meal_recipes WHERE dataset_id=? ORDER BY recipe_id',[datasetId]);
  const indexedRows=await rows(database,'SELECT recipe_id,name FROM meal_recipe_search WHERE dataset_id=? ORDER BY CAST(recipe_id AS INTEGER)',[datasetId]);
  const parity=allSource.length===manifest.recipes&&indexedRows.length===allSource.length&&allSource.every((row,i)=>
    Number(row.recipe_id)===Number(indexedRows[i].recipe_id)&&String(row.name)===String(indexedRows[i].name));
  if(!parity||Number(state.last_recipe_id)!==Number(allSource.at(-1)?.recipe_id))throw new Error('Search index row/name parity verification failed');
  await database.query('UPDATE meal_recipe_search_state SET ready=1 WHERE dataset_id=? AND expected_count=? AND indexed_count=? AND last_recipe_id=?',[datasetId,manifest.recipes,manifest.recipes,Number(allSource.at(-1)!.recipe_id)]);
  return {ready:true,indexed:indexedRows.length,total:manifest.recipes};
}

import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {rows,D1DatabaseClient} from './database.ts';
import type {Database} from './types.ts';
import {ingredientPolicy,DIETARY_POLICY_VERSION} from './dietary-policy.ts';
import {quoteProjectionSql} from './meal-quote-projection.ts';
export type MealManifest={schemaVersion:number;datasetId:string;sourceSha256:string;recipes:number;ingredientOccurrences:number;distinctIngredients:number;reviews:number;inventoryHash:string;filterSets:number;common:Asset;parts:Array<Asset&{day:number;recipes:number;firstId:number;lastId:number;maxEstimatedWrites:number}>;releaseTag:string;repository:string;sourceCounts:Record<string,number>};
type Asset={file:string;sha256:string;bytes:number;uncompressedBytes:number};
export type MealRecord={id:number;name:string;names:string;summary:string;document:string;hash:string};
export const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function unpackAsset(bytes:Uint8Array,asset:Asset){
  if(bytes.length!==asset.bytes||digest(bytes)!==asset.sha256)throw new Error('Release asset checksum mismatch');
  const content=gunzipSync(bytes,{maxOutputLength:Math.min(asset.uncompressedBytes+1,160*1024*1024)});
  if(content.length!==asset.uncompressedBytes)throw new Error('Release asset length mismatch');
  return content.toString('utf8');
}
export function validateManifest(m:MealManifest){
  if(m.schemaVersion!==1||! /^[a-f0-9]{64}$/.test(m.datasetId)||m.datasetId!==m.sourceSha256||! /^[a-f0-9]{64}$/.test(m.inventoryHash)
    ||m.parts.length!==5||m.parts.some((p,i)=>p.day!==i+1||!Number.isSafeInteger(p.recipes)||p.recipes<1||p.maxEstimatedWrites>9000)
    ||m.parts.reduce((n,p)=>n+p.recipes,0)!==m.recipes||m.recipes<1||m.distinctIngredients<1)throw new Error('Invalid five-day release manifest');
}
export async function loadCloudRequirements(database:Database){
  const metadata=(await rows(database,"SELECT value FROM meal_meta WHERE key='inventory'"))[0];
  const active=String((await rows(database,"SELECT value FROM meal_meta WHERE key='active_dataset'"))[0]?.value??'');
  if(!metadata||!active)throw new Error('Cloud recipe ingredient inventory is not ready; no legacy inventory fallback is allowed');
  const inventory=JSON.parse(String(metadata.value));
  const requirements=(await rows(database,'SELECT ingredient_name,occurrences FROM meal_ingredients WHERE dataset_id=? ORDER BY ingredient_name',[active]))
    .map(r=>({name:String(r.ingredient_name),occurrences:Number(r.occurrences)}));
  if(inventory.datasetId!==active||inventory.dietaryPolicy?.version!==DIETARY_POLICY_VERSION||requirements.length!==inventory.distinctIngredients
    ||requirements.reduce((n,r)=>n+r.occurrences,0)!==inventory.ingredientOccurrences||digest(JSON.stringify(requirements))!==inventory.hash
    ||requirements.some(r=>ingredientPolicy(r.name).blockedReason||!Number.isSafeInteger(r.occurrences)||r.occurrences<1))throw new Error('Cloud ingredient inventory integrity/policy check failed');
  return {...inventory,requirements,inventorySource:'cloud-recipe-database'};
}
export async function prepareCommon(database:Database,m:MealManifest,content:string){
  const common=JSON.parse(content);
  if(common.inventory.hash!==m.inventoryHash||common.inventory.recipes!==m.recipes||common.subjects.length!==m.distinctIngredients
    ||common.inventory.ingredientOccurrences!==m.ingredientOccurrences||common.inventory.dietaryPolicy?.version!==DIETARY_POLICY_VERSION
    ||digest(JSON.stringify(common.inventory.requirements))!==m.inventoryHash||Object.keys(common.sets).length!==m.filterSets)throw new Error('Release inventory mismatch');
  const active=(await rows(database,"SELECT value FROM meal_meta WHERE key='active_dataset'"))[0]?.value;
  if(active&&active!==m.datasetId)throw new Error('A different recipe release is already installed; use an explicit migration');
  for(let offset=0;offset<common.subjects.length;offset+=40){
    const subjects=common.subjects.slice(offset,offset+40);
    if(subjects.some((s:any)=>ingredientPolicy(s.name).blockedReason))throw new Error('Prohibited ingredient in release');
    await database.query(`INSERT OR IGNORE INTO meal_ingredients SELECT ?,json_extract(value,'$.name'),json_extract(value,'$.occurrences'),value FROM json_each(?)`,[m.datasetId,JSON.stringify(subjects)]);
  }
  for(const [key,ids] of Object.entries(common.sets))await database.query('INSERT OR IGNORE INTO meal_filter_sets VALUES(?,?,?)',[m.datasetId,key,JSON.stringify(ids)]);
  const counts=(await rows(database,'SELECT COUNT(*) AS n,SUM(occurrences) AS occurrences FROM meal_ingredients WHERE dataset_id=?',[m.datasetId]))[0];
  if(Number(counts.n)!==m.distinctIngredients||Number(counts.occurrences)!==m.ingredientOccurrences)throw new Error('Incomplete common ingredient upload');
  const meta={manifest:m,inventory:{...common.inventory,datasetId:m.datasetId,distinctIngredients:m.distinctIngredients},definitions:common.definitions,source_metadata:common.metadata,classification_runs:common.classificationRuns,source_counts:common.sourceCounts};
  await database.batch(Object.entries(meta).map(([key,value])=>({sql:'INSERT OR IGNORE INTO meal_meta VALUES(?,?)',params:[key,JSON.stringify(value)]})));
  await database.query("INSERT OR IGNORE INTO meal_meta VALUES('active_dataset',?)",[m.datasetId]);
  // The counter follows successful insert changes, so status does not need to
  // count the full recipe table while a multipart upload is in progress.
  await database.query("INSERT OR IGNORE INTO meal_meta VALUES('uploaded_recipe_count',(SELECT COUNT(*) FROM meal_recipes WHERE dataset_id=?))",[m.datasetId]);
  await loadCloudRequirements(database);
}
export async function nextImportPart(database:Database,m:MealManifest,today=new Date().toISOString().slice(0,10),options:{allowSameDay?:boolean}={}){
  validateManifest(m);
  const progress=await rows(database,'SELECT * FROM meal_import_progress WHERE dataset_id=? ORDER BY part',[m.datasetId]);
  if(progress.some((p,i)=>Number(p.part)!==i+1||p.content_hash!==m.parts[i].sha256))throw new Error('Import progress differs from pinned release');
  if(progress.length===5)return {complete:true,part:null};
  if(!options.allowSameDay&&progress.at(-1)&&String(progress.at(-1)!.completed_at).slice(0,10)>=today)return {complete:false,part:null,waitingForNextDay:true};
  return {complete:false,part:m.parts[progress.length]};
}
export async function uploadPart(database:Database,m:MealManifest,part:MealManifest['parts'][number],records:MealRecord[],completedAt?:string){
  if(records.length!==part.recipes||records[0]?.id!==part.firstId||records.at(-1)?.id!==part.lastId
    ||new Set(records.map(r=>r.id)).size!==records.length)throw new Error('Recipe part count/order mismatch');
  const progress=await rows(database,'SELECT part,content_hash FROM meal_import_progress WHERE dataset_id=? ORDER BY part',[m.datasetId]);
  if(progress.length!==part.day-1||progress.some((p,i)=>Number(p.part)!==i+1||p.content_hash!==m.parts[i].sha256))throw new Error('Import progress differs from pinned release');
  for(const r of records){
    if(!Number.isSafeInteger(r.id)||r.id<1||digest(r.document)!==r.hash||Buffer.byteLength(r.document)>1900000)throw new Error('Invalid recipe document');
    const doc=JSON.parse(r.document);const names=JSON.parse(r.names);
    if(String(doc.source.RecipeId)!==String(r.id)||doc.source.Name!==r.name||doc.quality.state!=='consistent'
      ||!doc.ingredients.length||doc.ingredients.some((i:any)=>!i.unit||ingredientPolicy(i.ingredient_original).blockedReason)
      ||JSON.stringify(doc.ingredients.map((i:any)=>i.ingredient_original))!==JSON.stringify(names))throw new Error('Recipe release violates ingredient quality/policy');
  }
  // Each request is small; insert-once documents make retries consume only
  // missing writes. Activation and progress follow full post-upload checks.
  let batch:MealRecord[]=[],bytes=0;
  async function flush(){if(!batch.length)return;await database.batch([{sql:`INSERT OR IGNORE INTO meal_recipes SELECT ?,
    json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.names'),json_extract(value,'$.summary'),
    json_extract(value,'$.document'),json_extract(value,'$.hash') FROM json_each(?)`,params:[m.datasetId,JSON.stringify(batch)]},
    {sql:"UPDATE meal_meta SET value=CAST(CAST(value AS INTEGER)+changes() AS TEXT) WHERE key='uploaded_recipe_count'",params:[]},
    {sql:`INSERT OR IGNORE INTO meal_quote_projections SELECT r.dataset_id,r.recipe_id,r.content_hash,${quoteProjectionSql}
      FROM meal_recipes r WHERE r.dataset_id=? AND r.recipe_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`,
      params:[m.datasetId,JSON.stringify(batch.map(r=>({id:r.id})))]}]);batch=[];bytes=0;}
  for(const r of records){const size=Buffer.byteLength(JSON.stringify(r));if(bytes+size>700000)await flush();batch.push(r);bytes+=size;}
  await flush();
  const actual=await rows(database,'SELECT recipe_id,content_hash FROM meal_recipes WHERE dataset_id=? AND recipe_id>=? AND recipe_id<=? ORDER BY recipe_id',[m.datasetId,part.firstId,part.lastId]);
  if(actual.length!==records.length||actual.some((r,i)=>Number(r.recipe_id)!==records[i].id||r.content_hash!==records[i].hash))throw new Error('Uploaded recipe checksum/count mismatch');
  const expected=m.parts.slice(0,part.day).reduce((n,p)=>n+p.recipes,0);
  if(part.day<5){const stored=Number((await rows(database,"SELECT value FROM meal_meta WHERE key='uploaded_recipe_count'"))[0]?.value??-1);if(stored!==expected)throw new Error('Total uploaded recipe count mismatch');}
  if(part.day===5){
    const counts=(await rows(database,`SELECT COUNT(*) AS n,SUM(json_array_length(ingredient_names_json)) AS ingredients,
      SUM(json_array_length(document_json,'$.reviews')) AS reviews FROM meal_recipes WHERE dataset_id=?`,[m.datasetId]))[0];
    if(Number(counts.n)!==expected)throw new Error('Total uploaded recipe count mismatch');
    if(Number(counts.ingredients)!==m.ingredientOccurrences||Number(counts.reviews)!==m.reviews)throw new Error('Final ingredient/review count mismatch');
    const sets=(await rows(database,'SELECT COUNT(*) AS n FROM meal_filter_sets WHERE dataset_id=?',[m.datasetId]))[0];
    if(Number(sets.n)!==m.filterSets)throw new Error('Final filter set count mismatch');
    await loadCloudRequirements(database);
  }
  await database.batch([
    {sql:'INSERT INTO meal_import_progress VALUES(?,?,?,?,?)',params:[m.datasetId,part.day,part.sha256,completedAt??new Date().toISOString(),part.recipes]},
    ...(part.day===5?[{sql:"INSERT INTO meal_meta VALUES('ready',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params:[m.datasetId]}]:[])
  ]);
  return {part:part.day,uploadedRecipes:expected,totalRecipes:m.recipes,complete:part.day===5,...(database instanceof D1DatabaseClient?{rowsWritten:database.rowsWritten,sizeBytes:database.sizeBytes}:{})};
}
export function mealSchema(){return ['0001_mealplanner.sql','0002_meal_search.sql','0003_meal_quotes.sql','0004_meal_enrichment.sql'].map(name=>readFileSync(new URL(`../meal-migrations/${name}`,import.meta.url),'utf8')).join('\n');}

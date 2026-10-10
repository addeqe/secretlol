import { scanIsCurrent } from './price-freshness.ts';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {rows,D1DatabaseClient} from './database.ts';
import {buildLinks,summarizeLinks,MATCHER_VERSION} from './ingredient-matching.ts';
import type {Requirement,Decision} from './ingredient-matching.ts';
import type {Database,Entry} from './types.ts';
import {integer} from './config.ts';
import {DIETARY_POLICY,DIETARY_POLICY_VERSION,ingredientPolicy} from './dietary-policy.ts';
import {loadAssessments} from './ingredient-assessments.ts';
import {compactLink,ensureIngredientStorage,seedIngredientStorage,stableStringify} from './ingredient-storage.ts';
import {catalogueContentHash as hashCatalogue,ensureCatalogStorage} from './catalog-storage.ts';
import {catalogAvailabilityLookupSql} from './catalog-query.ts';

export function loadRequirements(){
  const bytes=readFileSync(new URL('../ingredient-data/requirements.json',import.meta.url));
  const data=JSON.parse(bytes.toString()) as {requirements:Requirement[];ingredientOccurrences:number;recipes:number;dietaryPolicy?:{version:string}};
  if(data.requirements.reduce((n,r)=>n+r.occurrences,0)!==data.ingredientOccurrences)throw new Error('Inventory count mismatch');
  if(data.dietaryPolicy?.version!==DIETARY_POLICY_VERSION)throw new Error('Daily inventory is not filtered for the current ingredient policy');
  return {...data,hash:createHash('sha256').update(bytes).digest('hex')};
}
export async function refreshIngredientLinks(database:Database, inventory=loadRequirements(), options:{products?:Entry[];catalogueSnapshotId?:string;catalogueContentHash?:string}={}){
  if(inventory.requirements.some(r=>ingredientPolicy(r.name).blockedReason))throw new Error('Excluded ingredient in daily inventory; regenerate the filtered recipe inventory before refreshing');
  if(options.products&&(!options.catalogueSnapshotId||!options.catalogueContentHash))throw new Error('Preloaded catalogue products require a snapshot ID and content hash');
  if(database instanceof D1DatabaseClient&&database.rowsWritten+500>=integer('MAX_D1_ROWS_WRITTEN',80000)){
    throw new Error('Combined catalogue/ingredient refresh would exceed the free write budget; previous connections retained');
  }
  await ensureCatalogStorage(database);
  await ensureIngredientStorage(database);
  const id=randomUUID(),now=new Date().toISOString();
  await database.query(`INSERT INTO ingredient_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE
    SET owner=excluded.owner,expires_at=excluded.expires_at WHERE ingredient_lock.expires_at < ?`,
    [id,new Date(Date.now()+10*60000).toISOString(),now]);
  if((await rows(database,'SELECT owner FROM ingredient_lock WHERE id=1'))[0]?.owner!==id)throw new Error('Ingredient refresh already running');
  try{
    const snapshot=(await rows(database,`SELECT s.* FROM snapshots s WHERE s.id=
      (SELECT value FROM catalog_state WHERE key='active_snapshot') AND s.status='complete'`))[0];
    if(!snapshot)throw new Error('No complete catalogue snapshot; connections retained');
    if(options.catalogueSnapshotId&&options.catalogueSnapshotId!==String(snapshot.id))throw new Error('Supplied catalogue products do not match the active snapshot');
    const storedContentHash=JSON.parse(String(snapshot.report_json??'{}')).contentHash;
    if(options.catalogueContentHash&&options.catalogueContentHash!==storedContentHash)throw new Error('Supplied catalogue content hash does not match the published snapshot');
    if(options.catalogueContentHash&&options.products&&hashCatalogue(options.products)!==options.catalogueContentHash)throw new Error('Supplied catalogue products differ from the published content hash');
    const catalogueRows=options.products?[]:await rows(database,`SELECT json_remove(data_json,'$.raw','$.price') AS data_json,
      json_extract(data_json,'$.raw.displayVolume') AS pack_label FROM catalog_entries_read WHERE snapshot_id=?`,[String(snapshot.id)]);
    if(!options.products&&(catalogueRows.length!==Number(snapshot.product_count) || !catalogueRows.length))throw new Error('Incomplete catalogue; connections retained');
    const products=(options.products??catalogueRows.map(r=>({...JSON.parse(String(r.data_json)),raw:{displayVolume:r.pack_label}}))).map(p=>({...p})) as Entry[];
    if(products.length!==Number(snapshot.product_count)||!products.length||new Set(products.map(p=>p.code)).size!==products.length)throw new Error('Supplied catalogue products are incomplete or duplicated; previous connections retained');
    const observation=String((await rows(database,'SELECT oldest_observation_at FROM catalog_snapshot_storage WHERE snapshot_id=?',[String(snapshot.id)]))[0]?.oldest_observation_at??'');
    if(observation)for(const product of products)product.observedAt=observation;
    if(products.some(p=>!scanIsCurrent(Date.parse(p.observedAt)))){
      throw new Error('Catalogue contains stale observations; refresh the catalogue first. Previous connections retained.');
    }
    const reviewRows=await rows(database,'SELECT ingredient_name,decision_json FROM ingredient_reviews');
    const reviews=Object.fromEntries(reviewRows.map(r=>[String(r.ingredient_name),JSON.parse(String(r.decision_json)) as Decision]));
    const assessed=loadAssessments();
    const links=buildLinks(inventory.requirements,products,reviews,Date.now(),assessed.records);
    const report={...summarizeLinks(links),recipes:inventory.recipes,storeId:snapshot.store_id,
      catalogueSnapshotId:snapshot.id,runId:id,completedAt:new Date().toISOString(),inventoryHash:inventory.hash,
      catalogueContentHash:storedContentHash??null,
      inventorySource:'inventorySource' in inventory?inventory.inventorySource:'local-fixture',
      datasetId:'datasetId' in inventory?inventory.datasetId:null,matcherVersion:MATCHER_VERSION,selectionPolicy:'lowest comparable listed price among verified compatible available products; conditional offers are not assumed',
      dietaryPolicy:DIETARY_POLICY,ingredientReview:{...assessed.report,
        activeReviewedNames:inventory.requirements.filter(r=>assessed.records[r.name]).length},conversionComplete:false};
    const previousId=String((await rows(database,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0]?.value??'');
    if(previousId)await seedIngredientStorage(database,previousId);
    const revision=Number((await rows(database,'SELECT COALESCE(MAX(revision),0)+1 AS n FROM ingredient_run_storage'))[0]?.n??1);
    const oldLinks=previousId?await rows(database,'SELECT ingredient_name,occurrences,status,selected_code,data_json FROM ingredient_links_read WHERE run_id=?',[previousId]):[];
    const oldByName=new Map(oldLinks.map(row=>[String(row.ingredient_name),{
      serialized:stableStringify(compactLink(JSON.parse(String(row.data_json)))),
      status:String(row.status),selectedCode:row.selected_code==null?null:String(row.selected_code)
    }]));
    const compact=links.map(link=>({link,data:compactLink(link as unknown as Record<string,any>)}));
    const changed=compact.filter(({link,data})=>oldByName.get(link.name)?.serialized!==stableStringify(data));
    const historyChanges=compact.flatMap(({link})=>{
      const old=oldByName.get(link.name);
      return !old||old.status!==link.status||old.selectedCode!==link.selectedCode?[{
        name:link.name,previousCode:old?.selectedCode??null,selectedCode:link.selectedCode,status:link.status
      }]:[];
    });
    const currentNames=new Set(compact.map(({link})=>link.name));
    const removedNames=[...oldByName.keys()].filter(name=>!currentNames.has(name));
    if(database instanceof D1DatabaseClient&&database.rowsWritten+changed.length*5+removedNames.length*3+500>=integer('MAX_D1_ROWS_WRITTEN',80000)){
      throw new Error('Combined catalogue/ingredient refresh would exceed the free write budget; previous connections retained');
    }
    const changedNames=[...new Set([...changed.map(({link})=>link.name),...removedNames])];
    // Keep the currently active run while staging a replacement; reclaim our own
    // abandoned/previous rows only. Catalogue tables are never cleaned here.
    let removed=0;
    while(true){
      const stale=await rows(database,'SELECT run_id,ingredient_name FROM ingredient_links WHERE run_id!=? LIMIT 500',[previousId]);
      if(!stale.length)break;
      await database.query(`DELETE FROM ingredient_links WHERE (run_id,ingredient_name) IN
        (SELECT json_extract(value,'$.run_id'),json_extract(value,'$.ingredient_name') FROM json_each(?))`,[JSON.stringify(stale)]);
      removed+=stale.length;if(removed>20000)throw new Error('Ingredient cleanup budget exceeded');
    }
    await database.query('DELETE FROM ingredient_runs WHERE id!=?',[previousId]);
    await database.query('DELETE FROM ingredient_run_storage WHERE run_id NOT IN (SELECT id FROM ingredient_runs)');
    await database.query(`DELETE FROM ingredient_link_versions WHERE NOT EXISTS
      (SELECT 1 FROM ingredient_run_storage rs WHERE rs.revision>=ingredient_link_versions.valid_from_revision
       AND (ingredient_link_versions.valid_to_revision IS NULL OR rs.revision<ingredient_link_versions.valid_to_revision))`);
    await database.query(`INSERT INTO ingredient_runs VALUES(?,?,?,'staging',?,?,?)`,
      [id,String(snapshot.id),now,links.length,inventory.hash,JSON.stringify(report)]);
    for(let offset=0;offset<changed.length;offset+=100){
      const slice=changed.slice(offset,offset+100);
      await database.query(`INSERT INTO ingredient_link_versions(ingredient_name,valid_from_revision,occurrences,status,selected_code,data_json)
        SELECT json_extract(value,'$.name'),?,json_extract(value,'$.occurrences'),json_extract(value,'$.status'),
          json_extract(value,'$.selectedCode'),json_extract(value,'$.data') FROM json_each(?)`,
        [revision,JSON.stringify(slice.map(({link,data})=>({name:link.name,occurrences:link.occurrences,status:link.status,selectedCode:link.selectedCode,data:JSON.stringify(data)})))]);
    }
    for(let offset=0;offset<removedNames.length;offset+=100){
      await database.query(`INSERT INTO ingredient_link_versions(ingredient_name,valid_from_revision,valid_to_revision,occurrences,status,selected_code,data_json,is_deleted)
        SELECT value,?,NULL,0,'removed',NULL,'{}',1 FROM json_each(?)`,[revision,JSON.stringify(removedNames.slice(offset,offset+100))]);
    }
    await database.query('INSERT INTO ingredient_run_storage VALUES(?,?,1)',[id,revision]);
    const count=(await rows(database,'SELECT COUNT(*) AS n,SUM(occurrences) AS occurrences FROM ingredient_links_read WHERE run_id=?',[id]))[0];
    if(Number(count?.n)!==links.length || Number(count?.occurrences)!==inventory.ingredientOccurrences)throw new Error('Incomplete connection upload; previous connections retained');
    const orphan=(await rows(database,`SELECT COUNT(*) AS n FROM ingredient_links_read l WHERE l.selected_code IS NOT NULL
      AND ${catalogAvailabilityLookupSql('l.selected_code')} IS NULL AND l.run_id=?`,[String(snapshot.id),String(snapshot.id),id]))[0];
    if(Number(orphan?.n)!==0)throw new Error('Connection references an unknown product');
    if((await rows(database,"SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0]?.value!==snapshot.id)throw new Error('Catalogue changed during matching; previous connections retained, retry');
    if((await rows(database,'SELECT owner FROM ingredient_lock WHERE id=1 AND expires_at>?',[new Date().toISOString()]))[0]?.owner!==id)throw new Error('Ingredient publication lock expired');
    const publicationStatements=[
      {sql:`UPDATE ingredient_link_versions SET valid_to_revision=? WHERE valid_to_revision IS NULL AND valid_from_revision<?
        AND ingredient_name IN (SELECT value FROM json_each(?))`,params:[revision,revision,JSON.stringify(changedNames)]},
      {sql:"UPDATE ingredient_runs SET status='complete' WHERE id=?",params:[id]},
      {sql:"INSERT INTO catalog_state VALUES('active_ingredient_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params:[id]}
    ];
    if(historyChanges.length)publicationStatements.splice(1,0,{sql:`INSERT OR IGNORE INTO ingredient_change_history
      SELECT json_extract(value,'$.name'),?,json_extract(value,'$.previousCode'),json_extract(value,'$.selectedCode'),
        json_extract(value,'$.status'),? FROM json_each(?)`,params:[report.completedAt,id,JSON.stringify(historyChanges)]});
    await database.batch(publicationStatements);
    // Only snapshots of the same retained inventory/policy can support pinned
    // pagination; discard the old larger inventory when switching to cloud.
    const previous=(await rows(database,'SELECT report_json FROM ingredient_runs WHERE id=?',[previousId]))[0];
    const priorReport=previous?JSON.parse(String(previous.report_json)):null;
    if(priorReport&&(priorReport.dietaryPolicy?.version!==DIETARY_POLICY_VERSION||priorReport.inventoryHash!==inventory.hash)){
      await database.query('DELETE FROM ingredient_links WHERE run_id=?',[previousId]);
      await database.query('DELETE FROM ingredient_runs WHERE id=?',[previousId]);
      await database.query('DELETE FROM ingredient_run_storage WHERE run_id=?',[previousId]);
    }
    // Retire intervals only after every run pinned to them has been removed.
    await database.query(`DELETE FROM ingredient_link_versions WHERE NOT EXISTS
      (SELECT 1 FROM ingredient_run_storage rs WHERE rs.revision>=ingredient_link_versions.valid_from_revision
        AND (ingredient_link_versions.valid_to_revision IS NULL OR rs.revision<ingredient_link_versions.valid_to_revision))`);
    await database.query(`DELETE FROM ingredient_change_history WHERE (ingredient_name,changed_at) IN
      (SELECT ingredient_name,changed_at FROM ingredient_change_history WHERE changed_at<? LIMIT 1000)`,
      [new Date(Date.now()-90*86400000).toISOString()]);
    return {...report,changedLinks:changed.length,removedLinks:removedNames.length,unchangedLinks:links.length-changed.length,rowsRead:database instanceof D1DatabaseClient?database.rowsRead:undefined,rowsWritten:database instanceof D1DatabaseClient?database.rowsWritten:undefined,...(database instanceof D1DatabaseClient?{sizeBytes:database.sizeBytes}:{})};
  }finally{await database.query('DELETE FROM ingredient_lock WHERE id=1 AND owner=?',[id]).catch(()=>{});}
}

import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {rows,D1DatabaseClient} from './database.ts';
import {buildLinks,summarizeLinks,MATCHER_VERSION} from './ingredient-matching.ts';
import type {Requirement,Decision} from './ingredient-matching.ts';
import type {Database,Entry} from './types.ts';
import {integer} from './config.ts';
import {DIETARY_POLICY,DIETARY_POLICY_VERSION,ingredientPolicy} from './dietary-policy.ts';

export function loadRequirements(){
  const bytes=readFileSync(new URL('../ingredient-data/requirements.json',import.meta.url));
  const data=JSON.parse(bytes.toString()) as {requirements:Requirement[];ingredientOccurrences:number;recipes:number;dietaryPolicy?:{version:string}};
  if(data.requirements.reduce((n,r)=>n+r.occurrences,0)!==data.ingredientOccurrences)throw new Error('Inventory count mismatch');
  if(data.dietaryPolicy?.version!==DIETARY_POLICY_VERSION)throw new Error('Daily inventory is not filtered for the current ingredient policy');
  return {...data,hash:createHash('sha256').update(bytes).digest('hex')};
}
export async function refreshIngredientLinks(database:Database, inventory=loadRequirements()){
  if(inventory.requirements.some(r=>ingredientPolicy(r.name).blockedReason))throw new Error('Excluded ingredient in daily inventory; regenerate the filtered recipe inventory before refreshing');
  if(database instanceof D1DatabaseClient&&database.rowsWritten+inventory.requirements.length*3+1100>integer('MAX_D1_ROWS_WRITTEN',80000)){
    throw new Error('Combined catalogue/ingredient refresh would exceed the free write budget; previous connections retained');
  }
  const id=randomUUID(),now=new Date().toISOString();
  await database.query(`INSERT INTO ingredient_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE
    SET owner=excluded.owner,expires_at=excluded.expires_at WHERE ingredient_lock.expires_at < ?`,
    [id,new Date(Date.now()+10*60000).toISOString(),now]);
  if((await rows(database,'SELECT owner FROM ingredient_lock WHERE id=1'))[0]?.owner!==id)throw new Error('Ingredient refresh already running');
  try{
    const snapshot=(await rows(database,`SELECT s.* FROM snapshots s WHERE s.id=
      (SELECT value FROM catalog_state WHERE key='active_snapshot') AND s.status='complete'`))[0];
    if(!snapshot)throw new Error('No complete catalogue snapshot; connections retained');
    const catalogueRows=await rows(database,`SELECT json_remove(data_json,'$.raw','$.price') AS data_json,
      json_extract(data_json,'$.raw.displayVolume') AS pack_label FROM catalog_entries WHERE snapshot_id=?`,[String(snapshot.id)]);
    if(catalogueRows.length!==Number(snapshot.product_count) || !catalogueRows.length)throw new Error('Incomplete catalogue; connections retained');
    const products=catalogueRows.map(r=>({...JSON.parse(String(r.data_json)),raw:{displayVolume:r.pack_label}})) as Entry[];
    if(products.some(p=>!Number.isFinite(Date.parse(p.observedAt)) || Date.now()-Date.parse(p.observedAt)>=86400000)){
      throw new Error('Catalogue contains stale observations; refresh the catalogue first. Previous connections retained.');
    }
    const reviewRows=await rows(database,'SELECT ingredient_name,decision_json FROM ingredient_reviews');
    const reviews=Object.fromEntries(reviewRows.map(r=>[String(r.ingredient_name),JSON.parse(String(r.decision_json)) as Decision]));
    const links=buildLinks(inventory.requirements,products,reviews);
    const report={...summarizeLinks(links),recipes:inventory.recipes,storeId:snapshot.store_id,
      catalogueSnapshotId:snapshot.id,runId:id,completedAt:new Date().toISOString(),inventoryHash:inventory.hash,
      matcherVersion:MATCHER_VERSION,selectionPolicy:'lowest comparable listed price among verified compatible available products; conditional offers are not assumed',
      dietaryPolicy:DIETARY_POLICY,conversionComplete:false};
    const previousId=String((await rows(database,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0]?.value??'');
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
    await database.query(`INSERT INTO ingredient_runs VALUES(?,?,?,'staging',?,?,?)`,
      [id,String(snapshot.id),now,links.length,inventory.hash,JSON.stringify(report)]);
    for(let offset=0;offset<links.length;offset+=100){
      await database.query(`INSERT INTO ingredient_links SELECT ?,json_extract(value,'$.name'),
        json_extract(value,'$.occurrences'),json_extract(value,'$.status'),json_extract(value,'$.selectedCode'),value
        FROM json_each(?)`,[id,JSON.stringify(links.slice(offset,offset+100))]);
    }
    const count=(await rows(database,'SELECT COUNT(*) AS n,SUM(occurrences) AS occurrences FROM ingredient_links WHERE run_id=?',[id]))[0];
    if(Number(count?.n)!==links.length || Number(count?.occurrences)!==inventory.ingredientOccurrences)throw new Error('Incomplete connection upload; previous connections retained');
    const orphan=(await rows(database,`SELECT COUNT(*) AS n FROM ingredient_links l LEFT JOIN catalog_entries c
      ON c.snapshot_id=? AND c.code=l.selected_code WHERE l.run_id=? AND l.selected_code IS NOT NULL AND c.code IS NULL`,[String(snapshot.id),id]))[0];
    if(Number(orphan?.n)!==0)throw new Error('Connection references an unknown product');
    if((await rows(database,"SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0]?.value!==snapshot.id)throw new Error('Catalogue changed during matching; previous connections retained, retry');
    if((await rows(database,'SELECT owner FROM ingredient_lock WHERE id=1 AND expires_at>?',[new Date().toISOString()]))[0]?.owner!==id)throw new Error('Ingredient publication lock expired');
    await database.batch([
      {sql:`INSERT OR IGNORE INTO ingredient_change_history
        SELECT n.ingredient_name,?,p.selected_code,n.selected_code,n.status,? FROM ingredient_links n
        LEFT JOIN ingredient_links p ON p.run_id=? AND p.ingredient_name=n.ingredient_name
        WHERE n.run_id=? AND (p.ingredient_name IS NULL OR p.selected_code IS NOT n.selected_code OR p.status!=n.status)`,
        params:[report.completedAt,id,previousId,id]},
      {sql:"UPDATE ingredient_runs SET status='complete' WHERE id=?",params:[id]},
      {sql:"INSERT INTO catalog_state VALUES('active_ingredient_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params:[id]}
    ]);
    // A pre-policy snapshot must not retain prohibited connections. Modern
    // snapshots with the same policy can still support pinned pagination.
    const previous=(await rows(database,'SELECT report_json FROM ingredient_runs WHERE id=?',[previousId]))[0];
    if(previous && JSON.parse(String(previous.report_json)).dietaryPolicy?.version!==DIETARY_POLICY_VERSION){
      await database.query('DELETE FROM ingredient_links WHERE run_id=?',[previousId]);
      await database.query('DELETE FROM ingredient_runs WHERE id=?',[previousId]);
    }
    await database.query(`DELETE FROM ingredient_change_history WHERE (ingredient_name,changed_at) IN
      (SELECT ingredient_name,changed_at FROM ingredient_change_history WHERE changed_at<? LIMIT 1000)`,
      [new Date(Date.now()-90*86400000).toISOString()]);
    return {...report,...(database instanceof D1DatabaseClient?{rowsWritten:database.rowsWritten,rowsRead:database.rowsRead,sizeBytes:database.sizeBytes}:{})};
  }finally{await database.query('DELETE FROM ingredient_lock WHERE id=1 AND owner=?',[id]).catch(()=>{});}
}

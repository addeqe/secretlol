import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {loadEnv,required} from '../src/config.ts';
import {D1DatabaseClient,rows} from '../src/database.ts';
import {ensureCatalogStorage,seedCatalogStorage} from '../src/catalog-storage.ts';
import {ensureIngredientStorage,seedIngredientStorage} from '../src/ingredient-storage.ts';
import {stableJson} from '../src/products.ts';
loadEnv();

// Explicit one-time migration. It leaves the old physical rows in place until
// --cleanup verifies the deployed API is serving versioned storage.
const cleanup=process.argv.includes('--cleanup');
const database=new D1DatabaseClient();
const meal=new D1DatabaseClient({databaseId:required('MEAL_DATABASE_ID')});
const owner=randomUUID(),locked:string[]=[];
try{
  const now=new Date();
  const query='query($account:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$account}){d1AnalyticsAdaptiveGroups(limit:100,filter:{datetime_geq:$since,datetime_leq:$until}){sum{rowsWritten}}}}}';
  const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${required('CLOUDFLARE_API_TOKEN')}`,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{account:required('CLOUDFLARE_ACCOUNT_ID'),since:now.toISOString().slice(0,10)+'T00:00:00Z',until:now.toISOString()}}),signal:AbortSignal.timeout(20000)});
  const analytics=await response.json() as any;
  if(!response.ok||analytics.errors?.length||!analytics.data?.viewer?.accounts?.length)throw new Error('Cannot verify migration write quota');
  const used=analytics.data.viewer.accounts.flatMap((a:any)=>a.d1AnalyticsAdaptiveGroups??[]).reduce((n:number,g:any)=>n+Number(g.sum?.rowsWritten??0),0);
  const reserve=cleanup?26000:30000;
  if(!Number.isFinite(used)||used+reserve>95000)throw new Error('One-time migration deferred: insufficient account write headroom');
  for(const table of ['sync_lock','ingredient_lock']){
    await database.query(`INSERT INTO ${table} VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE ${table}.expires_at<?`,[owner,new Date(Date.now()+30*60000).toISOString(),now.toISOString()]);
    if((await rows(database,`SELECT owner FROM ${table} WHERE id=1`))[0]?.owner!==owner)throw new Error('A publisher is running; migration deferred');
    locked.push(table);
  }
  const pointers=await rows(database,"SELECT key,value FROM catalog_state WHERE key IN('active_snapshot','active_ingredient_run') ORDER BY key");
  if(cleanup){
    const api=await fetch(`${required('CATALOG_API_URL')}/status`,{headers:{Authorization:`Bearer ${required('CATALOG_API_TOKEN')}`},signal:AbortSignal.timeout(20000)});
    const status=await api.json() as any;
    if(!api.ok||status.storageVersion!==2||status.snapshotId!==pointers.find(p=>p.key==='active_snapshot')?.value)throw new Error('Deploy and verify versioned Worker before legacy cleanup');
    const seeds=await rows(database,'SELECT snapshot_id FROM catalog_snapshot_storage');
    for(const seed of seeds){for(;;){const codes=await rows(database,'SELECT code FROM catalog_entries WHERE snapshot_id=? LIMIT 500',[String(seed.snapshot_id)]);if(!codes.length)break;
      await database.query('DELETE FROM catalog_entries WHERE snapshot_id=? AND code IN(SELECT value FROM json_each(?))',[String(seed.snapshot_id),JSON.stringify(codes.map(p=>p.code))]);}}
    const runs=await rows(database,'SELECT run_id FROM ingredient_run_storage');
    for(const run of runs){for(;;){const names=await rows(database,'SELECT ingredient_name FROM ingredient_links WHERE run_id=? LIMIT 500',[String(run.run_id)]);if(!names.length)break;
      await database.query('DELETE FROM ingredient_links WHERE run_id=? AND ingredient_name IN(SELECT value FROM json_each(?))',[String(run.run_id),JSON.stringify(names.map(p=>p.ingredient_name))]);}}
  }else{
    await ensureCatalogStorage(database);await ensureIngredientStorage(database);
    const snapshots=await rows(database,"SELECT id FROM snapshots WHERE status='complete' ORDER BY completed_at,id");
    for(const snapshot of snapshots)await seedCatalogStorage(database,String(snapshot.id));
    const runs=await rows(database,"SELECT id FROM ingredient_runs WHERE status='complete' ORDER BY created_at,id");
    for(const run of runs)await seedIngredientStorage(database,String(run.id));
    await meal.query("INSERT OR IGNORE INTO meal_meta VALUES('uploaded_recipe_count',(SELECT COUNT(*) FROM meal_recipes WHERE dataset_id=(SELECT value FROM meal_meta WHERE key='active_dataset')))");
    for(const sql of readFileSync(new URL('../meal-migrations/0002_meal_search.sql',import.meta.url),'utf8').split(';').map(s=>s.trim()).filter(Boolean))await meal.query(sql);
  }
  const snapshots=await rows(database,"SELECT s.*,m.revision FROM snapshots s JOIN catalog_snapshot_storage m ON m.snapshot_id=s.id WHERE s.status='complete'");
  for(const snapshot of snapshots){
    const records=await rows(database,`SELECT code,content_hash FROM catalog_product_versions WHERE store_id=? AND valid_from<=? AND(valid_to IS NULL OR valid_to>?) ORDER BY code`,[String(snapshot.store_id),Number(snapshot.revision),Number(snapshot.revision)]);
    const hashes=records.map(p=>[String(p.code),String(p.content_hash)]).sort((a,b)=>a[0].localeCompare(b[0]));
    if(hashes.length!==Number(snapshot.product_count)||createHash('sha256').update(stableJson(hashes)).digest('hex')!==JSON.parse(String(snapshot.report_json)).contentHash)throw new Error('Migrated catalogue integrity mismatch');
  }
  const runs=await rows(database,"SELECT id,requirements,report_json FROM ingredient_runs WHERE status='complete'");
  for(const run of runs){
    const counts=(await rows(database,'SELECT COUNT(*) AS n,SUM(occurrences) AS occurrences FROM ingredient_links_read WHERE run_id=?',[String(run.id)]))[0];
    if(Number(counts.n)!==Number(run.requirements)||Number(counts.occurrences)!==JSON.parse(String(run.report_json)).ingredientOccurrences)throw new Error('Migrated ingredient connection count mismatch');
  }
  if(JSON.stringify(pointers)!==JSON.stringify(await rows(database,"SELECT key,value FROM catalog_state WHERE key IN('active_snapshot','active_ingredient_run') ORDER BY key")))throw new Error('Migration unexpectedly changed active identities');
  const report={operation:cleanup?'legacy-cleanup':'versioned-storage-migration',completedAt:new Date().toISOString(),snapshots:snapshots.length,connectionRuns:runs.length,rowsRead:database.rowsRead+meal.rowsRead,rowsWritten:database.rowsWritten+meal.rowsWritten,catalogSizeBytes:database.sizeBytes,mealSizeBytes:meal.sizeBytes,pointers};
  mkdirSync('data/verification',{recursive:true});writeFileSync(`data/verification/${cleanup?'delta-cleanup':'delta-migration'}-report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error instanceof Error?error.message:'Migration failed');process.exitCode=1;}
finally{for(const table of locked)await database.query(`DELETE FROM ${table} WHERE id=1 AND owner=?`,[owner]).catch(()=>{});}

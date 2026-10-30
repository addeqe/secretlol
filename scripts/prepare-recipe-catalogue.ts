/** Explicit, read-only cloud export. The ingestion engine itself never uses the network. */
import{mkdirSync,writeFileSync,renameSync}from'node:fs';
import{resolve,dirname}from'node:path';
import{createHash}from'node:crypto';
import{loadEnv}from'../src/config.ts';
import{D1DatabaseClient,rows}from'../src/database.ts';
import{scanIsCurrent}from'../src/price-freshness.ts';
loadEnv();
try{
  if(!process.argv.includes('--fetch'))throw new Error('Pass --fetch to explicitly download one read-only catalogue snapshot');
  const at=process.argv.indexOf('--output');
  const output=resolve(at<0?'data/recipe-ingestion-resources/willys-catalogue.json':process.argv[at+1]);
  const db=new D1DatabaseClient({readOnly:true});
  const snapshot=(await rows(db,`SELECT s.*,cs.oldest_observation_at FROM snapshots s
    LEFT JOIN catalog_snapshot_storage cs ON cs.snapshot_id=s.id
    WHERE s.id=(SELECT value FROM catalog_state WHERE key='active_snapshot') AND s.status='complete'`))[0];
  if(!snapshot)throw new Error('No complete Willys snapshot');
  const records=await rows(db,`SELECT json_remove(data_json,'$.raw','$.price','$.priceHash') AS product,
    json_extract(data_json,'$.raw.displayVolume') AS pack_label FROM catalog_entries_read WHERE snapshot_id=? ORDER BY code`,[String(snapshot.id)]);
  const products=records.map(r=>{const p=JSON.parse(String(r.product));return{...p,
    raw:{code:p.code,name:p.name,displayVolume:r.pack_label},
    observedAt:snapshot.oldest_observation_at??p.observedAt};});
  if(products.length!==Number(snapshot.product_count)||!products.length||new Set(products.map(p=>p.code)).size!==products.length)throw new Error('Incomplete/duplicate catalogue');
  if(products.some(p=>!scanIsCurrent(Date.parse(p.observedAt))))throw new Error('Willys snapshot is outside the current Swedish calendar week');
  const latest=(await rows(db,"SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0]?.value;
  if(latest!==snapshot.id)throw new Error('Snapshot changed during export; retry');
  const reviews=(await rows(db,'SELECT ingredient_name,decision_json FROM ingredient_reviews'));
  const payload={schemaVersion:1,retailer:'willys',storeId:String(snapshot.store_id),snapshotId:snapshot.id,
    completedAt:snapshot.completed_at,oldestObservation:products[0].observedAt,products,
    reviews:Object.fromEntries(reviews.map(r=>[String(r.ingredient_name),JSON.parse(String(r.decision_json))]))};
  const content=JSON.stringify(payload)+'\n';mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output+'.partial',content);renameSync(output+'.partial',output);
  console.log(JSON.stringify({output,products:products.length,snapshotId:snapshot.id,completedAt:snapshot.completed_at,
    sha256:createHash('sha256').update(content).digest('hex'),rowsRead:db.rowsRead,rowsWritten:db.rowsWritten}));
}catch(error){console.error(error instanceof Error?error.message:'Catalogue export failed');process.exitCode=1;}

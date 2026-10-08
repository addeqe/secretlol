import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {rows} from './database.ts';
import {stableJson} from './products.ts';
import type {Database,Entry,Statement} from './types.ts';

export function catalogStorageSchema(){return readFileSync(new URL('../migrations/0003_catalog_versions.sql',import.meta.url),'utf8');}
export async function ensureCatalogStorage(database:Database){
  for(const statement of catalogStorageSchema().split(';').map(s=>s.trim()).filter(Boolean))await database.query(statement);
}
export function storedProduct(entry:Entry){
  const {observedAt,...product}=entry;
  return {...product,price:{priceOre:entry.priceOre,priceUnit:entry.priceUnit,comparePriceOre:entry.comparePriceOre,
    comparePriceUnit:entry.comparePriceUnit,depositOre:entry.depositOre,offers:entry.offers,sourcePricing:entry.sourcePricing}};
}
export function productContentHash(entry:Entry){return createHash('sha256').update(stableJson(storedProduct(entry))).digest('hex');}
export function catalogueContentHash(entries:Entry[]){
  return createHash('sha256').update(stableJson(entries.map(e=>[e.code,productContentHash(e)]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
}
export type CatalogHashRecord=[string,string,string];
export function hashIndexDigest(records:CatalogHashRecord[]){return createHash('sha256').update(stableJson(records)).digest('hex');}
export function hashIndexStatements(storeId:string,snapshotId:string,records:CatalogHashRecord[]):Statement[]{
  const statements:Statement[]=[];
  for(let offset=0;offset<records.length;offset+=1000)statements.push({sql:`INSERT INTO catalog_hash_index VALUES(?,?,?,?) ON CONFLICT(store_id,part) DO UPDATE SET snapshot_id=excluded.snapshot_id,records_json=excluded.records_json`,params:[storeId,offset/1000,snapshotId,JSON.stringify(records.slice(offset,offset+1000))]});
  statements.push({sql:'DELETE FROM catalog_hash_index WHERE store_id=? AND part>=?',params:[storeId,Math.ceil(records.length/1000)]});
  return statements;
}
export async function readCatalogHashIndex(database:Database,snapshot:Record<string,unknown>){
  const report=JSON.parse(String(snapshot.report_json));
  if(!report.indexHash)return null;
  const parts=await rows(database,'SELECT part,snapshot_id,records_json FROM catalog_hash_index WHERE store_id=? ORDER BY part',[String(snapshot.store_id)]);
  if(parts.some((p,i)=>Number(p.part)!==i||p.snapshot_id!==snapshot.id))throw new Error('Catalogue hash index version mismatch; previous catalogue retained');
  const records=parts.flatMap(p=>JSON.parse(String(p.records_json))) as CatalogHashRecord[];
  if(records.length!==Number(snapshot.product_count)||new Set(records.map(r=>r[0])).size!==records.length||hashIndexDigest(records)!==report.indexHash)throw new Error('Catalogue hash index integrity mismatch; previous catalogue retained');
  return records.map(([code,content_hash,price_hash])=>({code,content_hash,price_hash}));
}

// Convert a legacy complete snapshot without changing its identity or freshness.
// The side metadata row is the atomic switch from legacy rows to interval rows.
export async function seedCatalogStorage(database:Database,snapshotId:string){
  await ensureCatalogStorage(database);
  if((await rows(database,'SELECT revision FROM catalog_snapshot_storage WHERE snapshot_id=?',[snapshotId]))[0])return {seeded:false,products:0};
  const snapshot=(await rows(database,"SELECT * FROM snapshots WHERE id=? AND status='complete'",[snapshotId]))[0];
  if(!snapshot)throw new Error('Cannot migrate an incomplete catalogue snapshot');
  const prior=(await rows(database,`SELECT s.*,m.revision FROM catalog_snapshot_storage m JOIN snapshots s ON s.id=m.snapshot_id WHERE s.store_id=? ORDER BY m.revision DESC LIMIT 1`,[String(snapshot.store_id)]))[0];
  if(prior&&String(snapshot.completed_at)<String(prior.completed_at))throw new Error('Legacy catalogue snapshots must be migrated in chronological order');
  const priorRows=prior?(await readCatalogHashIndex(database,prior))??await rows(database,`SELECT code,content_hash,price_hash FROM catalog_product_versions WHERE store_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)`,[String(snapshot.store_id),Number(prior.revision),Number(prior.revision)]):[];
  const oldByCode=new Map(priorRows.map(p=>[String(p.code),String(p.content_hash)]));
  const revision=Number((await rows(database,'SELECT COALESCE(MAX(revision),0)+1 AS n FROM catalog_snapshot_storage'))[0].n);
  // A failed seed has no side metadata yet and is invisible; remove only that revision.
  await database.query('DELETE FROM catalog_product_versions WHERE store_id=? AND valid_from=?',[String(snapshot.store_id),revision]);
  let after='',count=0,staged=0,oldest=Infinity;const hashes:Array<[string,string]>=[];const index:CatalogHashRecord[]=[];const changedCodes:string[]=[];
  for(;;){
    const batch=await rows(database,'SELECT code,data_json FROM catalog_entries WHERE snapshot_id=? AND code>? ORDER BY code LIMIT 100',[snapshotId,after]);
    if(!batch.length)break;
    const products=batch.map(r=>JSON.parse(String(r.data_json)) as Entry);
    for(const product of products){oldest=Math.min(oldest,Date.parse(product.observedAt));hashes.push([product.code,productContentHash(product)]);index.push([product.code,productContentHash(product),product.priceHash]);}
    const changed=products.filter(p=>oldByCode.get(p.code)!==productContentHash(p));changedCodes.push(...changed.map(p=>p.code));staged+=changed.length;
    if(changed.length)await database.query(`INSERT INTO catalog_product_versions SELECT ?,json_extract(value,'$.code'),?,NULL,
      json_extract(value,'$.name'),json_extract(value,'$.brand'),json_extract(value,'$.priceHash'),json_extract(value,'$.contentHash'),json_extract(value,'$.product') FROM json_each(?)`,
      [String(snapshot.store_id),revision,JSON.stringify(changed.map(p=>({code:p.code,name:p.name,brand:p.brand,priceHash:p.priceHash,contentHash:productContentHash(p),product:storedProduct(p)})))]);
    count+=products.length;after=products.at(-1)!.code;
  }
  const actual=changedCodes.length?Number((await rows(database,`SELECT COUNT(*) AS n FROM catalog_product_versions
    WHERE store_id=? AND code IN(SELECT value FROM json_each(?)) AND valid_from=?`,
    [String(snapshot.store_id),JSON.stringify(changedCodes),revision]))[0].n):0;
  if(count!==Number(snapshot.product_count)||actual!==staged||!Number.isFinite(oldest))throw new Error('Catalogue migration count/timestamp mismatch; legacy snapshot retained');
  hashes.sort((a,b)=>a[0].localeCompare(b[0]));
  index.sort((a,b)=>a[0].localeCompare(b[0]));
  const contentHash=createHash('sha256').update(stableJson(hashes)).digest('hex');
  const report={...JSON.parse(String(snapshot.report_json)),contentHash,indexHash:hashIndexDigest(index),oldestObservation:new Date(oldest).toISOString(),storageVersion:2};
  const currentCodes=new Set(index.map(r=>r[0]));changedCodes.push(...[...oldByCode.keys()].filter(code=>!currentCodes.has(code)));
  const close:Statement[]=[];
  for(let offset=0;offset<changedCodes.length;offset+=1000)close.push({sql:`UPDATE catalog_product_versions SET valid_to=? WHERE store_id=? AND valid_from<? AND valid_to IS NULL AND code IN(SELECT value FROM json_each(?))`,params:[revision,String(snapshot.store_id),revision,JSON.stringify(changedCodes.slice(offset,offset+1000))]});
  await database.batch([
    ...close,
    {sql:'INSERT INTO catalog_snapshot_storage VALUES(?,?,?)',params:[snapshotId,revision,new Date(oldest).toISOString()]},
    {sql:'UPDATE snapshots SET report_json=? WHERE id=?',params:[JSON.stringify(report),snapshotId]}
    ,...hashIndexStatements(String(snapshot.store_id),snapshotId,index)
  ]);
  return {seeded:true,products:count,contentHash};
}

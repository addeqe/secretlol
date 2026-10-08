import {randomUUID} from 'node:crypto';
import {integer} from './config.ts';
import {D1DatabaseClient,rows} from './database.ts';
import {ensureCatalogStorage,seedCatalogStorage,storedProduct,productContentHash,catalogueContentHash,readCatalogHashIndex,hashIndexDigest,hashIndexStatements} from './catalog-storage.ts';
import type {CatalogHashRecord} from './catalog-storage.ts';
import type {Database,Entry,Scan,Statement} from './types.ts';

export async function publish(database:Database,scan:Scan,options:{allowShrink?:boolean;historyDays?:number}={}){
  if(!scan.entries.length||new Set(scan.entries.map(p=>p.code)).size!==scan.entries.length)throw new Error('Empty/duplicate catalogue cannot be published');
  const oldest=Math.min(...scan.entries.map(p=>Date.parse(p.observedAt)));
  if(!Number.isFinite(oldest))throw new Error('Invalid catalogue observation time');
  const id=randomUUID(),now=new Date().toISOString();
  await ensureCatalogStorage(database);
  await database.query(`INSERT INTO sync_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sync_lock.expires_at<?`,[id,new Date(Date.now()+20*60000).toISOString(),now]);
  if((await rows(database,'SELECT owner FROM sync_lock WHERE id=1'))[0]?.owner!==id)throw new Error('Another sync is publishing. Retry later.');
  try{
    const previousId=String((await rows(database,"SELECT value FROM catalog_state WHERE key='active_snapshot'"))[0]?.value??'');
    const previous=(await rows(database,'SELECT * FROM snapshots WHERE id=?',[previousId]))[0];
    if(previous&&previous.store_id!==scan.store.storeId)throw new Error('Database belongs to a different store. Use a separate database for another store.');
    if(previous&&!options.allowShrink&&scan.entries.length<Number(previous.product_count)*.8)throw new Error('Catalogue shrank by more than 20%. Previous catalogue retained. Verify the source, then use --allow-shrink for a confirmed change.');
    if(previous)await seedCatalogStorage(database,previousId);
    // Only the active snapshot must survive while a replacement stages. Read exact
    // retired IDs instead of repeatedly scanning the active catalogue in each batch.
    const haveIngredients=(await rows(database,"SELECT name FROM sqlite_master WHERE type='table' AND name='ingredient_runs'")).length>0;
    const retired=await rows(database,`SELECT s.id,m.revision FROM snapshots s LEFT JOIN catalog_snapshot_storage m ON m.snapshot_id=s.id WHERE s.id!=? ${haveIngredients?"AND NOT EXISTS(SELECT 1 FROM ingredient_runs r WHERE r.catalogue_snapshot_id=s.id AND r.status='complete')":''}`,[previousId]);
    let cleaned=0;
    for(const stale of retired){
      for(;;){const old=await rows(database,'SELECT code FROM catalog_entries WHERE snapshot_id=? LIMIT 500',[String(stale.id)]);if(!old.length)break;
        await database.query('DELETE FROM catalog_entries WHERE snapshot_id=? AND code IN (SELECT value FROM json_each(?))',[String(stale.id),JSON.stringify(old.map(r=>r.code))]);cleaned+=old.length;if(cleaned>40000)throw new Error('Cleanup budget exceeded. Retry before collecting another catalogue.');}
      // Abandoned future revisions never closed any active interval.
      const status=(await rows(database,'SELECT status FROM snapshots WHERE id=?',[String(stale.id)]))[0]?.status;
      if(status==='staging'&&stale.revision!=null)await database.query('DELETE FROM catalog_product_versions WHERE store_id=? AND valid_from=?',[scan.store.storeId,Number(stale.revision)]);
      await database.query('DELETE FROM catalog_snapshot_storage WHERE snapshot_id=?',[String(stale.id)]);
      await database.query('DELETE FROM snapshots WHERE id=?',[String(stale.id)]);
    }
    const priorStorage=(await rows(database,'SELECT revision FROM catalog_snapshot_storage WHERE snapshot_id=?',[previousId]))[0];
    const oldestRevision=(await rows(database,'SELECT MIN(m.revision) AS n FROM catalog_snapshot_storage m JOIN snapshots s ON s.id=m.snapshot_id WHERE s.store_id=?',[scan.store.storeId]))[0]?.n;
    if(oldestRevision!=null){for(;;){const old=await rows(database,'SELECT store_id,code,valid_from FROM catalog_product_versions WHERE store_id=? AND valid_to<=? LIMIT 500',[scan.store.storeId,Number(oldestRevision)]);if(!old.length)break;
      await database.query(`DELETE FROM catalog_product_versions WHERE (store_id,code,valid_from) IN (SELECT json_extract(value,'$.store_id'),json_extract(value,'$.code'),json_extract(value,'$.valid_from') FROM json_each(?))`,[JSON.stringify(old)]);}}
    const historyCutoff=new Date(Date.now()-(options.historyDays??integer('HISTORY_DAYS',90,1,365))*86400000).toISOString();
    await database.query(`DELETE FROM price_history WHERE (store_id,code,observed_at) IN (SELECT store_id,code,observed_at FROM price_history WHERE observed_at<? LIMIT 2000)`,[historyCutoff]);
    const previousFresh=previous?(await rows(database,'SELECT * FROM snapshots WHERE id=?',[previousId]))[0]:null;
    const previousProducts=priorStorage?(await readCatalogHashIndex(database,previousFresh!))??await rows(database,`SELECT code,content_hash,price_hash FROM catalog_product_versions WHERE store_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)`,[scan.store.storeId,Number(priorStorage.revision),Number(priorStorage.revision)]):[];
    if(previous&&previousProducts.length!==Number(previous.product_count))throw new Error('Previous catalogue storage is incomplete; no new snapshot published');
    const oldMap=new Map(previousProducts.map(p=>[String(p.code),p]));
    const nextHashes=new Map(scan.entries.map(p=>[p.code,productContentHash(p)]));
    const changed=scan.entries.filter(p=>oldMap.get(p.code)?.content_hash!==nextHashes.get(p.code));
    const removed=[...oldMap.keys()].filter(code=>!nextHashes.has(code));
    const added=changed.filter(p=>!oldMap.has(p.code)).length;
    const priceChanged=changed.filter(p=>oldMap.get(p.code)?.price_hash!==p.priceHash).length;
    const revision=Number((await rows(database,'SELECT COALESCE(MAX(revision),0)+1 AS n FROM catalog_snapshot_storage'))[0].n);
    if(database instanceof D1DatabaseClient){
      const estimate=changed.length+2*(changed.length-added+removed.length)+2*priceChanged+100;
      if(database.rowsWritten+estimate>integer('MAX_D1_ROWS_WRITTEN',80000))throw new Error('Catalogue changes exceed this run’s write budget; previous catalogue retained');
      const bytes=Buffer.byteLength(JSON.stringify(changed));
      if(database.sizeBytes+bytes*1.5>integer('MAX_D1_SIZE_MB',400)*1024*1024)throw new Error('Catalogue would exceed the configured storage budget.');
    }
    const contentHash=catalogueContentHash(scan.entries);
    const index=scan.entries.map(p=>[p.code,nextHashes.get(p.code)!,p.priceHash] as CatalogHashRecord).sort((a,b)=>a[0].localeCompare(b[0]));
    const report=JSON.stringify({categories:scan.categories,requests:scan.requests,contentHash,indexHash:hashIndexDigest(index),oldestObservation:new Date(oldest).toISOString(),storageVersion:2});
    await database.query(`INSERT INTO snapshots VALUES(?,?,?,?,NULL,?,'staging',?)`,[id,scan.store.storeId,scan.store.name,scan.startedAt,scan.entries.length,report]);
    await database.query('INSERT INTO catalog_snapshot_storage VALUES(?,?,?)',[id,revision,new Date(oldest).toISOString()]);
    for(let offset=0;offset<changed.length;offset+=100){
      const batch=changed.slice(offset,offset+100).map(p=>({code:p.code,name:p.name,brand:p.brand,priceHash:p.priceHash,contentHash:nextHashes.get(p.code),product:storedProduct(p)}));
      await database.query(`INSERT INTO catalog_product_versions SELECT ?,json_extract(value,'$.code'),?,NULL,json_extract(value,'$.name'),json_extract(value,'$.brand'),json_extract(value,'$.priceHash'),json_extract(value,'$.contentHash'),json_extract(value,'$.product') FROM json_each(?)`,[scan.store.storeId,revision,JSON.stringify(batch)]);
    }
    const staged=changed.length?Number((await rows(database,`SELECT COUNT(*) AS n FROM catalog_product_versions
      WHERE store_id=? AND code IN(SELECT value FROM json_each(?)) AND valid_from=?`,
      [scan.store.storeId,JSON.stringify(changed.map(p=>p.code)),revision]))[0].n):0;
    if(staged!==changed.length||previousProducts.length+added-removed.length!==scan.entries.length)throw new Error('Staged catalogue count mismatch. Previous snapshot retained.');
    if((await rows(database,'SELECT owner FROM sync_lock WHERE id=1 AND expires_at>?',[new Date().toISOString()]))[0]?.owner!==id)throw new Error('Publication lock expired. Previous snapshot retained.');
    const statements:Statement[]=[];const changedCodes=[...changed.map(p=>p.code),...removed];
    for(let offset=0;offset<changedCodes.length;offset+=1000)statements.push({sql:`UPDATE catalog_product_versions SET valid_to=? WHERE store_id=? AND valid_from<? AND valid_to IS NULL AND code IN (SELECT value FROM json_each(?))`,params:[revision,scan.store.storeId,revision,JSON.stringify(changedCodes.slice(offset,offset+1000))]});
    // History and the pointer switch see a fully closed/opened interval set in one
    // transaction. Old readers still resolve the exact previously pinned revision.
    const history=changed.filter(p=>oldMap.get(p.code)?.price_hash!==p.priceHash);
    for(let offset=0;offset<history.length;offset+=100)statements.push({sql:`INSERT OR IGNORE INTO price_history SELECT ?,json_extract(value,'$.code'),json_extract(value,'$.observedAt'),json_extract(value,'$.priceHash'),json_extract(value,'$.price') FROM json_each(?)`,params:[scan.store.storeId,JSON.stringify(history.slice(offset,offset+100).map(p=>({code:p.code,observedAt:p.observedAt,priceHash:p.priceHash,price:storedProduct(p).price})))]});
    statements.push(...hashIndexStatements(scan.store.storeId,id,index),
      {sql:"UPDATE snapshots SET status='complete',completed_at=? WHERE id=?",params:[scan.completedAt,id]},
      {sql:"INSERT INTO catalog_state VALUES('active_snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params:[id]}
    );
    await database.batch(statements);
    return {snapshotId:id,products:scan.entries.length,store:scan.store,completedAt:scan.completedAt,contentHash,
      storageVersion:2,delta:{added,updated:changed.length-added,removed:removed.length,unchanged:scan.entries.length-changed.length,priceChanges:priceChanged},
      ...(database instanceof D1DatabaseClient?{rowsWritten:database.rowsWritten,rowsRead:database.rowsRead,sizeBytes:database.sizeBytes}:{})};
  }finally{await database.query('DELETE FROM sync_lock WHERE id=1 AND owner=?',[id]).catch(()=>{});}
}

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DIETARY_POLICY_VERSION } from '../dietary-policy.ts';
import { rows, D1DatabaseClient } from '../database.ts';
import { integer } from '../config.ts';
import type { Database, Statement } from '../types.ts';
import { validateConnections, validateObservation } from './identity.ts';
import { connectionHealth } from './connection-health.ts';
import type { ReviewedConnection } from './identity.ts';
import type { ProductObservation, RetailerId, StoreScope } from './types.ts';
import { scopeKey, validateScope } from './types.ts';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function retailSchema(): string {
  return readFileSync(new URL('../../retail-migrations/0001_retailers.sql', import.meta.url), 'utf8');
}
export type RetailDataset = { retailer: RetailerId; scope: StoreScope; datasetId: string; inventoryHash: string;
  observations: ProductObservation[]; connections: ReviewedConnection[] };
export async function configureRetailDataset(db: Database, data: RetailDataset): Promise<void> {
  if (!['coop','ica'].includes(data.retailer) || !data.datasetId || !data.inventoryHash) throw new Error('invalid_retail_dataset');
  validateScope(data.scope);
  const meta = Object.fromEntries((await rows(db,'SELECT key,value FROM retail_meta')).map(r=>[r.key,r.value]));
  if (meta.retailer && meta.retailer !== data.retailer || meta.reference_scope && meta.reference_scope !== scopeKey(data.retailer,data.scope)
    || meta.inventory_hash && meta.inventory_hash !== data.inventoryHash || meta.dataset_id && meta.dataset_id !== data.datasetId) {
    throw new Error('retail_database_scope_mismatch');
  }
  for (const o of data.observations) validateObservation(o,data.retailer,data.scope);
  validateConnections(data.connections,data.observations.map(o=>o.product));
  const connectionsVersion=hash([...data.connections].sort((a,b)=>a.ingredientId.localeCompare(b.ingredientId)));
  const statements: Statement[] = Object.entries({retailer:data.retailer,reference_scope:scopeKey(data.retailer,data.scope),
    dataset_id:data.datasetId,inventory_hash:data.inventoryHash,policy_version:DIETARY_POLICY_VERSION,connections_version:connectionsVersion}).map(([key,value])=>({
      sql:'INSERT INTO retail_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value',params:[key,value]}));
  for (const c of data.connections) statements.push({sql:`INSERT INTO retail_connections VALUES(?,?,?,?)
    ON CONFLICT(ingredient_id) DO UPDATE SET ingredient_name=excluded.ingredient_name,status=excluded.status,document_json=excluded.document_json
    WHERE document_json<>excluded.document_json`,params:[c.ingredientId,c.name,c.status,JSON.stringify(c)]});
  const watched = [...new Set(data.connections.flatMap(c=>c.approvedProducts.map(p=>p.productId)))].sort();
  statements.push({sql:'DELETE FROM retail_connections WHERE ingredient_id NOT IN (SELECT value FROM json_each(?))',params:[JSON.stringify(data.connections.map(c=>c.ingredientId))]});
  statements.push({sql:'DELETE FROM retail_tracked WHERE product_id NOT IN (SELECT value FROM json_each(?))',params:[JSON.stringify(watched)]});
  for (const id of watched) statements.push({sql:'INSERT OR IGNORE INTO retail_tracked VALUES(?)',params:[id]});
  await db.batch(statements);
}
export async function publishRetailObservations(db: Database, retailer: RetailerId, scope: StoreScope,
  observations: ProductObservation[], expectedIds: string[], now=Date.now()) {
  validateScope(scope);
  const key = scopeKey(retailer,scope), ids = [...expectedIds].sort();
  const meta=Object.fromEntries((await rows(db,'SELECT key,value FROM retail_meta')).map(r=>[r.key,r.value]));
  if (meta.retailer !== retailer || meta.reference_scope !== key) throw new Error('retail_database_scope_mismatch');
  if (!ids.length || new Set(ids).size !== ids.length || observations.length !== ids.length
    || new Set(observations.map(o=>o.product.id)).size !== ids.length
    || observations.some(o=>!ids.includes(o.product.id))) throw new Error('incomplete_tracked_refresh');
  for (const o of observations) {
    validateObservation(o,retailer,scope);
    if (Date.parse(o.checkedAt) > now+60000 || now-Date.parse(o.checkedAt)>=86400000 || Date.parse(o.expiresAt)<=now) throw new Error('stale_refresh_observation');
  }
  const tracked = (await rows(db,'SELECT product_id FROM retail_tracked ORDER BY product_id')).map(r=>String(r.product_id));
  if (JSON.stringify(ids)!==JSON.stringify(tracked)) throw new Error('tracked_inventory_mismatch');
  const previous = new Map((await rows(db,'SELECT product_id,content_hash,price_hash FROM retail_products WHERE scope_key=?',[key])).map(r=>[String(r.product_id),r]));
  const id=randomUUID(), checkedAt=new Date(Math.min(...observations.map(o=>Date.parse(o.checkedAt)))).toISOString();
  const expiresAt=new Date(Math.min(...observations.map(o=>Date.parse(o.expiresAt)))).toISOString();
  const statements: Statement[]=[];let changed=0, priceChanges=0;
  for (const o of observations) {
    const contentHash=hash({product:o.product,price:o.price,availability:o.availability,storeScopeVerified:o.storeScopeVerified});
    const priceHash=hash(o.price), before=previous.get(o.product.id);
    if (before?.content_hash!==contentHash) {
      changed++; statements.push({sql:`INSERT INTO retail_products VALUES(?,?,?,?,?) ON CONFLICT(scope_key,product_id)
        DO UPDATE SET content_hash=excluded.content_hash,price_hash=excluded.price_hash,observation_json=excluded.observation_json`,
        params:[key,o.product.id,contentHash,priceHash,JSON.stringify(o)]});
    }
    if (before?.price_hash!==priceHash) {
      priceChanges++;statements.push({sql:'INSERT INTO retail_price_history VALUES(?,?,?,?)',params:[key,o.product.id,o.checkedAt,JSON.stringify(o.price)]});
    }
  }
  const connectionRows=await rows(db,`SELECT c.document_json,h.document_json AS health_json FROM retail_connections c
    LEFT JOIN retail_connection_health h ON h.ingredient_id=c.ingredient_id`);
  const connections=connectionRows.map(r=>JSON.parse(String(r.document_json)) as ReviewedConnection);
  const observedById=new Map(observations.map(o=>[o.product.id,o]));
  const health=connections.map(c=>connectionHealth(c,c.approvedProducts.flatMap(p=>observedById.has(p.productId)?[observedById.get(p.productId)!]:[]),retailer,scope,now));
  let healthChanges=0;
  for(const [i,h] of health.entries())if(connectionRows[i].health_json!==JSON.stringify(h)){
    healthChanges++;statements.push({sql:`INSERT INTO retail_connection_health VALUES(?,?) ON CONFLICT(ingredient_id)
      DO UPDATE SET document_json=excluded.document_json`,params:[h.ingredientId,JSON.stringify(h)]});
  }
  const connectionsByStatus=Object.fromEntries(['matched','needs_review','unavailable','non_purchased'].map(s=>[s,health.filter(h=>h.status===s).length]));
  const report={id,retailer,scope,checked:ids.length,changed,unchanged:ids.length-changed,priceChanges,checkedAt,expiresAt,
    connectionsByStatus,needsReviewNames:health.filter(h=>h.status==='needs_review').map(h=>h.name)};
  statements.push({sql:'INSERT INTO retail_runs VALUES(?,?,?,?,?,?)',params:[id,key,checkedAt,expiresAt,JSON.stringify(ids),JSON.stringify(report)]});
  statements.push({sql:'INSERT INTO retail_scope_state VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET active_run_id=excluded.active_run_id',params:[key,id]});
  // Include indexes and metadata in a conservative preflight, before any writes.
  const estimatedWrites=10+changed*5+priceChanges*5+healthChanges*3;
  if(db instanceof D1DatabaseClient&&db.rowsWritten+estimatedWrites>integer('MAX_D1_ROWS_WRITTEN',80000))throw new Error('retailer_write_budget_retained_previous_version');
  await db.batch(statements);
  return report;
}
export async function pruneRetailHistory(db:Database,now=Date.now(),limit=100){
  if(!Number.isSafeInteger(limit)||limit<1||limit>250)throw new Error('invalid_cleanup_budget');
  const cutoff=new Date(now-90*86400000).toISOString();
  await db.batch([
    {sql:'DELETE FROM retail_price_history WHERE rowid IN (SELECT rowid FROM retail_price_history WHERE changed_at<? ORDER BY changed_at LIMIT ?)',params:[cutoff,limit]},
    {sql:`DELETE FROM retail_runs WHERE id IN (SELECT id FROM retail_runs WHERE checked_at<?
      AND id NOT IN (SELECT active_run_id FROM retail_scope_state) ORDER BY checked_at LIMIT ?)`,params:[cutoff,limit]},
  ]);
}
export async function readRetailObservations(db: Database, retailer: RetailerId, scope: StoreScope, ids: string[]) {
  const key=scopeKey(retailer,scope);
  const run=(await rows(db,`SELECT r.checked_at,r.expires_at,r.checked_ids_json FROM retail_scope_state s
    JOIN retail_runs r ON r.id=s.active_run_id WHERE s.scope_key=?`,[key]))[0];
  if (!run || !ids.length) return [];
  const verified=new Set(JSON.parse(String(run.checked_ids_json)) as string[]);
  return (await rows(db,`SELECT observation_json FROM retail_products WHERE scope_key=?
    AND product_id IN (SELECT value FROM json_each(?))`,[key,JSON.stringify(ids)])).map(r=>{
      const o=JSON.parse(String(r.observation_json)) as ProductObservation;
      return verified.has(o.product.id)?{...o,checkedAt:String(run.checked_at),expiresAt:String(run.expires_at)}:o;
    });
}

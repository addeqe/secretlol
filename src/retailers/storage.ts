import { calendarWeekEnd, scanIsCurrent } from '../price-freshness.ts';
import { referenceObservation } from './freshness.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DIETARY_POLICY_VERSION } from '../dietary-policy.ts';
import { rows, D1DatabaseClient } from '../database.ts';
import { integer } from '../config.ts';
import type { Database, Statement } from '../types.ts';
import { productIdentity, validateConnections, validateObservation } from './identity.ts';
import { connectionHealth } from './connection-health.ts';
import type { ReviewedConnection } from './identity.ts';
import type { ProductObservation, RetailerId, StoreScope } from './types.ts';
import { productId, scopeKey, validateScope } from './types.ts';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function retailSchema(): string {
  return readFileSync(new URL('../../retail-migrations/0001_retailers.sql', import.meta.url), 'utf8');
}
export type RetailDataset = { retailer: RetailerId; scope: StoreScope; datasetId: string; inventoryHash: string;
  observations: ProductObservation[]; connections: ReviewedConnection[] };
type AvailabilitySummary = { schemaVersion: 1; retailer: RetailerId; scopeKey: string; datasetId: string;
  inventoryHash: string; policyVersion: string; connectionsVersion: string; distinctIngredients: number;
  checkedProductCount: number; brokenNames: string[]; earliestPriceBoundary: string | null };
function productsFromConnectionIdentities(connections: ReviewedConnection[]) {
  return connections.flatMap(connection => connection.approvedProducts.map(approved => {
    let identity: unknown;
    try { identity = JSON.parse(approved.identity); } catch { throw new Error('invalid_reviewed_product_identity'); }
    if (!Array.isArray(identity) || identity.length !== 7 || typeof identity[0] !== 'string'
      || (identity[1] !== null && typeof identity[1] !== 'string') || typeof identity[2] !== 'string'
      || (identity[3] !== null && typeof identity[3] !== 'string')
      || !Array.isArray(identity[4]) || identity[4].some(category => typeof category !== 'string')
      || (identity[5] !== null && (!Array.isArray(identity[5]) || identity[5].length !== 4
        || typeof identity[5][0] !== 'number' || typeof identity[5][1] !== 'string'
        || typeof identity[5][2] !== 'boolean' || identity[5][3] !== null && typeof identity[5][3] !== 'number'))
      || (identity[6] !== null && typeof identity[6] !== 'string')) throw new Error('invalid_reviewed_product_identity');
    const packValue = identity[5] as [number, 'g'|'ml'|'piece', boolean, number|null] | null;
    const product = { id: identity[0], ean: identity[1] as string|null, name: identity[2],
      brand: identity[3] as string|null, categories: identity[4] as string[],
      pack: packValue === null ? null : { quantity: packValue[0], unit: packValue[1], approximate: packValue[2],
        ...(packValue[3] === null ? {} : { drainedGrams: packValue[3] }) }, ingredientsText: identity[6] as string|null };
    if (!productId(product.id) || !product.name.trim() || (product.pack !== null
      && (!Number.isFinite(product.pack.quantity) || product.pack.quantity <= 0
        || !['g','ml','piece'].includes(product.pack.unit)
        || product.pack.drainedGrams !== undefined && (!Number.isFinite(product.pack.drainedGrams)
          || product.pack.drainedGrams <= 0))) || productIdentity(product) !== approved.identity) {
      throw new Error('invalid_reviewed_product_identity');
    }
    return product;
  }));
}
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
  if (meta.policy_version !== DIETARY_POLICY_VERSION) throw new Error('retail_policy_version_mismatch');
  if (!ids.length || new Set(ids).size !== ids.length || observations.length !== ids.length
    || new Set(observations.map(o=>o.product.id)).size !== ids.length
    || observations.some(o=>!ids.includes(o.product.id))) throw new Error('incomplete_tracked_refresh');
  for (const o of observations) {
    validateObservation(o,retailer,scope);
    if (!scanIsCurrent(Date.parse(o.checkedAt),now) || Date.parse(o.expiresAt)<=now) throw new Error('stale_refresh_observation');
  }
  const tracked = (await rows(db,'SELECT product_id FROM retail_tracked ORDER BY product_id')).map(r=>String(r.product_id));
  if (JSON.stringify(ids)!==JSON.stringify(tracked)) throw new Error('tracked_inventory_mismatch');
  const previous = new Map((await rows(db,'SELECT product_id,content_hash,price_hash FROM retail_products WHERE scope_key=?',[key])).map(r=>[String(r.product_id),r]));
  const id=randomUUID(), checkedAt=new Date(Math.min(...observations.map(o=>Date.parse(o.checkedAt)))).toISOString();
  const expiresAt=new Date(calendarWeekEnd(Date.parse(checkedAt))).toISOString();
  const statements: Statement[]=[];let changed=0, priceChanges=0;
  for (const o of observations) {
    const contentHash=hash({product:o.product,identityEvidence:o.identityEvidence??null,price:o.price,
      availability:o.availability,storeScopeVerified:o.storeScopeVerified});
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
  const connectionRows=await rows(db,`SELECT c.ingredient_id,c.ingredient_name,c.status,c.document_json,h.document_json AS health_json FROM retail_connections c
    LEFT JOIN retail_connection_health h ON h.ingredient_id=c.ingredient_id`);
  const connections=connectionRows.map(r=>{
    const connection=JSON.parse(String(r.document_json)) as ReviewedConnection;
    if(connection.ingredientId!==r.ingredient_id||connection.name!==r.ingredient_name||connection.status!==r.status)
      throw new Error('retail_connection_row_mismatch');
    return connection;
  });
  if (!connections.length || hash([...connections].sort((a,b)=>a.ingredientId.localeCompare(b.ingredientId))) !== meta.connections_version) {
    throw new Error('retail_connections_changed_before_publication');
  }
  // The version hash only proves the connection rows have not changed since configure.
  // Revalidate their persisted approval identities and current policy before trusting them
  // to produce the summary that skips cold full-table checks.
  validateConnections(connections, productsFromConnectionIdentities(connections));
  const observedById=new Map(observations.map(o=>[o.product.id,o]));
  const health=connections.map(c=>connectionHealth(c,c.approvedProducts.flatMap(p=>observedById.has(p.productId)?[observedById.get(p.productId)!]:[]),retailer,scope,now));
  let healthChanges=0;
  for(const [i,h] of health.entries())if(connectionRows[i].health_json!==JSON.stringify(h)){
    healthChanges++;statements.push({sql:`INSERT INTO retail_connection_health VALUES(?,?) ON CONFLICT(ingredient_id)
      DO UPDATE SET document_json=excluded.document_json`,params:[h.ingredientId,JSON.stringify(h)]});
  }
  const connectionsByStatus=Object.fromEntries(['matched','needs_review','unavailable','non_purchased'].map(s=>[s,health.filter(h=>h.status===s).length]));
  const brokenNames=health.filter(h=>h.status!=='matched'&&h.status!=='non_purchased').map(h=>h.name).sort();
  const priceBoundaries=observations.flatMap(o=>[o.price?.validFrom,o.price?.validUntil]
    .filter((value):value is string=>!!value)
    .map(value=>Date.parse(value)).filter(value=>Number.isFinite(value)&&value>now));
  const earliestPriceBoundary=priceBoundaries.length?new Date(Math.min(...priceBoundaries)).toISOString():null;
  const availabilitySummary:AvailabilitySummary={schemaVersion:1,retailer,scopeKey:key,datasetId:meta.dataset_id,
    inventoryHash:meta.inventory_hash,policyVersion:meta.policy_version,connectionsVersion:meta.connections_version,
    distinctIngredients:connections.length,checkedProductCount:ids.length,brokenNames,earliestPriceBoundary};
  const report={id,retailer,scope,checked:ids.length,changed,unchanged:ids.length-changed,priceChanges,checkedAt,expiresAt,
    connectionsByStatus,needsReviewNames:health.filter(h=>h.status==='needs_review').map(h=>h.name),availabilitySummary};
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
      return referenceObservation(o,verified.has(o.product.id)?String(run.checked_at):o.checkedAt);
    });
}

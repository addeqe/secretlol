import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LocalDatabase, D1DatabaseClient, rows } from '../src/database.ts';
import { required } from '../src/config.ts';
import type { Database } from '../src/types.ts';
import { loadCloudRequirements } from '../src/meal-import.ts';
import { loadAssessments } from '../src/ingredient-assessments.ts';
import { CoopClient } from '../src/retailers/coop.ts';
import { IcaClient } from '../src/retailers/ica.ts';
import { collectReference, collectTracked } from '../src/retailers/collection.ts';
import { configureRetailDataset, publishRetailObservations, readRetailObservations, retailSchema, type RetailDataset } from '../src/retailers/storage.ts';
import { optimizeBasket } from '../src/retailers/basket.ts';
import { scopeKey, validateScope } from '../src/retailers/types.ts';
import type { RetailClient, RetailerId, StoreScope } from '../src/retailers/types.ts';
import { coopReviewCategoryMap, prepareReviewBatches, validateReviewedInventory,
  type ManualReviewNominations } from '../src/retailers/review.ts';
import { checkpointedClient } from '../src/retailers/checkpoints.ts';
import { createRetailTransport } from '../src/retailers/transport.ts';

// There is intentionally no loadEnv() or remote default. An offline demo never
// discovers saved Cloudflare credentials or contacts a service.
const {values:args,positionals} = parseArgs({allowPositionals:true,options:{
  retailer:{type:'string'},'store-id':{type:'string'},channel:{type:'string'},'slot-id':{type:'string'},
  fixture:{type:'string'},local:{type:'string'},input:{type:'string'},inventory:{type:'string'},output:{type:'string'},
  categories:{type:'string'},
  'allow-live':{type:'boolean',default:false},remote:{type:'boolean',default:false},
  'confirm-cloudflare':{type:'boolean',default:false},'write-budget':{type:'string'},
  checkpoint:{type:'string'},
}});
const command=positionals[0]??'demo';
const read=(path:string)=>JSON.parse(readFileSync(resolve(path),'utf8'));
function save(path:string,value:unknown){const target=resolve(path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(value,null,2)+'\n');}
function retailer():RetailerId{if(args.retailer!=='coop'&&args.retailer!=='ica')throw new Error('Supply --retailer coop or ica');return args.retailer;}
function client(id:RetailerId):RetailClient{
  const transport=createRetailTransport({retailer:id});
  return id==='coop'?new CoopClient({publicSubscriptionKey:process.env.COOP_PUBLIC_SUBSCRIPTION_KEY,transport}):new IcaClient({transport});
}
function live(){if(!args['allow-live'])throw new Error('Retailer requests require --allow-live; no scan started');}
function scope():StoreScope{const s={storeId:args['store-id']!,channel:(args.channel??'pickup') as StoreScope['channel'],...(args['slot-id']?{slotId:args['slot-id']}: {})};validateScope(s);return s;}
function cloud(dbId:string,readOnly=false){
  if(!args.remote||!args['confirm-cloudflare']||process.env.RETAILERS_CLOUD_ENABLED!=='true')throw new Error('Cloudflare is disabled. Explicit --remote --confirm-cloudflare and RETAILERS_CLOUD_ENABLED=true are required');
  return new D1DatabaseClient({databaseId:required(dbId),readOnly});
}
function database(id:RetailerId):Database{
  if(args.remote){if(args.local)throw new Error('Choose local or remote, not both');return cloud(id==='coop'?'COOP_DATABASE_ID':'ICA_DATABASE_ID');}
  if(!args.local)throw new Error('Supply --local path.sqlite; there is no implicit cloud destination');
  const db=new LocalDatabase(resolve(args.local));db.execute(retailSchema());return db;
}
function budget(db:Database,estimate:number){
  if(!(db instanceof D1DatabaseClient))return;
  const allowance=Number(args['write-budget']);
  if(!Number.isSafeInteger(allowance)||allowance<1||allowance>50000||estimate>allowance)throw new Error(`Publication requires an explicit remaining account write allowance; conservative estimate ${estimate} rows`);
  process.env.MAX_D1_ROWS_WRITTEN=String(allowance);
}
async function main(){
  if(positionals.length>1)throw new Error('Unexpected command arguments');
  if(command==='demo'){
    if(args.remote||args['allow-live']||args['confirm-cloudflare'])throw new Error('Demo is offline only');
    const data=read(args.fixture??'tests/fixtures/retailers/demo-coop.json') as RetailDataset & {sourceMarker?:string};
    if(!data.sourceMarker?.includes('SYNTHETIC'))throw new Error('Demo requires a marked synthetic fixture');
    // Re-date only explicitly synthetic data, never observations from a real scan.
    const now=Date.now();for(const o of data.observations){o.checkedAt=new Date(now).toISOString();o.expiresAt=new Date(now+86400000).toISOString();}
    const db=new LocalDatabase(args.local?resolve(args.local):':memory:');
    try{db.execute(retailSchema());await configureRetailDataset(db,data);
      const ids=data.connections.flatMap(c=>c.approvedProducts.map(p=>p.productId));
      const tracked=[...new Set(ids)];const obs=data.observations.filter(o=>tracked.includes(o.product.id));
      const first=await publishRetailObservations(db,data.retailer,data.scope,obs,tracked,now);
      const second=await publishRetailObservations(db,data.retailer,data.scope,obs,tracked,now);
      const basket=optimizeBasket({retailer:data.retailer,scope:data.scope,observations:obs,now,
        demands:data.connections.map(c=>({ingredientId:c.ingredientId,name:c.name,quantity:c.name==='rice'?750:c.name==='eggs'?8:2,
          unit:c.name==='rice'?'g':'piece',approvedProductIds:c.approvedProducts.map(p=>p.productId),nonPurchased:c.status==='non_purchased'}))});
      console.log(JSON.stringify({mode:'SYNTHETIC OFFLINE DEMO',cloudflareRequests:0,retailerRequests:0,first,unchanged:second,basket},null,2));
    }finally{db.close();}return;
  }
  if(command==='capabilities'){const id=retailer();console.log(JSON.stringify({retailer:id,...client(id).capabilities},null,2));return;}
  if(command==='scan'){
    if(args.remote)throw new Error('A scan only creates a local source artifact; publish approved products separately');
    live();const id=retailer(), s=scope();const scanner=checkpointedClient(client(id),resolve(args.checkpoint??`data/${id}-scan-checkpoints`));
    const result=await collectReference(scanner,s);
    const output=args.output??`data/${id}-reference-scan.json`;save(output,{...result,completedAt:new Date().toISOString()});console.log(JSON.stringify({output:resolve(output),products:result.products.length,pages:result.pages}));return;
  }
  if(command==='archive'){
    if(args.remote||args['allow-live'])throw new Error('Archive preparation is offline');
    if(!args.input)throw new Error('Supply --input scan.json');
    const scan=read(args.input);
    if(!['coop','ica'].includes(scan.retailer)||!Array.isArray(scan.products)||!scan.products.length||!scan.completedAt)throw new Error('Invalid scan artifact');
    const bytes=gzipSync(Buffer.from(JSON.stringify(scan)),{level:9});
    const output=resolve(args.output??`${args.input}.gz`);mkdirSync(dirname(output),{recursive:true});writeFileSync(output,bytes);
    save(`${output}.manifest.json`,{retailer:scan.retailer,scope:scan.scope,products:scan.products.length,completedAt:scan.completedAt,
      sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,format:'gzip-json-v1'});
    console.log(JSON.stringify({output,products:scan.products.length,bytes:bytes.length}));return;
  }
  if(command==='inventory'){
    if(!args.remote)throw new Error('Authoritative inventory export is a future cloud step; supply remote gates after quota reset');
    const db=cloud('MEAL_DATABASE_ID',true);const inventory=await loadCloudRequirements(db);
    const output=args.output??'data/retailer-inventory.json';save(output,inventory);console.log(JSON.stringify({output:resolve(output),datasetId:inventory.datasetId,ingredients:inventory.requirements.length,rowsRead:db.rowsRead}));return;
  }
  if(command==='review'){
    if(args.remote||args['allow-live'])throw new Error('Review preparation is offline');
    if(!args.input||!args.inventory)throw new Error('Supply --input scan.json --inventory saved-cloud-inventory.json');
    const scan=read(args.input),inventory=read(args.inventory);
    const batches=prepareReviewBatches(inventory,scan.products,retailer(),scan.scope);
    const output=args.output??`data/${retailer()}-review-batches.json`;save(output,batches);console.log(JSON.stringify({output:resolve(output),batches:batches.length}));return;
  }
  if(command==='publish'){
    if(!args.input||!args.inventory)throw new Error('Supply --input reviewed-dataset.json --inventory saved-cloud-inventory.json');
    const data=read(args.input) as RetailDataset & {sourceMarker?:string; nominations?:ManualReviewNominations|null;
      catalogueHash?:string; nominationsHash?:string|null};const id=retailer();
    if(data.retailer!==id)throw new Error('Dataset retailer mismatch');
    if(args.remote&&(data.sourceMarker||data.datasetId.startsWith('demo-')))throw new Error('Synthetic fixtures cannot be published to Cloudflare');
    const trackedIds=[...new Set(data.connections.flatMap(c=>c.approvedProducts.map(p=>p.productId)))];
    const inventory=read(args.inventory);
    if(data.datasetId!==inventory.datasetId||data.inventoryHash!==inventory.hash)throw new Error('Dataset does not match authoritative cloud inventory');
    const categoryMap=id==='coop'?(()=>{
      const tree=read(args.categories??'data/coop-category-tree-20261009.json');
      if(tree.retailer!==id||scopeKey(id,tree.scope)!==scopeKey(id,data.scope))throw new Error('Review category tree differs from the dataset scope');
      return coopReviewCategoryMap(Object.entries(tree.byId as Record<string,string[]>).map(([categoryId,paths])=>({
        categoryId,name:paths.join(' > '),
      })));
    })():undefined;
    validateReviewedInventory(inventory,data.observations,{...data,policyVersion:inventory.dietaryPolicy?.version},id,data.scope,
      Date.now(),categoryMap,loadAssessments().records,data.nominations??null);
    const publicationObservations=args['allow-live']?await collectTracked(client(id),data.scope,trackedIds,25,
      data.observations.filter(o=>trackedIds.includes(o.product.id)))
      :data.observations.filter(o=>trackedIds.includes(o.product.id));
    const observationsById=new Map(publicationObservations.map(o=>[o.product.id,o]));
    if(!trackedIds.length||trackedIds.some(id=>!observationsById.has(id)))throw new Error('Incomplete approved product observations');
    const publishNow=Date.now();
    if(trackedIds.some(id=>{const o=observationsById.get(id)!;return Date.parse(o.checkedAt)>publishNow+60000
      ||publishNow-Date.parse(o.checkedAt)>=86400000||Date.parse(o.expiresAt)<=publishNow;}))throw new Error('Source prices expired; revalidate approved products with --allow-live before publication');
    const db=database(id);
    try{
      if(args.remote){const authoritative=await loadCloudRequirements(cloud('MEAL_DATABASE_ID',true));if(authoritative.datasetId!==data.datasetId||authoritative.hash!==data.inventoryHash)throw new Error('Recipe inventory changed; review refresh required');}
      const ids=[...new Set(data.connections.flatMap(c=>c.approvedProducts.map(p=>p.productId)))];
      const obs=publicationObservations.filter(o=>ids.includes(o.product.id));budget(db,10*data.connections.length+10*ids.length+200);
      // Remote schema is installed as a separate, reviewed migration step.
      await configureRetailDataset(db,data);const published=await publishRetailObservations(db,id,data.scope,obs,ids);
      const report={...published,...(db instanceof D1DatabaseClient?{rowsRead:db.rowsRead,rowsWritten:db.rowsWritten,sizeBytes:db.sizeBytes}:{})};
      save(args.output??`data/${id}-last-publication.json`,report);console.log(JSON.stringify(report,null,2));
    }finally{if(db instanceof LocalDatabase)db.close();}return;
  }
  if(command==='refresh'){
    live();const id=retailer(), c=client(id),s=scope();
    if(!c.capabilities.productLookup||!c.capabilities.verifiedStorePricing)throw new Error(`${id} verified store pricing is unavailable; no database queried`);
    const db=database(id);
    try{
      const meta=Object.fromEntries((await rows(db,'SELECT key,value FROM retail_meta')).map(r=>[r.key,r.value]));
      if(meta.retailer!==id||meta.reference_scope!==scopeKey(id,s))throw new Error('Reference scope differs from configured database');
      const ids=(await rows(db,'SELECT product_id FROM retail_tracked ORDER BY product_id')).map(r=>String(r.product_id));
      const prior=await readRetailObservations(db,id,s,ids);
      budget(db,10);const obs=await collectTracked(c,s,ids,25,prior);
      const published=await publishRetailObservations(db,id,s,obs,ids);
      const report={...published,...(db instanceof D1DatabaseClient?{rowsRead:db.rowsRead,rowsWritten:db.rowsWritten,sizeBytes:db.sizeBytes}:{})};
      save(args.output??`data/${id}-last-refresh.json`,report);console.log(JSON.stringify(report,null,2));
    }finally{if(db instanceof LocalDatabase)db.close();}return;
  }
  throw new Error('Commands: demo, capabilities, scan, archive, inventory, review, publish, refresh');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Retailer preparation failed');process.exitCode=1;});

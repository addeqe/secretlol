import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerObservationCache } from '../worker/retailers.ts';
import { LocalProductResolver } from '../src/retailers/resolver.ts';
import { productIdentity, type ReviewedConnection } from '../src/retailers/identity.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import type { ProductObservation, RetailClient } from '../src/retailers/types.ts';

function observation(id:string):ProductObservation{
  const now=Date.now();return {retailer:'coop',scope:{storeId:'store-1',channel:'pickup'},storeScopeVerified:true,
    product:{id,ean:null,name:'Rice',brand:null,categories:[],ingredientsText:'Rice',pack:{quantity:1000,unit:'g',approximate:false}},
    price:{amountOre:1000,basis:'pack',depositOre:0,memberOnly:false,minimumQuantity:null,validFrom:null,validUntil:null},
    availability:'available',checkedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+3600000).toISOString()};
}
test('shared cache bundles 400 prices into one short key and separates lookup scopes',async()=>{
  const saved=(globalThis as any).caches,values=new Map<string,Response>();let reads=0,writes=0;
  (globalThis as any).caches={default:{async match(request:Request){reads++;return values.get(request.url)?.clone();},
    async put(request:Request,response:Response){writes++;assert.ok(request.url.length<200);values.set(request.url,response.clone());}}};
  try{
    const cache=new WorkerObservationCache(),entries=new Map(Array.from({length:400},(_,i)=>[`store-1:${i}`,observation(`rice-${i}`)]));
    await cache.setMany(entries);assert.equal(writes,1);
    const cold=new WorkerObservationCache();assert.equal((await cold.getMany([...entries.keys()])).size,400);assert.equal(reads,1);
    await cold.getMany([...entries.keys()]);assert.equal(reads,1,'same-isolate reads use memory');
    assert.equal((await cold.getMany(['store-2:1'])).size,0);assert.equal(reads,2);
  }finally{(globalThis as any).caches=saved;}
});
test('a corrupt cached observation is refetched rather than treated as a usable price',async()=>{
  const o=observation('rice'),scope=o.scope;let calls=0;
  const c:ReviewedConnection={ingredientId:'rice',name:'rice',foodId:'rice',status:'matched',mainProductId:'rice',
    approvedProducts:[{productId:'rice',identity:productIdentity(o.product)}],policyVersion:DIETARY_POLICY_VERSION,reviewedAt:o.checkedAt,reason:'Reviewed fixture'};
  const client:RetailClient={retailer:'coop',capabilities:{stores:false,categories:false,browse:false,productLookup:true,batchLookup:true,verifiedStorePricing:true,notes:[]},
    async stores(){return[];},async categories(){return[];},async browse(){throw new Error('unexpected');},async products(){calls++;return[o];}};
  const resolver=new LocalProductResolver(client,{async get(){return {...o,price:{...o.price!,amountOre:-1}};},async set(){}});
  const result=await resolver.resolve(scope,[c]);assert.equal(calls,1);assert.equal(result.eligible.get('rice')?.length,1);
});

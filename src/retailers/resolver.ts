import type { ReviewedConnection } from './identity.ts';
import { approvedObservations, validateObservation } from './identity.ts';
import { scopeKey, validateScope } from './types.ts';
import type { ProductObservation, RetailClient, StoreScope } from './types.ts';
export interface ObservationCache { get(key:string):Promise<ProductObservation|null>; set(key:string,value:ProductObservation):Promise<void>;
  getMany?(keys:string[]):Promise<Map<string,ProductObservation>>;setMany?(values:Map<string,ProductObservation>):Promise<void> }
export class MemoryObservationCache implements ObservationCache {
  readonly entries=new Map<string,ProductObservation>();
  async get(key:string){const o=this.entries.get(key);return o&&Date.parse(o.expiresAt)>Date.now()?o:null;}
  async set(key:string,value:ProductObservation){if(this.entries.size>=1000)this.entries.delete(this.entries.keys().next().value!);this.entries.set(key,value);}
}
export class LocalProductResolver {
  readonly client:RetailClient;readonly cache:ObservationCache;private pending=new Map<string,Promise<ProductObservation[]>>();
  constructor(client:RetailClient,cache:ObservationCache){this.client=client;this.cache=cache;}
  async resolve(scope:StoreScope,connections:ReviewedConnection[],now=Date.now()){
    validateScope(scope);
    const idSet=new Set<string>();
    for(const connection of connections)for(const product of connection.approvedProducts)idSet.add(product.productId);
    const ids=[...idSet].sort();
    if(ids.length>400)throw new Error('local_lookup_product_budget');
    const encodedScope=scopeKey(this.client.retailer,scope);
    const keys=ids.map(id=>JSON.stringify([encodedScope,id]));
    const observations:ProductObservation[]=[],missing:string[]=[];
    const bundled=this.cache.getMany?await this.cache.getMany(keys):null;
    for(let i=0;i<ids.length;i++){const id=ids[i]!,key=keys[i]!;const o=bundled?bundled.get(key):await this.cache.get(key);
      if(o){try{validateObservation(o,this.client.retailer,scope);}catch{missing.push(id);continue;}}
      if(o&&o.product.id===id&&Date.parse(o.expiresAt)>now&&Date.parse(o.checkedAt)<=now+60000&&now-Date.parse(o.checkedAt)<1800000)observations.push(o);else missing.push(id);}
    if(missing.length){
      if(!this.client.capabilities.verifiedStorePricing)throw new Error(`${this.client.retailer}_local_prices_not_verified`);
      const groups=[];for(let i=0;i<missing.length;i+=(this.client.capabilities.batchLookup?25:1))groups.push(missing.slice(i,i+(this.client.capabilities.batchLookup?25:1)));
      if(groups.length>40)throw new Error('local_lookup_requires_chunks');
      for(const group of groups){
        const key=JSON.stringify([encodedScope,group]);let call=this.pending.get(key);
        if(!call){call=this.client.products(scope,group);this.pending.set(key,call);}
        let found:ProductObservation[];try{found=await call;}finally{if(this.pending.get(key)===call)this.pending.delete(key);}
        if(found.length!==group.length||new Set(found.map(o=>o.product.id)).size!==group.length||found.some(o=>!group.includes(o.product.id)))throw new Error('incomplete_local_lookup');
        for(const o of found){
          validateObservation(o,this.client.retailer,scope);
          if(scopeKey(this.client.retailer,o.scope)!==scopeKey(this.client.retailer,scope)||o.retailer!==this.client.retailer||!o.storeScopeVerified)throw new Error('local_product_scope_mismatch');
          const expiry=Math.min(Date.parse(o.expiresAt),Date.parse(o.checkedAt)+1800000,
            o.price?.validUntil?Date.parse(o.price.validUntil):Infinity);
          if(!Number.isFinite(expiry)||expiry<=now||Date.parse(o.checkedAt)>now+60000)throw new Error('invalid_local_observation');
          const cached={...o,expiresAt:new Date(expiry).toISOString()};if(!this.cache.setMany)await this.cache.set(JSON.stringify([encodedScope,o.product.id]),cached);observations.push(cached);
        }
      }
      if(this.cache.setMany)await this.cache.setMany(new Map(observations.map(o=>[JSON.stringify([encodedScope,o.product.id]),o])));
    }
    // Each review can approve at most three IDs. Restrict the validator's input to
    // those observations while retaining their catalogue order and all policy checks.
    const observationsById=new Map<string,ProductObservation[]>(),observationIndexes=new Map<ProductObservation,number>();
    for(let i=0;i<observations.length;i++){const observation=observations[i]!;observationIndexes.set(observation,i);const list=observationsById.get(observation.product.id);if(list)list.push(observation);else observationsById.set(observation.product.id,[observation]);}
    const eligible=new Map<string,ProductObservation[]>();
    for(const connection of connections){
      const candidates:ProductObservation[]=[];
      const approvedIds=new Set(connection.approvedProducts.map(product=>product.productId));
      for(const productId of approvedIds){const found=observationsById.get(productId);if(found)candidates.push(...found);}
      candidates.sort((a,b)=>observationIndexes.get(a)!-observationIndexes.get(b)!);
      eligible.set(connection.ingredientId,approvedObservations(connection,candidates,this.client.retailer,scope,now));
    }
    return {observations,eligible};
  }
}

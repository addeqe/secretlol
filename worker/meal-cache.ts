/** Isolate-local cache for immutable/versioned meal availability results. */
type Availability={broken:string[];expiresAt:number};
export type AvailabilityRow={ingredient_name:string;status:string;code:string|null;observed_at?:string|null;data_json:string|null};
const availability=new Map<string,Availability>();
const keyOf=(dataset:string,store:string,snapshot:string,run:string,policy:string)=>JSON.stringify([dataset,store,snapshot,run,policy]);
let bindingIds=new WeakMap<object,number>();
const immutable=new Map<string,{value:string;bytes:number}>();
let nextBindingId=1,immutableBytes=0;
const MAX_IMMUTABLE_ENTRIES=64,MAX_IMMUTABLE_BYTES=4*1024*1024;

export function mealImmutableCacheKey(binding:object,dataset:string,kind:string,id=''){
  let bindingId=bindingIds.get(binding);if(bindingId===undefined){bindingId=nextBindingId++;bindingIds.set(binding,bindingId);}
  return JSON.stringify([bindingId,dataset,kind,id]);
}
export function getMealImmutable(binding:object,dataset:string,kind:string,id=''){
  const key=mealImmutableCacheKey(binding,dataset,kind,id),cached=immutable.get(key);
  if(!cached)return null;
  immutable.delete(key);immutable.set(key,cached);return cached.value;
}
export function setMealImmutable(binding:object,dataset:string,kind:string,id:string,value:string){
  const bytes=value.length*2;if(bytes>MAX_IMMUTABLE_BYTES)return;
  const key=mealImmutableCacheKey(binding,dataset,kind,id),prior=immutable.get(key);
  if(prior){immutableBytes-=prior.bytes;immutable.delete(key);}
  immutable.set(key,{value,bytes});immutableBytes+=bytes;
  while(immutable.size>MAX_IMMUTABLE_ENTRIES||immutableBytes>MAX_IMMUTABLE_BYTES){const oldest=immutable.keys().next().value!;immutableBytes-=immutable.get(oldest)!.bytes;immutable.delete(oldest);}
}

export function mealAvailabilityCacheKey(dataset:string,store:string,snapshot:string,run:string,policy:string){
  return keyOf(dataset,store,snapshot,run,policy);
}

export function getMealAvailability(key:string,now=Date.now()):string[]|null{
  const cached=availability.get(key);
  if(!cached)return null;
  if(now>=cached.expiresAt){availability.delete(key);return null;}
  return cached.broken;
}

export function setMealAvailability(key:string,broken:string[],expiresAt:number){
  if(availability.size>=8&&!availability.has(key))availability.delete(availability.keys().next().value!);
  availability.set(key,{broken,expiresAt});
}

/** Apply the same predicates as the former SQL scan and find its next time boundary. */
export function calculateMealAvailability(rows:AvailabilityRow[],now:number){
  const broken=new Set<string>();let nextChange=Infinity;
  for(const row of rows){
    if(row.status!=='matched'&&row.status!=='non_purchased'){broken.add(row.ingredient_name);continue;}
    if(row.status!=='matched')continue;
    if(!row.code||!row.data_json){broken.add(row.ingredient_name);continue;}
    const data=JSON.parse(row.data_json),observed=Date.parse(row.observed_at??data.observedAt);
    if((data.available!==true&&data.available!==1)||!Number.isFinite(observed)){broken.add(row.ingredient_name);continue;}
    const staleAt=observed+86400000,futureUntil=observed-60000;
    if(staleAt>now)nextChange=Math.min(nextChange,staleAt);else broken.add(row.ingredient_name);
    if(futureUntil>now){nextChange=Math.min(nextChange,futureUntil);broken.add(row.ingredient_name);}
    const observedSecond=Math.floor(observed/1000)*1000;
    for(const offer of data.offers??[]){const expiry=offer?.validUntil;if(typeof expiry==='number'&&expiry>observedSecond){if(expiry<=now)broken.add(row.ingredient_name);else nextChange=Math.min(nextChange,expiry);}}
  }
  return {broken:[...broken],expiresAt:nextChange};
}

/** Exposed for deterministic tests and version invalidation. */
export function resetMealAvailabilityCache(){availability.clear();}
export function resetMealImmutableCache(){immutable.clear();immutableBytes=0;bindingIds=new WeakMap();nextBindingId=1;}

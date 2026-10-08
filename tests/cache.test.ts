import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMealAvailability,getMealAvailability,getMealImmutable,mealAvailabilityCacheKey,mealImmutableCacheKey,resetMealAvailabilityCache,resetMealImmutableCache,setMealAvailability,setMealImmutable} from '../worker/meal-cache.ts';
import {mealSearchPhrase} from '../src/meal-search.ts';

test('availability calculation preserves strict status and freshness predicates',()=>{
  const now=1_800_000_000_000,observed=new Date(now-10_000).toISOString();
  const row=(ingredient_name:string,status:string,code:string|null,at:string|null,data:unknown)=>({ingredient_name,status,code,observed_at:at,data_json:data===null?null:JSON.stringify(data)});
  const result=calculateMealAvailability([
    row('fresh','matched','A',observed,{available:true,offers:[]}),
    row('not purchased','non_purchased',null,null,null),
    row('review','needs_review',null,null,null),
    row('missing','matched','M',null,null),
    row('unavailable','matched','U',observed,{available:false}),
    row('stale','matched','S',new Date(now-86_400_001).toISOString(),{available:true}),
    row('future','matched','F',new Date(now+60_001).toISOString(),{available:true}),
  ],now);
  assert.deepEqual(new Set(result.broken),new Set(['review','missing','unavailable','stale','future']));
  assert.equal(result.expiresAt,now+1);
});

test('availability cache expires exactly at offer and freshness boundaries',()=>{
  const now=1_800_000_000_000,observed=new Date(now-10_000).toISOString(),expiry=now+500;
  const offer=calculateMealAvailability([{ingredient_name:'eggs',status:'matched',code:'A',observed_at:observed,data_json:JSON.stringify({available:true,offers:[{validUntil:expiry}]})}],now);
  assert.deepEqual(offer.broken,[]);assert.equal(offer.expiresAt,expiry);
  assert.deepEqual(calculateMealAvailability([{ingredient_name:'eggs',status:'matched',code:'A',observed_at:observed,data_json:JSON.stringify({available:true,offers:[{validUntil:expiry}]})}],expiry).broken,['eggs']);
  const freshness=calculateMealAvailability([{ingredient_name:'eggs',status:'matched',code:'A',observed_at:new Date(now-86_400_000+10).toISOString(),data_json:'{"available":true}'}],now);
  assert.equal(freshness.expiresAt,now+10);
  assert.deepEqual(calculateMealAvailability([{ingredient_name:'eggs',status:'matched',code:'A',observed_at:new Date(now-86_400_000+10).toISOString(),data_json:'{"available":true}'}],now+10).broken,['eggs']);
});

test('cache rechecks Date.now, separates dataset/store/snapshot/run/policy, and stays bounded',()=>{
  resetMealAvailabilityCache();
  const key=mealAvailabilityCacheKey('d','s','c','r','p');
  setMealAvailability(key,['eggs'],100);
  assert.deepEqual(getMealAvailability(key,99),['eggs']);
  assert.equal(getMealAvailability(key,100),null);
  setMealAvailability(key,['eggs'],Infinity);
  assert.equal(getMealAvailability(mealAvailabilityCacheKey('d','other-store','c','r','p'),99),null);
  assert.equal(getMealAvailability(mealAvailabilityCacheKey('d','s','other-snapshot','r','p'),99),null);
  assert.equal(getMealAvailability(mealAvailabilityCacheKey('d','s','c','other-run','p'),99),null);
  assert.equal(getMealAvailability(mealAvailabilityCacheKey('d','s','c','r','other-policy'),99),null);
  for(let i=0;i<8;i++)setMealAvailability(`other-${i}`,[],Infinity);
  assert.equal(getMealAvailability(key,99),null);
  resetMealAvailabilityCache();
});

test('immutable cache is binding and dataset scoped, bounded, and FTS phrases preserve operators literally',()=>{
  resetMealImmutableCache();const bindingA={},bindingB={};
  setMealImmutable(bindingA,'d','recipe','1','immutable doc');
  assert.equal(getMealImmutable(bindingA,'d','recipe','1'),'immutable doc');
  assert.equal(getMealImmutable(bindingB,'d','recipe','1'),null);
  assert.equal(getMealImmutable(bindingA,'new-dataset','recipe','1'),null);
  assert.notEqual(mealImmutableCacheKey(bindingA,'d','recipe','1'),mealImmutableCacheKey(bindingB,'d','recipe','1'));
  for(let i=0;i<70;i++)setMealImmutable(bindingA,'d','recipe',String(i),'x');
  assert.equal(getMealImmutable(bindingA,'d','recipe','1'),null);
  assert.equal(mealSearchPhrase('C++ "vegan"'), '"C++ ""vegan"""');
  resetMealImmutableCache();
});

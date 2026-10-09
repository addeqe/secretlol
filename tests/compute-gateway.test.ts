import test from 'node:test';
import assert from 'node:assert/strict';
import {handle,type Env} from '../worker/index.ts';
import {MealCompute} from '../worker/meal-compute.ts';
import {COMPUTE_SHARDS,computeShard} from '../worker/compute-shard.ts';

const token='test-compute-gateway-token-with-at-least-32-characters';
test('gateway rejects unauthorized requests before compute or database access and streams authorized bodies unchanged',async()=>{
  let calls=0,body:string|null=null;
  const namespace={idFromName(name:string){assert.match(name,/^meal-compute-v1-\d+$/);return name;},get(){return{async fetch(request:Request){calls++;body=await request.text();return new Response('streamed-result',{headers:{'Content-Type':'application/json'}});}};}};
  const env={CATALOG_API_TOKEN:token,DB:{prepare(){throw new Error('gateway must not access D1');}},MEAL_COMPUTE:namespace} as unknown as Env;
  const denied=await handle(new Request('https://api.test/meal/quote',{method:'POST',body:'not json'}),env);
  assert.equal(denied.status,401);assert.equal(calls,0);
  const raw=' { "retailer" : "coop", "recipes": [{"recipeId":25493}] } '+ ' '.repeat(10000);
  const response=await handle(new Request('https://api.test/meal/quote',{method:'POST',body:raw,headers:{Authorization:`Bearer ${token}`}}),env);
  assert.equal(await response.text(),'streamed-result');assert.equal(body,raw);assert.equal(calls,1);
  const review=await handle(new Request('https://api.test/ingredients/review',{method:'POST',headers:{Authorization:`Bearer ${token}`}}),{...env,INGREDIENT_REVIEW_TOKEN:'separate-review-token-with-at-least-32-characters'});
  assert.equal(review.status,401);assert.equal(calls,1);
});

test('compute object preserves authentication, errors and responses without touching object storage',async()=>{
  const state=new Proxy({}, {get(){throw new Error('compute must not touch Durable Object storage or timers');}}) as DurableObjectState;
  const object=new MealCompute(state,{CATALOG_API_TOKEN:token} as Env);
  assert.ok(object.env.COMPUTE_QUOTE_CACHE);
  assert.strictEqual(new MealCompute(state,object.env).env.COMPUTE_QUOTE_CACHE,object.env.COMPUTE_QUOTE_CACHE,
    'compute objects sharing an isolate must share the bounded cache');
  const response=await object.fetch(new Request('https://api.test/meal/status',{headers:{Authorization:`Bearer ${token}`}}));
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'meal_database_not_connected'});
  const denied=await object.fetch(new Request('https://api.test/meal/status'));
  assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{error:'unauthorized'});
});

test('compute shard pool stays fixed and keeps identical bodies together across request identities',async()=>{
  const names=new Set<string>();
  for(let index=0;index<2000;index++){
    const request=new Request(`https://api.test/meal/recipes/${index}`,{headers:{'cf-ray':`${index.toString(16)}-ARN`}});
    const name=await computeShard(request);assert.equal(await computeShard(request),name);names.add(name);
  }
  assert.equal(names.size,COMPUTE_SHARDS);
  const a=new Request('https://api.test/meal/quote',{method:'POST',body:'{"recipeId":25493}',headers:{'cf-ray':'one-ARN'}});
  const b=new Request(a.url,{method:a.method,body:'{"recipeId":25493}',headers:{'cf-ray':'another-CPH'}});
  assert.equal(await computeShard(a),await computeShard(b));
  assert.equal(await a.text(),'{"recipeId":25493}');
  assert.equal(await b.text(),'{"recipeId":25493}');
});

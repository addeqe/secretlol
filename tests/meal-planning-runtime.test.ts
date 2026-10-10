import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LocalDatabase,rows} from '../src/database.ts';
import type {Statement,Entry,Scan} from '../src/types.ts';
import {digest,mealSchema,prepareCommon,loadCloudRequirements,uploadPart} from '../src/meal-import.ts';
import type {MealRecord,MealManifest} from '../src/meal-import.ts';
import {DIETARY_POLICY} from '../src/dietary-policy.ts';
import worker,{handle} from '../worker/index.ts';
import {publish} from '../src/publish.ts';
import {refreshIngredientLinks} from '../src/ingredient-publish.ts';
import {catalogStorageSchema} from '../src/catalog-storage.ts';
import {ingredientStorageSchema} from '../src/ingredient-storage.ts';
import {resetMealAvailabilityCache,resetMealImmutableCache} from '../worker/meal-cache.ts';
import {normalize} from '../src/products.ts';

const readToken='private-read-test-token-longer-than-32-characters';
const bindingCache=new WeakMap<LocalDatabase,D1Database>(),metrics=new WeakMap<LocalDatabase,{recipe:number;chunks:number}>();
function binding(db:LocalDatabase){const prior=bindingCache.get(db);if(prior)return prior;function prepare(sql:string){let params:Statement['params']=[];const s={sql,get params(){return params},bind(...p:NonNullable<Statement['params']>){params=p;return s},note(){const m=metrics.get(db);if(!m)return;const q=sql.toLowerCase();if(q.includes('from meal_recipes'))m.recipe++;if(q.includes('from meal_enrichment_chunks'))m.chunks++;},async first(){s.note();return(await rows(db,sql,params))[0]??null},async all(){s.note();return{results:await rows(db,sql,params),success:true}}};return s;}const value={prepare,batch:async(ss:ReturnType<typeof prepare>[])=>db.batch(ss.map(s=>({sql:s.sql,params:s.params})))} as unknown as D1Database;bindingCache.set(db,value);return value;}

const definitions=[
 {filter_id:1,domain:'diet',key:'vegetarian',label_sv:'Vegetarisk',label_en:'Vegetarian'},
 {filter_id:2,domain:'allergen',key:'gluten_cereals',label_sv:'Glutenhaltiga spannmål',label_en:'Gluten-containing cereals'},
 {filter_id:3,domain:'cuisine',key:'mexican',label_sv:'Mexikanskt',label_en:'Mexican'},
 {filter_id:4,domain:'cuisine',key:'thai',label_sv:'Thailändskt',label_en:'Thai'},
 {filter_id:5,domain:'cuisine_region',key:'scandinavian',label_sv:'Skandinavien',label_en:'Scandinavian'},
];
const nutrients=(protein:number,fiber:number)=>({Calories:400,FatContent:10,SaturatedFatContent:2,CholesterolContent:0,Sodium:100,SodiumContent:100,CarbohydrateContent:40,FiberContent:fiber,SugarContent:4,ProteinContent:protein});
const states=[
 {diet:'yes',gluten:'no',cuisine:'mexican',region:'no',protein:10,fiber:2},
 {diet:'yes',gluten:'unknown',cuisine:'mexican',region:'yes',protein:80,fiber:30},
 {diet:'unknown',gluten:'no',cuisine:'thai',region:'yes',protein:70,fiber:22},
 {diet:'yes',gluten:'no',cuisine:'thai',region:'yes',protein:60,fiber:20},
 {diet:'yes',gluten:'no',cuisine:'mexican',region:'yes',protein:50,fiber:18},
];
const sets:Record<string,number[]>={};
for(const [index,recipe] of states.entries()){const id=index+1;for(const [filterId,state] of [[1,recipe.diet],[2,recipe.gluten],[3,recipe.cuisine==='mexican'?'yes':'no'],[4,recipe.cuisine==='thai'?'yes':'no'],[5,recipe.region]] as const){const key=`${filterId}:${state}`;(sets[key]??=[]).push(id);}}
function fixtures(){
 const requirements=[{name:'eggs',occurrences:5},{name:'water',occurrences:5}],inventory={hash:digest(JSON.stringify(requirements)),requirements,ingredientOccurrences:10,recipes:5,dietaryPolicy:DIETARY_POLICY};
 const common={inventory,definitions,metadata:{fixture:true},classificationRuns:[],sourceCounts:{recipes:5,ingredients:10,reviews:5},subjects:requirements.map(r=>({...r,filters:[{filter_id:2,state:'no'}]})),sets};
 const records:Array<MealRecord>=states.map((_,n)=>{const id=n+1,document=JSON.stringify({source:{RecipeId:String(id),Name:`Recipe ${id}`,RecipeServings:null,RecipeYield:'three servings'},ingredients:[{ingredient_index:0,ingredient_original:'eggs',unit:'count',measured_quantity:'3'},{ingredient_index:1,ingredient_original:'water',unit:'cup',measured_quantity:'1'}],quality:{state:'consistent'},filters:[{filter_id:1,state:'yes'}],profile:{nutrition_metrics:{nutrients_per_serving:nutrients(20,5)}},reviews:[]}),summary=JSON.stringify({id,name:`Recipe ${id}`});return{id,name:`Recipe ${id}`,names:JSON.stringify(['eggs','water']),document,summary,hash:digest(document)};});
 const parts=records.map((r,i)=>({day:i+1,recipes:1,firstId:r.id,lastId:r.id,file:`day-${i+1}.gz`,sha256:digest(`part${i}`),bytes:1,uncompressedBytes:1,maxEstimatedWrites:100}));
 const m={schemaVersion:1,datasetId:'c'.repeat(64),sourceSha256:'c'.repeat(64),recipes:5,ingredientOccurrences:10,distinctIngredients:2,reviews:0,inventoryHash:inventory.hash,filterSets:Object.keys(sets).length,parts,common:{file:'common.gz',sha256:'b'.repeat(64),bytes:1,uncompressedBytes:1},releaseTag:'fixture',repository:'test/repo',sourceCounts:common.sourceCounts} as MealManifest;
 return{m,common,records};
}
function setup(){resetMealAvailabilityCache();resetMealImmutableCache();const meal=new LocalDatabase(':memory:'),catalog=new LocalDatabase(':memory:');metrics.set(meal,{recipe:0,chunks:0});meal.execute(mealSchema());meal.execute(readFileSync(new URL('../meal-migrations/0004_meal_enrichment.sql',import.meta.url),'utf8'));for(const name of ['0001_catalog.sql','0002_ingredients.sql'])catalog.execute(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));catalog.execute(catalogStorageSchema());catalog.execute(ingredientStorageSchema());return{meal,catalog,reads:metrics.get(meal)!,...fixtures()};}
async function complete(s:ReturnType<typeof setup>){await prepareCommon(s.meal,s.m,JSON.stringify(s.common));for(let i=0;i<5;i++)await uploadPart(s.meal,s.m,s.m.parts[i],[s.records[i]],`2026-10-0${i+1}T00:00:00Z`);}
const revision='recipe-filters-3';
async function enrich(s:ReturnType<typeof setup>,rev=revision){const recipePatches=Object.fromEntries(states.map((state,index)=>{const id=index+1;return[String(id),{filters:[{filter_id:1,state:state.diet},{filter_id:2,state:state.gluten},{filter_id:3,state:state.cuisine==='mexican'?'yes':'no'},{filter_id:4,state:state.cuisine==='thai'?'yes':'no'},{filter_id:5,state:state.region}],source:{RecipeServings:3,RecipeServingsRecoveryProvenance:'RecipeYield:three servings'},profile:{nutrition_metrics:{nutrients_per_serving:nutrients(state.protein,state.fiber)}}}]}));const vectors=states.map((state,index)=>[index+1,3,400,10,2,0,100,40,state.fiber,4,state.protein,2,[0,1],`Recipe ${index+1}`]);const manifest={revision:rev,baseDatasetId:s.m.datasetId,recipes:5,chunkWidth:1024,recipeChunks:[0],ingredientChunks:{eggs:0,water:0},setChunks:Object.fromEntries(Object.keys(sets).map(key=>[key,0])),planningChunks:[0],ingredientNames:['eggs','water'],definitions,coverage:{recipes:5}};const write=async(kind:string,document:unknown)=>{const json=JSON.stringify(document);await s.meal.query('INSERT OR REPLACE INTO meal_enrichment_chunks VALUES(?,?,?,?,?,?)',[s.m.datasetId,rev,kind,0,json,digest(json)]);};await write('recipes',recipePatches);await write('sets',sets);await write('planning',vectors);await write('ingredients',{eggs:{filters:[{domain:'allergen',key:'gluten_cereals',state:'unknown'}]},water:{filters:[]}});const stored={...s.m,enrichment:manifest};await s.meal.query("UPDATE meal_meta SET value=? WHERE key='manifest'",[JSON.stringify(stored)]);await s.meal.query("INSERT INTO meal_meta VALUES('enrichment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(manifest)]);}
const tokenRequest=(path:string,body?:any,secret=readToken)=>new Request('https://example.test'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const environment=(s:ReturnType<typeof setup>)=>({DB:binding(s.catalog),MEAL_DB:binding(s.meal),CATALOG_API_TOKEN:readToken});
const egg=(available=true,code='EGG_A')=>normalize({code,name:'Ägg 6p Frigående Medium',priceValue:18,priceUnit:'kr/st',displayVolume:'6p',online:true,outOfStock:!available,addToCartDisabled:!available,potentialPromotions:[]},'Mejeri, ost & ägg',new Date().toISOString());
async function link(s:ReturnType<typeof setup>,available=true,code='EGG_A'){const scan:Scan={entries:[egg(available,code)],store:{storeId:'2110',name:'Test',onlineStore:true},categories:[],requests:0,startedAt:new Date().toISOString(),completedAt:new Date().toISOString()};await publish(s.catalog,scan);await refreshIngredientLinks(s.catalog,await loadCloudRequirements(s.meal));}
const profile={version:1,calories:2000,targets:{protein:{min:60},fiber:{min:20}},trackedNutrients:['calories','protein','fiber']};
const searchPath=(extra='')=>`/meal/recipes?limit=1&availableOnly=false&candidateProfile=${encodeURIComponent(JSON.stringify(profile))}${extra}`;

test('enrichment filters strictly, ranks the complete eligible corpus before paging and hydrates coherent nutrition/servings',async()=>{const s=setup();try{await complete(s);await enrich(s);await link(s);const call=async(path:string,body?:any)=>(await handle(tokenRequest(path,body),environment(s)));const definitionsResponse=await(await call('/meal/filters')).json() as any;assert.equal(definitionsResponse.profileRevision,revision);assert.ok(definitionsResponse.definitions.some((d:any)=>d.domain==='allergen'&&d.key==='gluten_cereals'));
 const q=`&diet=vegetarian&excludeAllergen=gluten_cereals&cuisine=mexican,thai&region=scandinavian`;const strict=await(await call(searchPath(q))).json() as any;assert.deepEqual(strict.recipes.map((r:any)=>r.id),[4]);assert.equal(strict.diagnostics.strategy,'nutrient-density-v1');assert.equal(strict.diagnostics.eligibleCount,2);const unknown=await(await call(searchPath('&diet=vegetarian&excludeAllergen=gluten_cereals').replace('limit=1','limit=100'))).json() as any;assert.deepEqual(unknown.recipes.map((r:any)=>r.id),[4,5,1]);
 for(const invalid of [{...profile,trackedNutrients:['constructor']},{...profile,targets:{toString:{min:1}}}]){const path=`/meal/recipes?availableOnly=false&candidateProfile=${encodeURIComponent(JSON.stringify(invalid))}`;assert.equal((await worker.fetch(tokenRequest(path),environment(s))).status,400,'prototype properties are not valid nutrient keys');}
 const ranked=await(await call(searchPath('&diet=vegetarian&excludeAllergen=gluten_cereals'))).json() as any;assert.equal(ranked.recipes[0].id,4,'a later high-protein/high-fiber recipe should beat low-ID recipes before page 1');assert.equal(ranked.profileRevision,revision);assert.equal(ranked.diagnostics.eligibleCount,3);assert.deepEqual(ranked.diagnostics.rankedBy,['protein','fiber']);
 const detail=await(await call('/meal/recipes/4')).json() as any;assert.equal(detail.profileRevision,revision);assert.equal(detail.source.RecipeServings,3);assert.deepEqual(detail.profile.nutrition_metrics.nutrients_per_serving,ranked.recipes[0].nutrientsPerServing);assert.equal(ranked.recipes[0].servings,detail.source.RecipeServings);
 const quote=await(await call('/meal/quote',{recipes:[{recipeId:4,servings:6}]})).json() as any;assert.equal(quote.profileRevision,revision);assert.equal(quote.recipes[0].sourceServings,detail.source.RecipeServings);assert.equal(quote.recipes[0].requestedServings,6);assert.equal(quote.recipes[0].scale,2);assert.deepEqual(quote.recipes[0].nutritionPerServing,ranked.recipes[0].nutrientsPerServing);
 }finally{s.meal.close();s.catalog.close();}});

test('profile revision and live availability versions invalidate pinned cursors while enrichment reads stay bounded',async()=>{const s=setup();try{await complete(s);await enrich(s);await link(s);const env=environment(s),call=async(path:string)=>(await handle(tokenRequest(path),env));const page=await(await call(searchPath())).json() as any;assert.ok(page.nextCursor);const initialChunks=s.reads.chunks,initialRecipeRows=s.reads.recipe;assert.ok(initialChunks<=3,`expected one planning, one recipe and at most one filter chunk read; got ${initialChunks}`);assert.ok(initialRecipeRows<=2,`paged summaries should be fetched with bounded reads; got ${initialRecipeRows}`);await call(searchPath('&cursor='+encodeURIComponent(page.nextCursor)));assert.equal(s.reads.chunks,initialChunks,'immutable enrichment chunks are reused');
 const nextRevision='recipe-filters-4';await enrich(s,nextRevision);assert.equal((await(await call('/meal/status')).json() as any).profileRevision,nextRevision);assert.equal((await call(searchPath('&cursor='+encodeURIComponent(page.nextCursor)))).status,409);
 }finally{s.meal.close();s.catalog.close();}
 const s2=setup();try{await complete(s2);await enrich(s2);await link(s2,true,'EGG_A');const env=environment(s2),call=async(path:string)=>(await handle(tokenRequest(path),env));const first=await(await call(searchPath().replace('availableOnly=false','availableOnly=true'))).json() as any;assert.ok(first.nextCursor);await link(s2,false,'EGG_A');const stale=searchPath().replace('availableOnly=false','availableOnly=true')+'&cursor='+encodeURIComponent(first.nextCursor);assert.equal((await call(stale)).status,409,'a new availability run invalidates the cursor even when the candidate IDs are unchanged');
 }finally{s2.meal.close();s2.catalog.close();}});

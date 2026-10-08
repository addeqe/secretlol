import {ingredientPolicy,productPolicy,DIETARY_POLICY_VERSION} from '../src/dietary-policy.ts';
import {packInfo} from '../src/product-pack.ts';
import {calculateLine,aggregateShopping,conversionPolicy} from '../src/meal-cost.ts';
import type {AmountOverride,CostProduct,IngredientAmount} from '../src/meal-cost.ts';
import type {Entry} from '../src/types.ts';
import {mealOpenApi} from './meal-openapi.ts';
import {mealSearchPhrase} from '../src/meal-search.ts';
import {catalogAvailabilityLookupSql,catalogProductLookupSql} from '../src/catalog-query.ts';
import {calculateMealAvailability,getMealAvailability,mealAvailabilityCacheKey,getMealImmutable,setMealAvailability,setMealImmutable} from './meal-cache.ts';
export type MealEnv={DB:D1Database;MEAL_DB?:D1Database};
type Manifest={datasetId:string;recipes:number;ingredientOccurrences:number;distinctIngredients:number;reviews:number;inventoryHash:string;repository:string;releaseTag:string;sourceSha256:string;parts?:Array<{firstId:number;lastId:number;recipes:number}>};
type Definition={filter_id:number;domain:string;key:string;label_sv:string;label_en:string;description:string};
type Run={id:string;catalogue_snapshot_id:string;inventory_hash:string;report_json:string;requirements:number};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail=(error:string,status=400,details?:unknown)=>json({error,...(details?{details}:{} )},status);
const decode=(cursor:string)=>{try{return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));}catch{throw new Error('invalid_cursor');}};
const encode=(value:unknown)=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g,'-').replace(/\//g,'_');
const list=(u:URL,k:string)=>[...new Set((u.searchParams.get(k)??'').split(',').filter(Boolean))].sort();
const positiveId=(s:unknown)=>typeof s==='number'?Number.isSafeInteger(s)&&s>0:typeof s==='string'&&/^[1-9]\d{0,9}$/.test(s);
function bounded(u:URL,key:string,fallback:number,min:number,max:number){const n=Number(u.searchParams.get(key)??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('invalid_'+key);return n;}
async function activeRun(env:MealEnv,m:Manifest){
  const snapshot=await env.DB.prepare(`SELECT s.id,s.store_id,s.completed_at FROM snapshots s WHERE s.id=(SELECT value FROM catalog_state WHERE key='active_snapshot') AND s.status='complete'`).first<{id:string;store_id:string;completed_at:string}>();
  const run=await env.DB.prepare(`SELECT * FROM ingredient_runs WHERE id=(SELECT value FROM catalog_state WHERE key='active_ingredient_run') AND status='complete'`).first<Run>();
  const current=!!snapshot&&!!run&&snapshot.id===run.catalogue_snapshot_id&&run.inventory_hash===m.inventoryHash&&run.requirements===m.distinctIngredients&&JSON.parse(run.report_json).dietaryPolicy?.version===DIETARY_POLICY_VERSION;
  return {snapshot,run,current};
}
async function quoteRecipeData(env:MealEnv,m:Manifest,ids:number[]){
  const found=new Map<number,any>(),missing:number[]=[];
  for(const id of ids){const cached=getMealImmutable(env.MEAL_DB!,m.datasetId,'quote',String(id));if(cached!==null)found.set(id,JSON.parse(cached));else missing.push(id);}
  if(missing.length){const records=await env.MEAL_DB!.prepare(`SELECT recipe_id,json_extract(document_json,'$.source.RecipeServings') AS servings,
    json_extract(document_json,'$.source.RecipeYield') AS recipe_yield,json_extract(document_json,'$.ingredients') AS ingredients_json,
    json_extract(document_json,'$.profile.nutrition_metrics') AS nutrition_json FROM meal_recipes
    WHERE dataset_id=? AND recipe_id IN (SELECT value FROM json_each(?))`).bind(m.datasetId,JSON.stringify(missing)).all<{recipe_id:number;servings:number|null;recipe_yield:string|null;ingredients_json:string;nutrition_json:string}>();
    for(const row of records.results){const value={servings:row.servings,recipe_yield:row.recipe_yield,ingredients:JSON.parse(row.ingredients_json) as IngredientAmount[],nutrition:JSON.parse(row.nutrition_json)};found.set(row.recipe_id,value);setMealImmutable(env.MEAL_DB!,m.datasetId,'quote',String(row.recipe_id),JSON.stringify(value));}}
  return found;
}
async function recipeDetail(env:MealEnv,m:Manifest,id:number){
  let value=getMealImmutable(env.MEAL_DB!,m.datasetId,'detail',String(id));if(value!==null)return value;
  value=(await env.MEAL_DB!.prepare("SELECT json_remove(document_json,'$.reviews') AS document_json FROM meal_recipes WHERE dataset_id=? AND recipe_id=?").bind(m.datasetId,id).first<{document_json:string}>())?.document_json??null;
  if(value!==null)setMealImmutable(env.MEAL_DB!,m.datasetId,'detail',String(id),value);return value;
}
async function recipeArchive(env:MealEnv,m:Manifest,id:number){
  let value=getMealImmutable(env.MEAL_DB!,m.datasetId,'archive',String(id));if(value!==null)return value;
  value=(await env.MEAL_DB!.prepare('SELECT document_json FROM meal_recipes WHERE dataset_id=? AND recipe_id=?').bind(m.datasetId,id).first<{document_json:string}>())?.document_json??null;
  if(value!==null&&value.length<=128*1024)setMealImmutable(env.MEAL_DB!,m.datasetId,'archive',String(id),value);return value;
}
async function filterDefinitions(env:MealEnv,m:Manifest){
  const cached=getMealImmutable(env.MEAL_DB!,m.datasetId,'definitions');
  if(cached!==null)return JSON.parse(cached) as Definition[];
  const row=await env.MEAL_DB!.prepare("SELECT value FROM meal_meta WHERE key='definitions'").first<{value:string}>();
  const value=row?.value??'[]';setMealImmutable(env.MEAL_DB!,m.datasetId,'definitions','',value);return JSON.parse(value) as Definition[];
}
async function lookupLive(env:MealEnv,m:Manifest,names:string[]){
  const version=await activeRun(env,m);if(!version.current)return {version,links:new Map<string,any>()};
  const records=await env.DB.prepare(`SELECT l.ingredient_name,l.status,l.selected_code,json_object('reason',json_extract(l.data_json,'$.reason'),'foodId',json_extract(l.data_json,'$.foodId'),'method',json_extract(l.data_json,'$.method')) AS data_json,
    ${catalogProductLookupSql('l.selected_code')} AS live_product
    FROM ingredient_links_read l
    WHERE l.run_id=? AND l.ingredient_name IN (SELECT value FROM json_each(?))`)
    .bind(version.snapshot!.id,version.snapshot!.id,version.run!.id,JSON.stringify(names)).all<{ingredient_name:string;status:string;selected_code:string|null;data_json:string;live_product:string|null}>();
  const links=new Map<string,any>();
  for(const row of records.results){
    const connection=JSON.parse(row.data_json),hydrated=row.live_product?JSON.parse(row.live_product) as {product:Entry|string;packLabel:string|null}:null;
    const entry=hydrated?.product?(typeof hydrated.product==='string'?JSON.parse(hydrated.product):hydrated.product) as Entry:null;
    const blocked=ingredientPolicy(row.ingredient_name).blockedReason||(entry?productPolicy(entry,row.ingredient_name):null);
    let expiresAt:string|null=null;
    if(entry){let expiry=Date.parse(entry.observedAt)+86400000;for(const offer of entry.offers as Array<{validUntil?:unknown}>){if(typeof offer.validUntil==='number'&&offer.validUntil>Date.parse(entry.observedAt))expiry=Math.min(expiry,offer.validUntil);}if(Number.isFinite(expiry))expiresAt=new Date(expiry).toISOString();}
    const product:CostProduct|null=entry&&expiresAt?{code:entry.code,name:entry.name,brand:entry.brand,priceOre:entry.priceOre,priceUnit:entry.priceUnit,depositOre:entry.depositOre,available:entry.available,observedAt:entry.observedAt,expiresAt,pack:packInfo({...entry,raw:{...entry.raw,code:entry.code,name:entry.name,displayVolume:hydrated?.packLabel}})}:null;
    const status=blocked?'excluded_by_policy':row.status;
    const fresh=!!product&&product.available&&Date.parse(product.expiresAt)>Date.now()&&Date.parse(product.observedAt)<=Date.now()+60000;
    links.set(row.ingredient_name,{name:row.ingredient_name,status,willysItemId:blocked?null:row.selected_code,product:blocked?null:product,priceFresh:fresh&&!blocked,reason:blocked??connection.reason,foodId:connection.foodId,connectionMethod:connection.method,amountConversionComplete:false});
  }
  return {version,links};
}
async function quote(request:Request,env:MealEnv,m:Manifest,body:any){
  if(!body||!Array.isArray(body.recipes)||body.recipes.length<1||body.recipes.length>32)return fail('supply_1_to_32_recipes');
  if(body.recipes.some((r:any)=>!r||!positiveId(r.recipeId)||r.servings!==undefined&&(typeof r.servings!=='number'||!Number.isFinite(r.servings)||r.servings<=0||r.servings>1000)||r.amountOverrides!==undefined&&(typeof r.amountOverrides!=='object'||r.amountOverrides===null||Array.isArray(r.amountOverrides))))return fail('invalid_recipe_selection');
  const ids:number[]=[...new Set<number>(body.recipes.map((r:any)=>Number(r.recipeId)))],documents=await quoteRecipeData(env,m,ids);
  if(documents.size!==ids.length)return fail('recipe_not_found',404,{missing:ids.filter(id=>!documents.has(id as number))});
  const names=[...new Set([...documents.values()].flatMap((r:any)=>r.ingredients.map((i:IngredientAmount)=>i.ingredient_original)))];
  if(names.length>400||body.recipes.reduce((n:number,r:any)=>n+documents.get(Number(r.recipeId))!.ingredients.length,0)>500)return fail('meal_plan_too_large');
  const live=await lookupLive(env,m,names);if(!live.version.current)return fail('connections_refresh_pending',503,{datasetId:m.datasetId});
  const recipeResults=[],allLines:Array<ReturnType<typeof calculateLine>>=[],unresolved:any[]=[];let consumed=0;
  for(let selectionIndex=0;selectionIndex<body.recipes.length;selectionIndex++){
    const selection=body.recipes[selectionIndex],doc=documents.get(Number(selection.recipeId))!;
    const original=doc.servings,requested=selection.servings??original;
    if(selection.servings!==undefined&&(!original||original<=0))return fail('source_servings_unknown',422,{recipeId:selection.recipeId,recipeYield:doc.recipe_yield??null});
    const scale=selection.servings===undefined?1:selection.servings/original!;
    const overrides=selection.amountOverrides??{};
    if(Object.entries(overrides).some(([index,v]:[string,any])=>!/^\d+$/.test(index)||Number(index)>=doc.ingredients.length||!v||!['g','ml','piece'].includes(v.unit)||typeof v.quantity!=='number'||!Number.isFinite(v.quantity)||v.quantity<=0||v.quantity>10000000))return fail('invalid_amount_override');
    let recipeCost=0;const lines=[];
    for(let ingredientIndex=0;ingredientIndex<doc.ingredients.length;ingredientIndex++){
      const ingredient=doc.ingredients[ingredientIndex],link=live.links.get(ingredient.ingredient_original);
      const priced=calculateLine(ingredient,link?.product??null,link?.status??'unknown',scale,overrides[String(ingredientIndex)] as AmountOverride|undefined);
      allLines.push(priced);if(priced.consumedCostOre!==null){recipeCost+=priced.consumedCostOre;consumed+=priced.consumedCostOre;}
      const line={ingredientIndex,name:ingredient.ingredient_original,sourceUnit:ingredient.unit,sourceQuantity:ingredient.measured_quantity,qualitativeAmount:ingredient.qualitative_amount??null,...priced};lines.push(line);
      if(priced.status==='unresolved')unresolved.push({selectionIndex,recipeId:Number(selection.recipeId),ingredientIndex,name:ingredient.ingredient_original,reason:priced.reason});
    }
    const complete=lines.every(l=>l.status!=='unresolved');
    recipeResults.push({recipeId:Number(selection.recipeId),selectionIndex,sourceServings:original,requestedServings:requested,scale,nutritionPerServing:doc.nutrition.nutrients_per_serving,lines,complete,consumedCostOre:complete?Math.round(recipeCost):null,knownConsumedCostOre:Math.round(recipeCost)});
  }
  const shopping=aggregateShopping(allLines),complete=unresolved.length===0;
  const purchaseComplete=complete&&shopping.every(s=>s.purchaseCostOre!==null&&s.depositOre!==null);
  return json({datasetId:m.datasetId,catalogueSnapshotId:live.version.snapshot!.id,connectionRunId:live.version.run!.id,storeId:live.version.snapshot!.store_id,currency:'SEK',priceScale:'öre',pricedAt:new Date().toISOString(),complete,purchaseComplete,
    consumedCostOre:complete?Math.round(consumed):null,knownConsumedCostOre:Math.round(consumed),purchaseCostOre:purchaseComplete?shopping.reduce((n,s)=>n+s.purchaseCostOre!+s.depositOre!,0):null,
    knownPurchaseCostOre:shopping.reduce((n,s)=>n+(s.purchaseCostOre??0)+(s.depositOre??0),0),recipes:recipeResults,shoppingList:shopping,unresolved,conversionPolicy,
    earliestPriceExpiry:shopping.length?shopping.map(s=>s.expiresAt).sort()[0]:null});
}
export async function mealRoutes(request:Request,env:MealEnv,requestJson:(r:Request)=>Promise<any>):Promise<Response>{
  const u=new URL(request.url),route=u.pathname;
  if((u.searchParams.get('cursor')?.length??0)>10000)return fail('invalid_cursor');
  if(route==='/meal/openapi.json'&&request.method==='GET')return json(mealOpenApi(u.origin));
  if(!env.MEAL_DB)return fail('meal_database_not_connected',503);
  const state=await env.MEAL_DB.prepare("SELECT key,value FROM meal_meta WHERE key IN ('active_dataset','manifest','ready','uploaded_recipe_count')").all<{key:string;value:string}>();
  const meta=Object.fromEntries(state.results.map(r=>[r.key,r.value]));const m=meta.manifest?JSON.parse(meta.manifest) as Manifest:null;
  if(route==='/meal/status'&&request.method==='GET'){
    const progress=m?await env.MEAL_DB.prepare('SELECT part,completed_at,recipe_count FROM meal_import_progress WHERE dataset_id=? ORDER BY part').bind(m.datasetId).all<{part:number;completed_at:string;recipe_count:number}>():{results:[]};
    const version=m?await activeRun(env,m):null;
    // Progress rows are written only after a part is verified. During an
    // interrupted part, count just that part's ID range so status stays exact.
    let uploadedRecipes=meta.uploaded_recipe_count===undefined?progress.results.reduce((n,p)=>n+p.recipe_count,0):Number(meta.uploaded_recipe_count);
    // Compatibility for a dataset that predates the counter: count only the
    // current part's range, never the full recipe table.
    if(meta.uploaded_recipe_count===undefined&&m&&progress.results.length<5){const next=m.parts?.[progress.results.length];if(next){const partial=await env.MEAL_DB.prepare('SELECT COUNT(*) AS n FROM meal_recipes WHERE dataset_id=? AND recipe_id BETWEEN ? AND ?').bind(m.datasetId,next.firstId,next.lastId).first<{n:number}>();uploadedRecipes+=partial?.n??0;}}
    return json({ready:!!m&&meta.ready===m.datasetId,datasetId:m?.datasetId??null,totalRecipes:m?.recipes??0,uploadedRecipes,completedParts:progress.results.length,totalParts:5,parts:progress.results,ingredientOccurrences:m?.ingredientOccurrences??0,distinctIngredients:m?.distinctIngredients??0,reviews:m?.reviews??0,
      connectionsCurrent:version?.current??false,connectionRunId:version?.run?.id??null,catalogueSnapshotId:version?.snapshot?.id??null,connectionInventory:'cloud-recipe-database',apiVersion:'1',storage:'Cloudflare D1',localFilesRequired:false});
  }
  if(!m||meta.ready!==m.datasetId)return fail('recipe_import_in_progress',503,{statusUrl:'/meal/status'});
  if(route==='/meal/dataset'&&request.method==='GET'){
    const extra=await env.MEAL_DB.prepare("SELECT key,value FROM meal_meta WHERE key IN ('source_metadata','classification_runs','source_counts')").all<{key:string;value:string}>();const audit=Object.fromEntries(extra.results.map(r=>[r.key,JSON.parse(r.value)]));
    return json({manifest:JSON.parse(meta.manifest),sourceMetadata:audit.source_metadata,classificationRuns:audit.classification_runs,sourceCounts:audit.source_counts,archiveUrl:`https://github.com/${m.repository}/releases/download/${m.releaseTag}/recipes_with_filters.sqlite.gz`,apiVersion:'1',conversionPolicy});}
  if(route==='/meal/filters'&&request.method==='GET')return json({datasetId:m.datasetId,definitions:await filterDefinitions(env,m),states:['yes','no','unknown'],strictUnknownsExcluded:true});
  if(route==='/meal/quote')return request.method==='POST'?quote(request,env,m,await requestJson(request)):fail('method_not_allowed',405);
  const match=/^\/meal\/recipes\/([1-9]\d{0,9})(?:\/(reviews|archive|cost))?$/.exec(route);
  if(match&&request.method==='GET'){
    const id=Number(match[1]);
    if(match[2]==='cost')return quote(request,env,m,{recipes:[{recipeId:id,...(u.searchParams.has('servings')?{servings:Number(u.searchParams.get('servings'))}:{})}]});
    if(match[2]==='reviews'){
      const limit=bounded(u,'limit',20,1,100),offset=bounded(u,'offset',0,0,100000);
      const cacheId=`${id}:${offset}:${limit}`,cached=getMealImmutable(env.MEAL_DB,m.datasetId,'reviews',cacheId);if(cached!==null)return json(JSON.parse(cached));
      const found=await env.MEAL_DB.prepare('SELECT json_array_length(document_json,\'$.reviews\') AS n FROM meal_recipes WHERE dataset_id=? AND recipe_id=?').bind(m.datasetId,id).first<{n:number}>();
      if(!found)return fail('recipe_not_found',404);
      const reviews=await env.MEAL_DB.prepare(`SELECT j.value AS review FROM meal_recipes r,json_each(r.document_json,'$.reviews') j WHERE r.dataset_id=? AND r.recipe_id=? AND CAST(j.key AS INTEGER)>=? ORDER BY CAST(j.key AS INTEGER) LIMIT ?`).bind(m.datasetId,id,offset,limit).all<{review:string}>();
      const value={recipeId:id,total:found.n,reviews:reviews.results.map(r=>JSON.parse(r.review)),nextOffset:offset+reviews.results.length<found.n?offset+reviews.results.length:null};
      setMealImmutable(env.MEAL_DB,m.datasetId,'reviews',cacheId,JSON.stringify(value));return json(value);
    }
    if(match[2]==='archive'){
      const document=await recipeArchive(env,m,id);
      return document!==null?new Response(document,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}):fail('recipe_not_found',404);
    }
    const raw=await recipeDetail(env,m,id);if(raw===null)return fail('recipe_not_found',404);
    const doc=JSON.parse(raw);delete doc.reviews;const live=await lookupLive(env,m,[...new Set(doc.ingredients.map((i:any)=>i.ingredient_original))] as string[]);
    return json({datasetId:m.datasetId,recipeId:id,...doc,ingredients:doc.ingredients.map((i:any)=>({...i,connection:live.links.get(i.ingredient_original)??{status:live.version.current?'unknown_ingredient':'connections_refresh_pending',willysItemId:null}})),connectionsCurrent:live.version.current,catalogueSnapshotId:live.version.snapshot?.id??null,connectionRunId:live.version.run?.id??null,reviewsUrl:`/meal/recipes/${id}/reviews`,costUrl:`/meal/recipes/${id}/cost`});
  }
  if(route==='/meal/recipes'&&request.method==='GET'){
    const limit=bounded(u,'limit',20,1,100),q=(u.searchParams.get('q')??'').trim().toLowerCase();
    if(new TextEncoder().encode(q).length>100)return fail('search_too_long');
    const definitions=await filterDefinitions(env,m);
    const groups:string[][]=[];const spec:Record<string,string>={diet:'diet',excludeAllergen:'allergen',cuisine:'cuisine',region:'cuisine_region',mealType:'meal_type',taste:'taste',nutrition:'nutrition_feature'};
    for(const [param,domain]of Object.entries(spec)){
      const keys=list(u,param);if(keys.length>10)return fail('too_many_filters');
      const found=keys.map(key=>definitions.find(d=>d.domain===domain&&d.key===key));
      if(found.some(d=>!d))return fail('unknown_filter',400,{parameter:param,values:keys});
      const filterKeys=found.map(d=>`${d!.filter_id}:${param==='excludeAllergen'?'no':'yes'}`);
      if(['diet','excludeAllergen','nutrition'].includes(param))for(const k of filterKeys)groups.push([k]);else if(filterKeys.length)groups.push(filterKeys);
    }
    if(groups.length>20)return fail('too_many_filter_groups');
    const availableOnly=u.searchParams.get('availableOnly')!=='false',criteria=JSON.stringify({q,groups,availableOnly});
    const version=await activeRun(env,m);if(availableOnly&&!version.current)return fail('connections_refresh_pending',503);
    let after=0;const cursor=u.searchParams.get('cursor');if(cursor&&cursor.length>10000)return fail('invalid_cursor');
    if(cursor){const value=decode(cursor);if(!Array.isArray(value)||value.length!==4||value[0]!==m.datasetId||!Number.isSafeInteger(value[1])||value[1]<0||value[2]!==criteria||availableOnly&&value[3]!==version.run?.id)return fail('cursor_filter_or_dataset_mismatch',409);after=value[1];}
    const params:any[]=[m.datasetId,after,q,q];let sql=`SELECT r.recipe_id,r.summary_json FROM meal_recipes r WHERE r.dataset_id=? AND r.recipe_id>? AND (?='' OR instr(lower(r.name),?)>0)`;
    let ftsClause='',ftsParams:any[]=[];
    if([...q].length>=3){let indexReady=getMealImmutable(env.MEAL_DB,m.datasetId,'search-ready')==='ready';
      if(!indexReady){try{const state=await env.MEAL_DB.prepare('SELECT ready,expected_count,indexed_count FROM meal_recipe_search_state WHERE dataset_id=?').bind(m.datasetId).first<{ready:number;expected_count:number;indexed_count:number}>();
        indexReady=!!state&&state.ready===1&&state.expected_count===m.recipes&&state.indexed_count===m.recipes;if(indexReady)setMealImmutable(env.MEAL_DB,m.datasetId,'search-ready','', 'ready');}catch{/* Older DBs retain the exact scan until optional schema exists. */}}
      if(indexReady){ftsClause=` AND r.recipe_id IN (SELECT CAST(x.recipe_id AS INTEGER) FROM meal_recipe_search x WHERE x.dataset_id=? AND x.name MATCH ?)`;
        sql+=ftsClause;ftsParams=[m.datasetId,mealSearchPhrase(q)];}}
    for(const group of groups){sql+=` AND r.recipe_id IN (SELECT CAST(j.value AS INTEGER) FROM meal_filter_sets fs,json_each(fs.recipe_ids_json) j WHERE fs.dataset_id=? AND fs.filter_key IN (SELECT value FROM json_each(?)))`;params.push(m.datasetId,JSON.stringify(group));}
    // The two databases have separate bindings; derive unavailable names from
    // current catalogue + current links, then filter immutable ingredient arrays.
    if(availableOnly){
      let now=Date.now();const cacheKey=mealAvailabilityCacheKey(m.datasetId,version.snapshot!.store_id,version.snapshot!.id,version.run!.id,DIETARY_POLICY_VERSION);
      let brokenNames=getMealAvailability(cacheKey,now);
      if(!brokenNames){
        const links=await env.DB.prepare(`SELECT l.ingredient_name,l.status,l.selected_code AS code,
          ${catalogAvailabilityLookupSql('l.selected_code')} AS data_json
          FROM ingredient_links_read l WHERE l.run_id=?`).bind(version.snapshot!.id,version.snapshot!.id,version.run!.id).all<{ingredient_name:string;status:string;code:string|null;data_json:string|null}>();
        now=Date.now();
        const calculated=calculateMealAvailability(links.results,now);
        brokenNames=calculated.broken;setMealAvailability(cacheKey,brokenNames,calculated.expiresAt);
      }
      sql+=` AND NOT EXISTS (SELECT 1 FROM json_each(r.ingredient_names_json) n WHERE n.value IN (SELECT value FROM json_each(?)))`;params.push(JSON.stringify(brokenNames));
    }
    sql+=' ORDER BY r.recipe_id LIMIT ?';params.push(limit+1);
    let result;
    try{result=await env.MEAL_DB.prepare(sql).bind(...params.slice(0,4),...ftsParams,...params.slice(4)).all<{recipe_id:number;summary_json:string}>();}
    catch(error){if(!ftsClause)throw error;result=await env.MEAL_DB.prepare(sql.replace(ftsClause,'')).bind(...params).all<{recipe_id:number;summary_json:string}>();}
    const shown=result.results.slice(0,limit);
    return json({datasetId:m.datasetId,recipes:shown.map(r=>JSON.parse(r.summary_json)),nextCursor:result.results.length>limit?encode([m.datasetId,shown.at(-1)!.recipe_id,criteria,availableOnly?version.run!.id:null]):null,catalogueSnapshotId:version.snapshot?.id??null,connectionsCurrent:version.current});
  }
  if(route==='/meal/ingredients/archive'&&request.method==='GET'){
    const name=u.searchParams.get('name');if(!name||name.length>1000)return fail('ingredient_name_required');
    const row=await env.MEAL_DB.prepare('SELECT document_json FROM meal_ingredients WHERE dataset_id=? AND ingredient_name=?').bind(m.datasetId,name).first<{document_json:string}>();
    return row?new Response(row.document_json,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}):fail('ingredient_not_found',404);
  }
  if((route==='/meal/ingredients'||route==='/meal/ingredients/lookup')&&(request.method==='GET'||request.method==='POST')){
    const limit=bounded(u,'limit',50,1,100);let names:string[]|null=null,after='';
    if(route.endsWith('/lookup')){
      if(request.method!=='POST')return fail('method_not_allowed',405);const body=await requestJson(request);
      if(!body||!Array.isArray(body.names)||body.names.length>100||body.names.some((n:any)=>typeof n!=='string'||!n||n.length>1000))return fail('invalid_ingredient_names');names=body.names;
    }else{if(request.method!=='GET')return fail('method_not_allowed',405);const cursor=u.searchParams.get('cursor');if(cursor){const value=decode(cursor);if(!Array.isArray(value)||value[0]!==m.datasetId||typeof value[1]!=='string')return fail('invalid_cursor');after=value[1];}}
    const records=names?await env.MEAL_DB.prepare('SELECT ingredient_name,document_json FROM meal_ingredients WHERE dataset_id=? AND ingredient_name IN (SELECT value FROM json_each(?)) ORDER BY ingredient_name').bind(m.datasetId,JSON.stringify(names)).all<{ingredient_name:string;document_json:string}>():await env.MEAL_DB.prepare('SELECT ingredient_name,document_json FROM meal_ingredients WHERE dataset_id=? AND ingredient_name>? ORDER BY ingredient_name LIMIT ?').bind(m.datasetId,after,limit+1).all<{ingredient_name:string;document_json:string}>();
    const shown=names?records.results:records.results.slice(0,limit),live=await lookupLive(env,m,shown.map(r=>r.ingredient_name));
    const documents=new Map(shown.map(r=>{const doc=JSON.parse(r.document_json);delete doc.sourceConnection;return[r.ingredient_name,{...doc,connection:live.links.get(r.ingredient_name)??{status:live.version.current?'unknown_ingredient':'connections_refresh_pending',willysItemId:null}}];}));
    return json({datasetId:m.datasetId,ingredients:names?names.map(name=>documents.get(name)??{name,status:'unknown_ingredient'}):[...documents.values()],connectionsCurrent:live.version.current,nextCursor:!names&&records.results.length>limit?encode([m.datasetId,shown.at(-1)!.ingredient_name]):null});
  }
  return fail('route_not_found',404);
}

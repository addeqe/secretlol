/** One long-lived local process; no database writes or network calls. */
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import{StringDecoder}from'node:string_decoder';
import{createRecipeEngine}from'../src/recipe-ingredient-engine.ts';
import{createCoopRecipeEngine}from'../src/recipe-coop-engine.ts';
import{coopReviewCategoryMap}from'../src/retailers/review.ts';
import{scopeKey}from'../src/retailers/types.ts';
import type{ParsedLine}from'../src/recipe-ingredient-engine.ts';
// There is deliberately no live fallback from offline matching.
globalThis.fetch=async()=>{throw new Error('Network is disabled in the offline ingredient engine');};
const at=process.argv.indexOf('--catalogue'),time=process.argv.indexOf('--as-of');
if(at<0||time<0)throw new Error('Supply a pinned --catalogue file and --as-of evaluation time');
const bytes=readFileSync(process.argv[at+1]),catalogue=JSON.parse(bytes.toString());
if(catalogue.schemaVersion!==1||catalogue.retailer!=='willys')throw new Error('Invalid offline catalogue');
const engine=createRecipeEngine(catalogue.products,catalogue.reviews??{},Date.parse(process.argv[time+1]));
const coopAt=process.argv.indexOf('--coop-dataset'),sourcesAt=process.argv.indexOf('--coop-sources'),categoriesAt=process.argv.indexOf('--coop-categories');
const capabilitiesAt=process.argv.indexOf('--coop-nutrition-capabilities');
if((coopAt>=0)!==(sourcesAt>=0))throw new Error('Coop requires both reviewed dataset and observations');
let coop:ReturnType<typeof createCoopRecipeEngine>|undefined;
let coopBytes:Buffer|undefined,sourceBytes:Buffer|undefined,categoryBytes:Buffer|undefined,capabilityBytes:Buffer|undefined;
if(coopAt>=0){
  coopBytes=readFileSync(process.argv[coopAt+1]);sourceBytes=readFileSync(process.argv[sourcesAt+1]);
  if(coopBytes.length>32*1024*1024||sourceBytes.length>32*1024*1024)throw new Error('Oversized Coop snapshot');
  const dataset=JSON.parse(coopBytes.toString()),sources=JSON.parse(sourceBytes.toString());
  let categoryMap:Record<string,string[]>|undefined;
  if(categoriesAt>=0){
    categoryBytes=readFileSync(process.argv[categoriesAt+1]);
    const tree=JSON.parse(categoryBytes.toString());
    if(tree.retailer!=='coop'||scopeKey('coop',tree.scope)!==scopeKey('coop',dataset.scope))throw new Error('Coop categories differ from reviewed scope');
    categoryMap=coopReviewCategoryMap(Object.entries(tree.byId as Record<string,string[]>).map(([categoryId,paths])=>({categoryId,name:paths.join(' > ')})));
  }
  let nutritionCapabilities:Record<string,{contentHash:string;coreComplete:boolean}>|undefined;
  if(capabilitiesAt>=0){
    capabilityBytes=readFileSync(process.argv[capabilitiesAt+1]);
    if(capabilityBytes.length>1024*1024)throw new Error('Oversized nutrition capability manifest');
    const manifest=JSON.parse(capabilityBytes.toString());
    if(manifest.schemaVersion!=='coop-nutrition-capabilities-1'||!manifest.labelManifest?.currentLabelSetHash
      ||!manifest.products||typeof manifest.products!=='object'||Array.isArray(manifest.products))throw new Error('Invalid nutrition capabilities');
    for(const [id,value] of Object.entries(manifest.products) as Array<[string,{contentHash:string;coreComplete:boolean}]>){
      if(!id||!value||typeof value.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(value.contentHash)
        ||typeof value.coreComplete!=='boolean')throw new Error('Invalid nutrition capability row');
    }
    nutritionCapabilities=manifest.products;
  }
  coop=createCoopRecipeEngine(dataset,sources,Date.parse(process.argv[time+1]),{categoryMap,nutritionCapabilities,
    preferCompleteNutrition:!!nutritionCapabilities});
}
// An old catalogue may still verify a food identity, but its prices are never
// carried into current Coop observations. All Coop product attributes are
// checked again against the actual approved Coop SKU by its own engine.
const identityEngine=coop?createRecipeEngine(catalogue.products,catalogue.reviews??{},Date.parse(catalogue.completedAt)):undefined;
function evaluateLine(line:ParsedLine){
  if(!coop)return engine.evaluate(line);
  const exact=coop.evaluate(line);
  return ['no_exact_approved_coop_name','pending_coop_name_requires_verified_canonical_identity'].includes(exact.reason)
    ?coop.evaluate(line,identityEngine!.evaluate(line)):exact;
}
function evaluateSafely(line:ParsedLine){
  try{return evaluateLine(line);}
  catch(error){
    const raw=typeof line?.raw==='string'?line.raw:'';
    return {status:'processing_error',reason:'ingredient_engine_error',
      errorType:error instanceof Error?error.name:'IngredientEngineError',
      errorMessage:error instanceof Error?error.message.slice(0,1000):'Ingredient engine rejected this input',
      foodId:null,selectedCode:null,productId:null,selectedProduct:null,amount:null,conversion:null,
      policy:{...engine.policy(raw),version:engine.metadata.policyVersion},method:'local-ingredient-error-isolation'};
  }
}
const sources=['ingredient-matching.ts','ingredient-vocabulary.ts','ingredient-candidate.ts','ingredient-assessments.ts',
  'dietary-policy.ts','dietary-policy-seed.ts','product-pack.ts','meal-conversions.ts','meal-conversions-data.json','recipe-ingredient-engine.ts','price-freshness.ts'];
const hash=createHash('sha256');
for(const file of sources)hash.update(readFileSync(new URL('../src/'+file,import.meta.url)));
if(coop){
  for(const file of ['recipe-coop-engine.ts','retailers/identity.ts','retailers/review.ts','retailers/types.ts'])hash.update(readFileSync(new URL('../src/'+file,import.meta.url)));
  hash.update(coopBytes!).update(sourceBytes!);if(categoryBytes)hash.update(categoryBytes);
  if(capabilityBytes)hash.update(capabilityBytes);
  hash.update(JSON.stringify(coop.metadata));
  hash.update(JSON.stringify(identityEngine!.metadata));
}
hash.update(readFileSync(new URL('../offline/assets/retail-item-counts.json',import.meta.url)));
hash.update(readFileSync(new URL('../offline/assets/product-equivalences.json',import.meta.url)));
hash.update(readFileSync(new URL('./recipe-ingredient-bridge.ts',import.meta.url)));
hash.update(bytes).update(JSON.stringify(engine.metadata));
const metadata={...engine.metadata,failureHandlingVersion:2,contextHash:hash.digest('hex'),catalogueSnapshotId:catalogue.snapshotId,
  catalogueCompletedAt:catalogue.completedAt,storeId:catalogue.storeId,products:catalogue.products.length,
  ...(coop?{retailer:'coop',coop:coop.metadata,identityReferenceAsOf:catalogue.completedAt}: {})};
console.log(JSON.stringify({metadata}));
async function* jsonLines(){
  const decoder=new StringDecoder('utf8');let pending='';
  for await(const chunk of process.stdin){
    pending+=decoder.write(chunk as Buffer);
    let end:number;
    while((end=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,end);pending=pending.slice(end+1);
      if(Buffer.byteLength(line)>4*1024*1024)throw new Error('Oversized local recipe batch');
      yield line.endsWith('\r')?line.slice(0,-1):line;
    }
    if(Buffer.byteLength(pending)>4*1024*1024)throw new Error('Oversized local recipe batch');
  }
  pending+=decoder.end();if(pending)yield pending;
}
// JSONL is delimited by LF only. U+2028/U+2029 are valid JSON string data;
// Node 24 readline treats them as line endings and can truncate a request.
for await(const raw of jsonLines()){
  if(Buffer.byteLength(raw)>4*1024*1024)throw new Error('Oversized local recipe batch');
  const request=JSON.parse(raw);
  if(request.op==='match'){
    if(!Array.isArray(request.lines)||request.lines.length>4000)throw new Error('Invalid ingredient batch');
    console.log(JSON.stringify({results:request.lines.map(evaluateSafely)}));
  }else if(request.op==='policy'){
    if(!Array.isArray(request.texts)||request.texts.length>4000)throw new Error('Invalid policy batch');
    console.log(JSON.stringify({results:request.texts.map((s:string)=>engine.policy(s))}));
  }else throw new Error('Unknown local engine operation');
}

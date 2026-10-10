import {getMealImmutable,setMealImmutable} from './meal-cache.ts';

export type EnrichmentManifest={revision:string;baseDatasetId:string;recipes:number;chunkWidth:number;recipeChunks:number[];ingredientChunks:Record<string,number>;setChunks:Record<string,number>;planningChunks:number[];ingredientNames:string[];definitions?:any[];coverage?:unknown;[key:string]:unknown};
export type RecipePatch={filters?:any[];profile?:any;source?:Record<string,unknown>};
export type PlanningVector=[number,number|null,number|null,number|null,number|null,number|null,number|null,number|null,number|null,number|null,number|null,number,number[],string,number?];
export type CandidateProfile={version:1;calories:number;targets:Record<string,{min?:number;max?:number}>;trackedNutrients:string[]};
const nutrientColumns:Record<string,number>={calories:2,fat:3,saturatedFat:4,cholesterol:5,sodium:6,carbohydrates:7,fiber:8,sugar:9,protein:10};

export function parseCandidateProfile(raw:string|null):CandidateProfile|null{
  if(raw===null)return null;
  if(raw.length>4000)throw new Error('invalid_candidate_profile');
  let p:any;try{p=JSON.parse(raw);}catch{throw new Error('invalid_candidate_profile');}
  if(!p||p.version!==1||typeof p.calories!=='number'||!Number.isFinite(p.calories)||p.calories<=0||p.calories>100000||!p.targets||typeof p.targets!=='object'||Array.isArray(p.targets)||!Array.isArray(p.trackedNutrients)||p.trackedNutrients.length>9||p.trackedNutrients.some((k:unknown)=>typeof k!=='string'||!Object.hasOwn(nutrientColumns,k)))throw new Error('invalid_candidate_profile');
  for(const [key,value] of Object.entries(p.targets) as Array<[string,any]>){
    if(!Object.hasOwn(nutrientColumns,key)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['min','max'].includes(k))||Object.values(value).some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0)||value.min!==undefined&&value.max!==undefined&&value.min>value.max)throw new Error('invalid_candidate_profile');
  }
  return {version:1,calories:p.calories,targets:p.targets,trackedNutrients:[...new Set<string>(p.trackedNutrients)]};
}

export async function enrichmentChunks(db:D1Database,m:EnrichmentManifest,kind:string,ids:number[]){
  const result=new Map<number,any>(),missing:number[]=[];
  for(const id of [...new Set(ids)]){const cached=getMealImmutable(db,m.revision,'enrichment:'+kind,String(id));if(cached!==null)result.set(id,JSON.parse(cached));else missing.push(id);}
  if(missing.length){const rows=await db.prepare('SELECT chunk_id,document_json FROM meal_enrichment_chunks WHERE dataset_id=? AND revision=? AND kind=? AND chunk_id IN (SELECT value FROM json_each(?))').bind(m.baseDatasetId,m.revision,kind,JSON.stringify(missing)).all<{chunk_id:number;document_json:string}>();
    for(const r of rows.results){result.set(r.chunk_id,JSON.parse(r.document_json));setMealImmutable(db,m.revision,'enrichment:'+kind,String(r.chunk_id),r.document_json);}
    if(missing.some(id=>!result.has(id)))throw new Error('enrichment_chunk_missing');
  }
  return result;
}

export async function recipePatches(db:D1Database,m:EnrichmentManifest|undefined,ids:number[]){
  const patches=new Map<number,RecipePatch>();if(!m)return patches;
  const wanted=ids.filter(id=>m.recipeChunks.includes(Math.floor(id/m.chunkWidth)));
  const chunks=await enrichmentChunks(db,m,'recipes',wanted.map(id=>Math.floor(id/m.chunkWidth)));
  for(const id of wanted){const p=chunks.get(Math.floor(id/m.chunkWidth))?.[String(id)];if(p)patches.set(id,p);}
  return patches;
}

export function mergeRecipePatch(doc:any,patch:RecipePatch|undefined){
  if(!patch)return doc;
  const filters=new Map((doc.filters??[]).map((f:any)=>[f.filter_id,f]));for(const f of patch.filters??[])filters.set(f.filter_id,f);
  return {...doc,source:{...doc.source,...patch.source},filters:[...filters.values()].sort((a:any,b:any)=>a.filter_id-b.filter_id),profile:patch.profile??doc.profile};
}

export function mergeSummaryPatch(summary:any,patch:RecipePatch|undefined){
  if(!patch)return summary;
  const filters={...summary.filters};for(const f of patch.filters??[])filters[String(f.filter_id)]=f.state;
  return {...summary,servings:patch.source?.RecipeServings??summary.servings,nutrientsPerServing:patch.profile?.nutrition_metrics?.nutrients_per_serving??summary.nutrientsPerServing,filters};
}

export async function ingredientPatches(db:D1Database,m:EnrichmentManifest|undefined,names:string[]){
  const patches=new Map<string,any>();if(!m)return patches;
  const wanted=names.filter(name=>m.ingredientChunks[name]!==undefined),chunks=await enrichmentChunks(db,m,'ingredients',wanted.map(name=>m.ingredientChunks[name]));
  for(const name of wanted){const p=chunks.get(m.ingredientChunks[name])?.[name];if(p)patches.set(name,p);}
  return patches;
}

/** All hard classification and availability constraints precede advisory ranking. */
export async function rankedRecipeIds(db:D1Database,m:EnrichmentManifest,groups:string[][],brokenNames:string[],q:string,profile:CandidateProfile|null){
  const wantedKeys=[...new Set(groups.flat())],setChunks=await enrichmentChunks(db,m,'sets',wantedKeys.filter(k=>m.setChunks[k]!==undefined).map(k=>m.setChunks[k]));
  let allowed:Set<number>|null=null;
  for(const group of groups){const union=new Set<number>();for(const key of group){const ids=setChunks.get(m.setChunks[key])?.[key]??[];for(const id of ids)union.add(id);}
    allowed=allowed===null?union:new Set<number>([...allowed].filter((id:number)=>union.has(id)));if(!allowed.size)return {ids:[],eligibleCount:0,rankedBy:[] as string[]};}
  const broken=new Set(brokenNames.map(name=>m.ingredientNames.indexOf(name)).filter(i=>i>=0));
  const chunks=await enrichmentChunks(db,m,'planning',m.planningChunks),vectors=[...chunks.values()].flat() as PlanningVector[];
  const rankedBy=profile?Object.keys(profile.targets).filter(k=>profile.trackedNutrients.includes(k)):[];
  const scored:Array<{id:number;score:number;density:number;unresolved:number}>=[];
  for(const v of vectors){
    if(allowed&&!allowed.has(v[0])||q&&!v[13].toLowerCase().includes(q)||v[12].some(i=>broken.has(i)))continue;
    if(profile&&(!(v[1]!>0)||!(v[2]!>0)||profile.trackedNutrients.some(k=>typeof v[nutrientColumns[k]]!=='number')))continue;
    let score=0,density=0;
    for(const key of rankedBy){const target=profile!.targets[key],actual=(v[nutrientColumns[key]] as number)/v[2]!*profile!.calories;
      if(target.min!==undefined&&target.min>0){score+=Math.max(0,(target.min-actual)/target.min)**2;density+=Math.min(2,actual/target.min);}
      if(target.max!==undefined){score+=Math.max(0,(actual-target.max)/Math.max(1,target.max))**2;}}
    scored.push({id:v[0],score,density,unresolved:profile?v[14]??0:0});
  }
  scored.sort((a,b)=>a.unresolved-b.unresolved||a.score-b.score||b.density-a.density||a.id-b.id);
  return {ids:scored.map(v=>v.id),eligibleCount:scored.length,rankedBy};
}

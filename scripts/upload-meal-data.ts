import{readFileSync,mkdirSync,writeFileSync}from'node:fs';
import{join}from'node:path';
import{loadEnv,required}from'../src/config.ts';
import{D1DatabaseClient,rows}from'../src/database.ts';
import{validateManifest,unpackAsset,prepareCommon,nextImportPart,uploadPart,mealSchema}from'../src/meal-import.ts';
import type{MealManifest,MealRecord}from'../src/meal-import.ts';
loadEnv();
try{
  const m=JSON.parse(readFileSync('meal-data/manifest.json','utf8')) as MealManifest;validateManifest(m);
  const database=new D1DatabaseClient({databaseId:required('MEAL_DATABASE_ID')});
  const query='query ($account: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $account}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {datetime_geq: $since, datetime_leq: $until}) { sum { rowsWritten } } } } }';
  const now=new Date().toISOString();
  const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${required('CLOUDFLARE_API_TOKEN')}`,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{account:required('CLOUDFLARE_ACCOUNT_ID'),since:now.slice(0,10)+'T00:00:00Z',until:now}}),signal:AbortSignal.timeout(20000)});
  const usage=await response.json() as any;
  if(!response.ok||usage.errors?.length||!usage.data?.viewer?.accounts?.[0])throw new Error('Daily account write usage could not be verified; import postponed');
  const used=usage.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups.reduce((n:number,g:any)=>n+g.sum.rowsWritten,0);
  if(!Number.isFinite(used)||used+9000>90000)throw new Error('Insufficient daily free write headroom; import postponed');
  await database.query(mealSchema());
  const next=await nextImportPart(database,m);
  let report:any=next;
  if(next.part){
    const folder=process.env.MEAL_RELEASE_DIR??'data/meal-release';
    if(next.part.day===1)await prepareCommon(database,m,unpackAsset(readFileSync(join(folder,m.common.file)),m.common));
    const records=unpackAsset(readFileSync(join(folder,next.part.file)),next.part).trimEnd().split('\n').map(s=>JSON.parse(s)) as MealRecord[];
    report=await uploadPart(database,m,next.part,records);
  }
  report={...report,accountWritesBeforeImport:used,datasetId:m.datasetId,checkedAt:now};
  mkdirSync('data',{recursive:true});writeFileSync('data/last-meal-import-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error instanceof Error?error.message:'Recipe import failed');process.exitCode=1;}

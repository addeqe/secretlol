import{readFileSync,mkdirSync,writeFileSync}from'node:fs';
import{join}from'node:path';
import{parseArgs}from'node:util';
import{loadEnv,required}from'../src/config.ts';
import{D1DatabaseClient}from'../src/database.ts';
import{readDailyD1Writes}from'./check-retailer-quota.ts';
import{validateManifest,unpackAsset,prepareCommon,nextImportPart,uploadPart,mealSchema}from'../src/meal-import.ts';
import type{MealManifest,MealRecord}from'../src/meal-import.ts';
loadEnv();
try{
  const m=JSON.parse(readFileSync('meal-data/manifest.json','utf8')) as MealManifest;validateManifest(m);
  // The scheduled path still imports one part per day. This explicit operator
  // mode checks source integrity and shared account headroom before each part.
  const {values}=parseArgs({options:{'complete-today':{type:'boolean',default:false}}});
  const reports:unknown[]=[];let totalWrites=0,initialUsage:number|undefined,report:any;
  do{
  const measured=await readDailyD1Writes(process.env);initialUsage??=measured;
  // Analytics can lag writes already confirmed in this process.
  const used=Math.max(measured,initialUsage+totalWrites);
  if(used+9000+20000>90000)throw new Error('Insufficient daily free write headroom; import postponed');
  const database=new D1DatabaseClient({databaseId:required('MEAL_DATABASE_ID')});
  await database.query(mealSchema());
  const next=await nextImportPart(database,m,undefined,{allowSameDay:values['complete-today']});
  report=next;
  if(next.part){
    const folder=process.env.MEAL_RELEASE_DIR??'data/meal-release';
    if(next.part.day===1)await prepareCommon(database,m,unpackAsset(readFileSync(join(folder,m.common.file)),m.common));
    const records=unpackAsset(readFileSync(join(folder,next.part.file)),next.part).trimEnd().split('\n').map(s=>JSON.parse(s)) as MealRecord[];
    report=await uploadPart(database,m,next.part,records);
    totalWrites+=database.rowsWritten;reports.push(report);
  }
  report={...report,accountWritesBeforeImport:used,datasetId:m.datasetId,checkedAt:new Date().toISOString(),
    ...(values['complete-today']?{mode:'explicit-same-day-completion',completedPartsThisRun:reports,totalRowsWritten:totalWrites}:{})};
  mkdirSync('data',{recursive:true});writeFileSync('data/last-meal-import-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(!next.part)break;
  }while(values['complete-today']&&!report.complete);
}catch(error){console.error(error instanceof Error?error.message:'Recipe import failed');process.exitCode=1;}

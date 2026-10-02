import{readFileSync,mkdirSync,writeFileSync}from'node:fs';
import{resolve}from'node:path';
import{loadEnv}from'../src/config.ts';
import{D1DatabaseClient,LocalDatabase}from'../src/database.ts';
import{refreshIngredientLinks}from'../src/ingredient-publish.ts';
loadEnv();
let local:LocalDatabase|undefined;
try{
  const i=process.argv.indexOf('--local');if(i>=0)local=new LocalDatabase(process.argv[i+1]);
  const database=local??new D1DatabaseClient();
  const after=process.argv.indexOf('--after-catalogue');
  if(after>=0){
    if(!(database instanceof D1DatabaseClient))throw new Error('Combined budget applies to cloud publication only');
    const publication=JSON.parse(readFileSync(process.argv[after+1],'utf8'));
    if(!Number.isSafeInteger(publication.rowsWritten)||publication.rowsWritten<0||Date.now()-Date.parse(publication.completedAt)>3600000)throw new Error('Invalid or stale catalogue publication budget report');
    database.rowsWritten=publication.rowsWritten;
    const active=await database.query("SELECT value FROM catalog_state WHERE key='active_snapshot'");
    if(active[0]?.results?.[0]?.value!==publication.snapshotId)throw new Error('Catalogue publication budget report is for a different snapshot');
  }
  await database.query(readFileSync(new URL('../migrations/0002_ingredients.sql',import.meta.url),'utf8'));
  const report=await refreshIngredientLinks(database);
  if(database instanceof D1DatabaseClient){Object.assign(report,{rowsWritten:database.rowsWritten,rowsRead:database.rowsRead,sizeBytes:database.sizeBytes});}
  mkdirSync('data',{recursive:true});writeFileSync(resolve('data/last-ingredient-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error instanceof Error?error.message:'Ingredient refresh failed');process.exitCode=1;}
finally{local?.close();}

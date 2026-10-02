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
  await database.query(readFileSync(new URL('../migrations/0002_ingredients.sql',import.meta.url),'utf8'));
  const report=await refreshIngredientLinks(database);
  mkdirSync('data',{recursive:true});writeFileSync(resolve('data/last-ingredient-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error instanceof Error?error.message:'Ingredient refresh failed');process.exitCode=1;}
finally{local?.close();}

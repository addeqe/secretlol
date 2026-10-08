import{loadEnv,required}from'../src/config.ts';
import{D1DatabaseClient,rows}from'../src/database.ts';
import{backfillMealSearchIndex}from'../src/meal-search-index.ts';
import{readFileSync,mkdirSync,writeFileSync}from'node:fs';
loadEnv();
try{
  const database=new D1DatabaseClient({databaseId:required('MEAL_DATABASE_ID')});
  const state=Object.fromEntries((await rows(database,"SELECT key,value FROM meal_meta WHERE key IN ('active_dataset','manifest','ready')")).map(r=>[String(r.key),String(r.value)]));
  if(!state.active_dataset||state.ready!==state.active_dataset){console.log('Search index waits for the verified complete recipe import.');}
  else{
    const now=new Date();
    const query='query($account:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$account}){d1AnalyticsAdaptiveGroups(limit:100,filter:{datetime_geq:$since,datetime_leq:$until}){sum{rowsWritten}}}}}';
    const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${required('CLOUDFLARE_API_TOKEN')}`,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{account:required('CLOUDFLARE_ACCOUNT_ID'),since:now.toISOString().slice(0,10)+'T00:00:00Z',until:now.toISOString()}}),signal:AbortSignal.timeout(20000)});
    const analytics=await response.json() as any;
    if(!response.ok||analytics.errors?.length||!analytics.data?.viewer?.accounts?.length)throw new Error('Account write quota could not be verified; search indexing deferred');
    const used=analytics.data.viewer.accounts.flatMap((a:any)=>a.d1AnalyticsAdaptiveGroups??[]).reduce((n:number,g:any)=>n+Number(g.sum?.rowsWritten??0),0);
    if(!Number.isFinite(used)||used+7000>90000){console.log('Search indexing deferred to preserve the account free quota.');}
    else{
      const schema=readFileSync(new URL('../meal-migrations/0002_meal_search.sql',import.meta.url),'utf8');
      for(const statement of schema.split(';').map(s=>s.trim()).filter(Boolean))await database.query(statement);
      let report:any;
      for(let page=0;page<200&&database.rowsWritten<4000;page++){
        report=await backfillMealSearchIndex(database,state.active_dataset,100);
        if(report.ready||report.reason)break;
      }
      report={...report,rowsRead:database.rowsRead,rowsWritten:database.rowsWritten,sizeBytes:database.sizeBytes};
      mkdirSync('data',{recursive:true});writeFileSync('data/last-meal-search-report.json',JSON.stringify(report,null,2)+'\n');
      console.log(JSON.stringify(report));
    }
  }
}catch(error){
  // The exact original search remains usable while this optional index builds.
  console.warn(error instanceof Error?error.message:'Optional search indexing deferred');
}

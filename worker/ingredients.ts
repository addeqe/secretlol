type Env={DB:D1Database;GITHUB_REPOSITORY?:string;GITHUB_DISPATCH_TOKEN?:string};
type Run={id:string;catalogue_snapshot_id:string;created_at:string;report_json:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const codeValid=(code:unknown):code is string=>typeof code==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(code);
function encodeCursor(run:string,name:string,frequency?:number){return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([run,name,frequency??null])))).replace(/\+/g,'-').replace(/\//g,'_');}
function decodeCursor(cursor:string){
  try{const bytes=Uint8Array.from(atob(cursor.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const [run,name,frequency]=JSON.parse(new TextDecoder().decode(bytes));
    if(!/^[a-f0-9-]{36}$/i.test(run)||typeof name!=='string'||!name||name.length>1000||frequency!=null&&(!Number.isSafeInteger(frequency)||frequency<1))throw new Error();return {run,name,frequency};
  }catch{throw new Error('invalid_cursor');}
}
export async function ingredientRoutes(request:Request,env:Env,snapshot:{id:string;store_id:string},requestJson:(r:Request)=>Promise<any>){
  const url=new URL(request.url),route=url.pathname;
  let run=await env.DB.prepare(`SELECT * FROM ingredient_runs WHERE id=(SELECT value FROM catalog_state
    WHERE key='active_ingredient_run') AND status='complete'`).first<Run>();
  if(!run)return json({error:'ingredient_connections_not_ready'},503);
  if(route==='/ingredients/products'&&request.method==='GET'){
    const q=(url.searchParams.get('q')??'').trim();
    if(q.length<2||new TextEncoder().encode(q).length>40)return json({error:'search_must_be_2_to_40_bytes'},400);
    const records=await env.DB.prepare(`SELECT json_remove(data_json,'$.raw','$.price','$.sourcePricing','$.priceHash') AS data_json,
      json_extract(data_json,'$.raw.displayVolume') AS pack_label FROM catalog_entries WHERE snapshot_id=?
      AND instr(lower(replace(replace(replace(name,'Å','å'),'Ä','ä'),'Ö','ö')),?)>0 ORDER BY name LIMIT 30`)
      .bind(snapshot.id,q.toLowerCase()).all<{data_json:string;pack_label:string}>();
    return json({products:records.results.map(r=>({...JSON.parse(r.data_json),packLabel:r.pack_label}))});
  }
  if(route==='/ingredients/history'&&request.method==='GET'){
    const name=url.searchParams.get('name');if(!name||name.length>1000)return json({error:'ingredient_name_required'},400);
    const history=await env.DB.prepare('SELECT * FROM ingredient_change_history WHERE ingredient_name=? ORDER BY changed_at DESC LIMIT 100').bind(name).all();
    return json({name,changes:history.results});
  }
  if(route==='/ingredients/refresh'&&request.method==='POST'){
    if(!env.GITHUB_REPOSITORY||!env.GITHUB_DISPATCH_TOKEN)return json({error:'refresh_not_connected'},503);
    const response=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/sync.yml/dispatches`,{
      method:'POST',headers:{Authorization:`Bearer ${env.GITHUB_DISPATCH_TOKEN}`,Accept:'application/vnd.github+json',
        'Content-Type':'application/json','User-Agent':'WillysIngredientLinks'},
      body:JSON.stringify({ref:'main',inputs:{connections_only:true}}),signal:AbortSignal.timeout(15000)});
    return json(response.ok?{queued:true}:{error:'refresh_dispatch_failed'},response.ok?202:503);
  }
  if(route==='/ingredients/status'&&request.method==='GET'){
    const observation=await env.DB.prepare('SELECT MIN(observed_at) AS oldest FROM catalog_entries WHERE snapshot_id=?').bind(snapshot.id).first<{oldest:string}>();
    return json({...JSON.parse(run.report_json),lastSuccessfulConnectionRefresh:run.created_at,
      activeCatalogueSnapshotId:snapshot.id,connectionsCurrent:run.catalogue_snapshot_id===snapshot.id,
      catalogueFresh:!!observation?.oldest&&Date.now()-Date.parse(observation.oldest)<86400000,
      lastRunTrackedAllIngredients:true});
  }
  if(route==='/ingredients'&&request.method==='GET'){
    const limit=Number(url.searchParams.get('limit')??100);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)return json({error:'limit_must_be_1_to_100'},400);
    let after='',frequency:number|null=null;
    const priority=url.searchParams.get('order')==='frequency';
    const cursor=url.searchParams.get('cursor');
    if(cursor){let decoded;try{decoded=decodeCursor(cursor);}catch{return json({error:'invalid_cursor'},400);}
      const selected=await env.DB.prepare("SELECT * FROM ingredient_runs WHERE id=? AND status='complete'").bind(decoded.run).first<Run>();
      if(!selected)return json({error:'snapshot_expired'},409);run=selected;after=decoded.name;frequency=decoded.frequency??null;
      if(priority!==(frequency!==null))return json({error:'cursor_order_mismatch'},400);
    }
    const status=url.searchParams.get('status'),q=url.searchParams.get('q')??'';
    if(status&&!['matched','needs_review','unavailable','non_purchased'].includes(status)||new TextEncoder().encode(q).length>40)return json({error:'invalid_filter'},400);
    const records=await env.DB.prepare(`SELECT ingredient_name,occurrences,data_json FROM ingredient_links WHERE run_id=?
      AND ${priority?'(? IS NULL OR occurrences<? OR (occurrences=? AND ingredient_name>?))':'ingredient_name>?'}
      AND (? IS NULL OR status=?) AND (?='' OR instr(lower(ingredient_name),lower(?))>0)
      ORDER BY ${priority?'occurrences DESC,':''}ingredient_name LIMIT ?`)
      .bind(run.id,...(priority?[frequency,frequency,frequency,after]:[after]),status,status,q,q,limit+1)
      .all<{ingredient_name:string;occurrences:number;data_json:string}>();
    const shown=records.results.slice(0,limit),current=run.catalogue_snapshot_id===snapshot.id;
    return json({runId:run.id,catalogueSnapshotId:run.catalogue_snapshot_id,connectionsCurrent:current,
      ingredients:shown.map(r=>({...JSON.parse(r.data_json),connectionsCurrent:current})),
      nextCursor:records.results.length>limit?encodeCursor(run.id,shown.at(-1)!.ingredient_name,priority?shown.at(-1)!.occurrences:undefined):null});
  }
  if(route==='/ingredients/lookup'&&request.method==='POST'){
    const body=await requestJson(request);
    if(!body||!Array.isArray(body.ingredients)||body.ingredients.length>100||body.ingredients.some((n:unknown)=>typeof n!=='string'||!n||n.length>1000))return json({error:'invalid_ingredients',message:'Supply at most 100 exact original ingredient names.'},400);
    const records=await env.DB.prepare(`SELECT l.ingredient_name,l.data_json FROM ingredient_links l
      WHERE l.run_id=? AND l.ingredient_name IN (SELECT value FROM json_each(?))`).bind(run.id,JSON.stringify(body.ingredients)).all<{ingredient_name:string;data_json:string}>();
    const map=new Map(records.results.map(r=>[r.ingredient_name,JSON.parse(r.data_json)]));
    const current=run.catalogue_snapshot_id===snapshot.id;
    return json({runId:run.id,catalogueSnapshotId:run.catalogue_snapshot_id,connectionsCurrent:current,
      ingredients:body.ingredients.map((name:string)=>{
        const link=map.get(name);if(!link)return {name,status:'unknown_ingredient',selectedCode:null};
        return {...link,connectionsCurrent:current,priceFresh:current&&!!link.selectedProduct&&Date.parse(link.selectedProduct.expiresAt)>Date.now()};
      })});
  }
  if(route==='/ingredients/review'&&request.method==='POST'){
    const body=await requestJson(request);
    if(!body||typeof body.name!=='string'||body.name.length>1000||!['approve','reject','clear'].includes(body.action)||
      !codeValid(body.code)&&body.action!=='clear'||typeof body.reason!=='string'||body.reason.trim().length<5||body.reason.length>1000||
      body.basis!==undefined&&!['kg','l','piece'].includes(body.basis))return json({error:'invalid_review'},400);
    const found=await env.DB.prepare('SELECT 1 AS ok FROM ingredient_links WHERE run_id=? AND ingredient_name=?').bind(run.id,body.name).first();
    if(!found)return json({error:'unknown_ingredient'},404);
    if(body.action!=='clear'){
      const product=await env.DB.prepare('SELECT 1 AS ok FROM catalog_entries WHERE snapshot_id=? AND code=?').bind(snapshot.id,body.code).first();
      if(!product)return json({error:'unknown_product'},404);
    }
    const old=await env.DB.prepare('SELECT decision_json FROM ingredient_reviews WHERE ingredient_name=?').bind(body.name).first<{decision_json:string}>();
    const before=old?JSON.parse(old.decision_json):{},approved=new Set<string>(before.approvedCodes??[]),rejected=new Set<string>(before.rejectedCodes??[]);
    if(body.action==='approve'){approved.add(body.code);rejected.delete(body.code);}
    if(body.action==='reject'){rejected.add(body.code);approved.delete(body.code);}
    const decision={action:body.action,code:body.code??'',reason:body.reason.trim(),reviewedAt:new Date().toISOString(),
      approvedCodes:[...approved],rejectedCodes:[...rejected],basis:body.basis??before.basis};
    await env.DB.batch([
      body.action==='clear'?env.DB.prepare('DELETE FROM ingredient_reviews WHERE ingredient_name=?').bind(body.name):
        env.DB.prepare('INSERT INTO ingredient_reviews VALUES(?,?,?) ON CONFLICT(ingredient_name) DO UPDATE SET updated_at=excluded.updated_at,decision_json=excluded.decision_json').bind(body.name,decision.reviewedAt,JSON.stringify(decision)),
      env.DB.prepare('INSERT INTO ingredient_review_history VALUES(?,?,?,?)').bind(crypto.randomUUID(),body.name,decision.reviewedAt,JSON.stringify(decision))
    ]);
    let refreshQueued=false;
    if(body.refreshNow===true&&env.GITHUB_REPOSITORY&&env.GITHUB_DISPATCH_TOKEN){
      try{const r=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/sync.yml/dispatches`,{
        method:'POST',headers:{Authorization:`Bearer ${env.GITHUB_DISPATCH_TOKEN}`,Accept:'application/vnd.github+json',
          'Content-Type':'application/json','User-Agent':'WillysIngredientLinks'},body:JSON.stringify({ref:'main',inputs:{connections_only:true}}),signal:AbortSignal.timeout(15000)});refreshQueued=r.ok;}catch{}
    }
    return json({saved:true,refreshQueued,applied:false,message:refreshQueued?'Review saved; connection refresh queued.':'Review saved; applies on the next successful connection refresh.'});
  }
  return json({error:'route_not_found'},404);
}

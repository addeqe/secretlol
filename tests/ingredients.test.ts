import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LocalDatabase,D1DatabaseClient,rows} from '../src/database.ts';
import {normalize} from '../src/products.ts';
import {buildLinks,packInfo,reviewAttributeExclusion} from '../src/ingredient-matching.ts';
import {catalogueIdentityHash} from '../src/ingredient-assessments.ts';
import type {Assessment} from '../src/ingredient-assessments.ts';
import {refreshIngredientLinks} from '../src/ingredient-publish.ts';
import {catalogStorageSchema} from '../src/catalog-storage.ts';
import {ensureIngredientStorage,seedIngredientStorage} from '../src/ingredient-storage.ts';
import {publish} from '../src/publish.ts';
import {handle} from '../worker/index.ts';
import type {Entry,Scan,Statement} from '../src/types.ts';
import {FOOD_RULES} from '../src/ingredient-vocabulary.ts';
import {normalizeText} from '../src/ingredient-matching.ts';
import {ingredientPolicy,productPolicy,DIETARY_POLICY_VERSION} from '../src/dietary-policy.ts';
import {calendarWeekEnd} from '../src/price-freshness.ts';

const date=()=>new Date().toISOString();
function product(code:string,name:string,price:number,pack:string,category='Mejeri, ost & ägg'):Entry{
  return normalize({code,name,priceValue:price,priceUnit:'kr/st',displayVolume:pack,online:true,outOfStock:false,addToCartDisabled:false,potentialPromotions:[]},category,date());
}
const eggs=(code:string,price:number,count:number)=>product(code,`Ägg ${count}p Frigående Medium`,price,`${count}p`);
const requirements=[{name:'eggs',occurrences:100},{name:'water',occurrences:10},{name:'missing unusual food',occurrences:2}];
const inv={requirements,recipes:20,ingredientOccurrences:112,hash:'test-inventory'};
test('the combined free write budget stops an ingredient refresh before any cloud mutation',async()=>{
  let requests=0;
  const database=new D1DatabaseClient({accountId:'a'.repeat(32),databaseId:'b'.repeat(36),token:'test-only',fetcher:async()=>{requests++;throw new Error('No request should occur');}});
  database.rowsWritten=79500;
  await assert.rejects(refreshIngredientLinks(database,inv),/free write budget/);
  assert.equal(requests,0);
});
function db(){const d=new LocalDatabase(':memory:');for(const f of ['0001_catalog.sql','0002_ingredients.sql'])d.execute(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));d.execute(catalogStorageSchema());return d;}
function scan(entries:Entry[],offset=0):Scan{const observedAt=new Date(Date.now()+offset).toISOString();return {entries:entries.map(entry=>({...entry,observedAt})),store:{storeId:'2110',name:'Test',onlineStore:true},categories:[],requests:0,startedAt:observedAt,completedAt:observedAt};}
function workerDb(d:LocalDatabase):D1Database{
  function prepare(sql:string){let params:Statement['params']=[];const s={sql,get params(){return params},bind(...p:NonNullable<Statement['params']>){params=p;return s;},
    async first(){return (await rows(d,sql,params))[0]??null;},async all(){return {results:await rows(d,sql,params),success:true};}};return s;}
  return {prepare,batch:async(statements:ReturnType<typeof prepare>[])=>d.batch(statements.map(s=>({sql:s.sql,params:s.params})))} as unknown as D1Database;
}
const token='private-read-token-at-least-thirty-two-characters',reviewToken='private-write-token-at-least-thirty-two-characters';
function request(path:string,body?:unknown,secret=token){return new Request('https://example.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}

test('egg selection compares price per egg, not the cheapest carton',()=>{
  const links=buildLinks(requirements,[eggs('A',30,6),eggs('B',40,20)]);
  assert.equal(links[0].selectedCode,'B');assert.equal(links[0].selectedProduct?.comparisonPriceOre,200);
  assert.equal(links[1].status,'non_purchased');assert.equal(links[2].status,'needs_review');assert.equal(links.length,requirements.length);
});
test('food identity excludes cheap noodles, butter blends and cinnamon granola',()=>{
  const items=[eggs('E',40,20),product('NOODLE','Äggnudlar',1,'100g','Skafferi'),
    product('BUTTER','Smör Normalsaltat 82%',40,'500g'),product('BLEND','Smör & Raps Normalsaltat 75%',5,'500g'),
    product('SPICE','Kanel Malen Påse',20,'50g','Skafferi'),product('GRANOLA','Kanel Granola',1,'500g','Skafferi')];
  const result=buildLinks(['eggs','butter','cinnamon'].map(name=>({name,occurrences:1})),items);
  assert.deepEqual(result.map(l=>l.selectedCode),['E','BUTTER','SPICE']);
});
test('required salt, virgin oil, lean meat and preparation modifiers survive matching',()=>{
  const items=[product('SALTED','Smör Normalsaltat 82%',10,'500g'),product('UNSALTED','Smör Osaltat 82%',20,'500g'),
    product('OIL','Olivolja',10,'1l','Skafferi'),product('VIRGIN','Olivolja Extra Virgin',20,'1l','Skafferi'),
    product('FAT','Nötfärs 20%',10,'500g','Kött, chark & fågel'),product('LEAN','Nötfärs 5%',20,'500g','Kött, chark & fågel')];
  for(const p of items.filter(p=>p.code==='FAT'||p.code==='LEAN'))p.brand='Qibbla Halal';
  const result=buildLinks(['unsalted butter','extra virgin olive oil','lean ground beef','garlic butter'].map(name=>({name,occurrences:1})),items);
  assert.deepEqual(result.map(l=>l.selectedCode),['UNSALTED','VIRGIN','LEAN',null]);
  assert.equal(result[3].status,'needs_review');
});
test('stale, unavailable and conditionally priced products do not win',()=>{
  const a=eggs('A',10,20),b=eggs('B',15,20),c=eggs('C',20,20),d=eggs('D',40,20);
  a.available=false;b.observedAt=new Date(calendarWeekEnd(Date.now()-7*86_400_000)-1).toISOString();
  c.offers=[{applied:true,qualifyingCount:2,campaignType:'GENERAL'}];
  assert.equal(buildLinks([requirements[0]],[a,b,c,d])[0].selectedCode,'D');
});
test('package parser preserves drained weights and approximate sizes',()=>{
  assert.deepEqual(packInfo(product('A','Tomater',1,'400/240g','Skafferi')),{label:'400/240g',quantity:400,unit:'g',drainedGrams:240,approximate:false});
  assert.equal(packInfo(product('B','Test',1,'2x250ml')).quantity,500);
  assert.equal(packInfo(product('C','Test',1,'ca: 150g')).approximate,true);
});
test('ingredient keywords cannot select nut sweets, snack rings, crispbread or mixed berries',()=>{
  const items=[product('NUT','Hasselnötter Naturella',30,'200g','Glass, godis & snacks'),
    product('CREAM','Hasselnötkräm Kakao Duo',1,'500g','Skafferi'),
    product('RINGS','Jordnötsringar Originalet',1,'500g','Glass, godis & snacks'),
    product('BREAD','Rosmarinknäcke',1,'500g','Skafferi'),
    product('MIX','Smoothie Jordgubb Banan Blåbär Fryst',1,'500g','Fryst')];
  const links=buildLinks(['hazelnuts','peanuts','dried rosemary','frozen blueberries'].map(name=>({name,occurrences:1})),items);
  assert.deepEqual(links.map(l=>l.selectedCode),['NUT',null,null,null]);
});
test('specific shapes and cheeses cannot be shadowed by generic food rules',()=>{
  const items=[product('CRUSHED','Tomater Krossade',1,'400g','Skafferi'),
    product('DICED','Tomater Tärnade',20,'400g','Skafferi'),
    product('BLUE','Blåmögelost',1,'100g'),product('GREEN','Gröna Linser',1,'500g','Skafferi'),
    product('WHOLE','Mandel Naturell',1,'100g','Skafferi'),product('SLICED','Mandelspån',20,'100g','Skafferi')];
  const links=buildLinks(['diced tomatoes','Roquefort cheese','brown lentils','slivered almonds'].map(name=>({name,occurrences:1})),items);
  assert.deepEqual(links.map(l=>l.selectedCode),['DICED',null,null,'SLICED']);
  const owners=new Map<string,string>();
  for(const r of FOOD_RULES)for(const alias of r.aliases){const key=normalizeText(alias);assert.ok(!owners.has(key)||owners.get(key)===r.id,`Conflicting identity for ${key}`);owners.set(key,r.id);}
});
test('reviews add compatible alternatives and preserve multiple exclusions',()=>{
  const now=date(),a=eggs('A',10,20),b=eggs('B',20,20),c=eggs('C',30,20);
  const review={action:'reject' as const,code:'B',reason:'Confirmed wrong sizes',reviewedAt:now,rejectedCodes:['A','B']};
  assert.equal(buildLinks([requirements[0]],[a,b,c],{eggs:review})[0].selectedCode,'C');
  const unknown={name:'unusual ingredient',occurrences:1};
  assert.equal(buildLinks([unknown],[a,b],{'unusual ingredient':{action:'approve',code:'B',reason:'Suitable reviewed food',reviewedAt:now,approvedCodes:['A','B'],basis:'piece'}})[0].selectedCode,'A');
});
test('cloud refresh switches discontinued IDs and newly cheaper alternatives, with history',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20),eggs('B',40,20)]));const first=await refreshIngredientLinks(d,inv);
    assert.equal(first.requirements,3);assert.equal(first.ingredientOccurrences,112);
    await publish(d,scan([eggs('B',40,20),eggs('C',20,20)]));const second=await refreshIngredientLinks(d,inv);
    const link=(await rows(d,'SELECT selected_code FROM ingredient_links_read WHERE run_id=? AND ingredient_name=?',[second.runId,'eggs']))[0];
    assert.equal(link.selected_code,'C');assert.equal((await rows(d,"SELECT * FROM ingredient_change_history WHERE ingredient_name='eggs'")).length,2);
  }finally{d.close();}
});
test('incomplete or stale catalogue leaves the last connection version untouched',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));const first=await refreshIngredientLinks(d,inv);
    await d.query('UPDATE snapshots SET product_count=99');await assert.rejects(refreshIngredientLinks(d,inv),/Incomplete/);
    assert.equal((await rows(d,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0].value,first.runId);
    await d.query('UPDATE snapshots SET product_count=1');
    const priorWeekObservation=calendarWeekEnd(Date.now()-7*86_400_000)-1;
    await d.query('UPDATE catalog_snapshot_storage SET oldest_observation_at=? WHERE snapshot_id=(SELECT value FROM catalog_state WHERE key=\'active_snapshot\')',[new Date(priorWeekObservation).toISOString()]);
    await assert.rejects(refreshIngredientLinks(d,inv),/stale/);
    assert.equal((await rows(d,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0].value,first.runId);
  }finally{d.close();}
});
test('unchanged ingredient mappings reuse intervals and hydrate prices from each pinned catalogue snapshot',async()=>{
  const d=db();try{
    const requirements={requirements:[{name:'a generic ingredient',occurrences:1},{name:'eggs',occurrences:5},{name:'water',occurrences:1}],
      recipes:2,ingredientOccurrences:7,hash:'same-inventory'};
    await publish(d,scan([eggs('A',30,20),eggs('B',40,20)]));
    const first=await refreshIngredientLinks(d,requirements);
    const versionRows=await rows(d,'SELECT ingredient_name,valid_from_revision,data_json FROM ingredient_link_versions ORDER BY ingredient_name');
    const env={DB:workerDb(d),CATALOG_API_TOKEN:token};
    const page=await(await handle(request('/ingredients?limit=1'),env)).json() as any;
    assert.equal(page.ingredients[0].name,'a generic ingredient');
    await publish(d,scan([eggs('A',35,20),eggs('B',40,20)],1000));
    const second=await refreshIngredientLinks(d,requirements);
    assert.equal(second.changedLinks,0);assert.equal(second.unchangedLinks,3);
    assert.deepEqual(await rows(d,'SELECT ingredient_name,valid_from_revision,data_json FROM ingredient_link_versions ORDER BY ingredient_name'),versionRows);
    const current=await(await handle(request('/ingredients/lookup',{ingredients:['eggs']}),env)).json() as any;
    assert.equal(current.ingredients[0].selectedProduct.priceOre,3500);
    const oldPage=await(await handle(request('/ingredients?limit=1&cursor='+encodeURIComponent(page.nextCursor)),env)).json() as any;
    assert.equal(oldPage.runId,first.runId);assert.equal(oldPage.connectionsCurrent,false);
    assert.equal(oldPage.ingredients[0].name,'eggs');
    assert.equal(oldPage.ingredients[0].selectedProduct.priceOre,3000);
    assert.deepEqual(oldPage.ingredients[0].candidates.map((p:any)=>p.priceOre),[3000,4000]);
  }finally{d.close();}
});
test('an interrupted connection upload cannot publish a partial version and can be retried',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));const first=await refreshIngredientLinks(d,inv);
    await publish(d,scan([eggs('A',30,20),eggs('B',10,20)]));
    const failed={query:async(sql:string,params?:Statement['params'])=>{
      if(sql.startsWith('INSERT INTO ingredient_link_versions'))throw new Error('Simulated upload interruption');
      return d.query(sql,params);
    },batch:(statements:Statement[])=>d.batch(statements)};
    await assert.rejects(refreshIngredientLinks(failed,inv),/interruption/);
    assert.equal((await rows(d,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0].value,first.runId);
    const retried=await refreshIngredientLinks(d,inv);assert.notEqual(retried.runId,first.runId);
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_links_read WHERE run_id=?',[retried.runId]))[0].n,3);
    assert.equal((await rows(d,'SELECT selected_code FROM ingredient_links_read WHERE run_id=? AND ingredient_name=?',[retried.runId,'eggs']))[0].selected_code,'B');
  }finally{d.close();}
});
test('ingredient API authenticates reads and keeps review writes on a separate credential',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));await refreshIngredientLinks(d,inv);
    const env={DB:workerDb(d),CATALOG_API_TOKEN:token,INGREDIENT_REVIEW_TOKEN:reviewToken};
    assert.equal((await handle(request('/ingredients/status',undefined,'wrong'),env)).status,401);
    const body=await (await handle(request('/ingredients/lookup',{ingredients:['eggs','water','unknown']}),env)).json() as any;
    assert.equal(body.ingredients[0].selectedCode,'A');assert.equal(body.ingredients[0].priceFresh,true);assert.equal(body.ingredients[2].status,'unknown_ingredient');
    const payload={name:'eggs',action:'reject',code:'A',reason:'Wrong size for recipe'};
    assert.equal((await handle(request('/ingredients/review',payload),env)).status,401);
    assert.equal((await handle(request('/ingredients/review',payload,reviewToken),env)).status,200);
    assert.equal((await rows(d,'SELECT * FROM ingredient_reviews')).length,1);
  }finally{d.close();}
});
test('ingredient pagination is pinned and detects catalogue-version lag',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));await refreshIngredientLinks(d,inv);
    const env={DB:workerDb(d),CATALOG_API_TOKEN:token};
    const first=await (await handle(request('/ingredients?limit=1'),env)).json() as any;
    await publish(d,scan([eggs('A',40,20)]));await refreshIngredientLinks(d,inv);
    const next=await (await handle(request('/ingredients?limit=1&cursor='+encodeURIComponent(first.nextCursor)),env)).json() as any;
    assert.equal(next.runId,first.runId);assert.equal(next.connectionsCurrent,false);
  }finally{d.close();}
});
test('priority review pagination sorts frequency and neither skips nor repeats tied names',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));
    await refreshIngredientLinks(d,{...inv,requirements:[{name:'a',occurrences:2},{name:'z',occurrences:5},{name:'b',occurrences:2}],ingredientOccurrences:9});
    const env={DB:workerDb(d),CATALOG_API_TOKEN:token};let cursor='',names:string[]=[];
    for(let i=0;i<3;i++){
      const page=await(await handle(request('/ingredients?order=frequency&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),env)).json() as any;
      names.push(page.ingredients[0].name);cursor=page.nextCursor;
    }
    assert.deepEqual(names,['z','a','b']);assert.equal(cursor,null);
  }finally{d.close();}
});

test('strict ingredient exclusions distinguish plant foods and nonalcoholic names',()=>{
  for(const name of ['pork','bacon','ham hocks','pancetta','lardons','red wine','dry sherry','Irish cream','hard apple cider',
    'vanilla extract','vanilla','almond extract','unflavored gelatin','marshmallows','shortening','broth','blood sausage',
    'Ricard','anisette','anisette flavoring','Herbsaint','cachaca','Pisco','cottage roll','white Creme de Cacao','creme de cassis',
    'green creme de menthe','framboise eau-de-vie','Drunken Cherries Aka Cherry Bomb','Thai Burgers','jamon serrano']){
    assert.ok(ingredientPolicy(name).blockedReason,name);
  }
  for(const name of ['root beer','ginger ale','red wine vinegar','sherry vinegar','non-alcoholic beer','champagne grapes',
    'vegan bacon','vegetarian gelatin','vegetarian chicken broth','vegetable shortening','vanilla bean','vanilla ice cream',
    'goat cheese','lobster meat','kidney beans','hamburger buns','blood orange','Jello Instant Vanilla Pudding Mix']){
    assert.deepEqual(ingredientPolicy(name),{blockedReason:null,meat:null},name);
  }
  const link=buildLinks([{name:'bacon',occurrences:1}],[eggs('E',20,6)],{bacon:{action:'approve',code:'E',reason:'Attempted bypass',reviewedAt:date()}})[0];
  assert.equal(link.status,'excluded');assert.equal(link.selectedCode,null);
  const reptile=buildLinks([{name:'crocodile',occurrences:1}],[eggs('E',20,6)],{crocodile:{action:'approve',code:'E',reason:'Attempted bypass',reviewedAt:date()}})[0];
  assert.equal(reptile.dietaryPolicy.meat,'other_meat');assert.notEqual(reptile.status,'matched');
  assert.equal(ingredientPolicy('bresaola').meat,'red_meat');
  assert.equal(ingredientPolicy('serrano chilies').blockedReason,null);
});
test('meat brands are exact and policy also applies to manually approved alternatives',()=>{
  const a=product('CHEAP','Kyckling Filé Fryst',1,'1kg','Fryst');a.brand='Unapproved';
  const b={...a,code:'ALLOWED',priceOre:5000,brand:'Eldorado'};
  const beef=product('BEEF','Nötfärs Fryst',10,'1kg','Fryst');beef.brand='Eldorado';
  const allowedBeef={...beef,code:'HALAL',brand:'Qibbla Halal',priceOre:3000};
  const review={action:'approve' as const,code:a.code,reason:'Attempted bypass',reviewedAt:date()};
  const result=buildLinks([{name:'chicken breast',occurrences:1},{name:'ground beef',occurrences:1}],
    [a,b,beef,allowedBeef],{'chicken breast':review,'ground beef':{...review,code:'BEEF'}});
  assert.deepEqual(result.map(l=>l.selectedCode),['ALLOWED','HALAL']);
  assert.equal(productPolicy({...b,brand:'Eldorado Other'},'chicken breast'),'meat_brand_not_permitted');
  assert.equal(productPolicy({...beef,brand:"Jack Link’s"},'ground beef'),null);
  assert.ok(productPolicy({...beef,brand:null},'ground beef'));
  assert.ok(productPolicy(b,'ground beef'));
});
test('excluded daily inventories fail before any database call',async()=>{
  let calls=0;const d={query:async()=>{calls++;return [];},batch:async()=>{calls++;return [];}};
  await assert.rejects(refreshIngredientLinks(d,{...inv,requirements:[{name:'pork',occurrences:112}]}),/Excluded ingredient/);
  assert.equal(calls,0);
});
test('the Worker blocks prohibited reviews, searches and pre-policy connection snapshots',async()=>{
  const d=db();try{
    const chicken=product('CHICKEN','Kyckling Filé',30,'1kg','Kött, chark & fågel');chicken.brand='Unapproved';
    const bacon=product('BACON','Bacon',10,'100g','Kött, chark & fågel');bacon.brand='Eldorado';
    await publish(d,scan([eggs('A',30,20),chicken,bacon]));const first=await refreshIngredientLinks(d,inv);
    const env={DB:workerDb(d),CATALOG_API_TOKEN:token,INGREDIENT_REVIEW_TOKEN:reviewToken};
    for(const code of ['CHICKEN','BACON'])assert.equal((await handle(request('/ingredients/review',
      {name:'eggs',action:'approve',code,reason:'Attempted policy bypass'},reviewToken),env)).status,400);
    const found=await(await handle(request('/ingredients/products?q=Bacon'),env)).json() as any;assert.equal(found.products.length,0);
    const blocked=await(await handle(request('/ingredients/lookup',{ingredients:['pork','vanilla extract']}),env)).json() as any;
    assert.ok(blocked.ingredients.every((r:any)=>r.status==='excluded_by_policy'&&r.selectedCode===null));
    await d.query("UPDATE ingredient_runs SET report_json=json_remove(report_json,'$.dietaryPolicy') WHERE id=?",[first.runId]);
    assert.equal((await handle(request('/ingredients/status'),env)).status,503);
    assert.ok(DIETARY_POLICY_VERSION);
  }finally{d.close();}
});
test('publication removes connections retained in a pre-policy snapshot',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));const first=await refreshIngredientLinks(d,inv);
    await d.query("UPDATE ingredient_runs SET report_json=json_remove(report_json,'$.dietaryPolicy') WHERE id=?",[first.runId]);
    await d.query('INSERT INTO ingredient_links VALUES(?,?,?,?,?,?)',[first.runId,'bacon',1,'matched','A','{}']);
    const next=await refreshIngredientLinks(d,inv);
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_links WHERE run_id=?',[first.runId]))[0].n,0);
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_links_read WHERE run_id=?',[next.runId]))[0].n,3);
  }finally{d.close();}
});

test('legacy ingredient runs seed chronologically as deltas with tombstones and stable run IDs',async()=>{
  const d=db();try{
    const addRun=async(id:string,createdAt:string,records:Array<{name:string;status:string;code:string|null;data:unknown}>)=>{
      await d.query("INSERT INTO ingredient_runs VALUES(?,?,?,'complete',?,?,?)",[id,'snapshot',createdAt,records.length,'inventory','{}']);
      for(const r of records)await d.query('INSERT INTO ingredient_links VALUES(?,?,?,?,?,?)',[id,r.name,1,r.status,r.code,JSON.stringify(r.data)]);
    };
    const egg=(code:string,status='matched')=>({name:'eggs',status,code,data:{name:'eggs',occurrences:1,status,selectedCode:code,selectedProduct:{code,priceOre:100},candidates:[{code,priceOre:100}],reason:'stable'}});
    await addRun('legacy-run-1','2026-01-01T00:00:00.000Z',[egg('A'),{name:'bacon',status:'unavailable',code:null,data:{name:'bacon',occurrences:1,status:'unavailable',selectedCode:null,selectedProduct:null,candidates:[],reason:'missing'}}]);
    await addRun('legacy-run-2','2026-01-02T00:00:00.000Z',[egg('B'),{name:'vanilla',status:'needs_review',code:null,data:{name:'vanilla',occurrences:1,status:'needs_review',selectedCode:null,selectedProduct:null,candidates:[],reason:'new'}}]);
    await ensureIngredientStorage(d);
    const broken={query:async(sql:string,params?:Statement['params'])=>{
      if(sql.startsWith('INSERT INTO ingredient_link_versions'))throw new Error('seed interruption');
      return d.query(sql,params);
    },batch:(statements:Statement[])=>d.batch(statements)};
    await assert.rejects(seedIngredientStorage(broken,'legacy-run-2'),/seed interruption/);
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_link_versions'))[0].n,0);
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_run_storage'))[0].n,0);
    await seedIngredientStorage(d,'legacy-run-2');
    const mappings=await rows(d,'SELECT run_id,revision FROM ingredient_run_storage ORDER BY revision');
    assert.deepEqual(mappings.map(r=>[r.run_id,Number(r.revision)]),[['legacy-run-1',1],['legacy-run-2',2]]);
    assert.deepEqual((await rows(d,'SELECT ingredient_name FROM ingredient_links_read WHERE run_id=? ORDER BY ingredient_name',['legacy-run-1'])).map(r=>r.ingredient_name),['bacon','eggs']);
    assert.deepEqual((await rows(d,'SELECT ingredient_name FROM ingredient_links_read WHERE run_id=? ORDER BY ingredient_name',['legacy-run-2'])).map(r=>r.ingredient_name),['eggs','vanilla']);
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_link_versions'))[0].n,5);
    await seedIngredientStorage(d,'legacy-run-2');
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_link_versions'))[0].n,5);
    await addRun('legacy-run-0','2025-12-31T00:00:00.000Z',[egg('Z')]);
    await assert.rejects(seedIngredientStorage(d,'legacy-run-0'),/chronological order/);
  }finally{d.close();}
});

function assessed(name:string,products:Entry[],outcome:Assessment['outcome']='approve'):Assessment {
  return {name,outcome,approvedCodes:outcome==='approve'?products.map(p=>p.code):[],basis:outcome==='approve'?'piece':null,
    reason:'Reviewed food identity and preparation against the catalogue',evidence:products.length?products.map(p=>p.name):['searched exact food title'],
    reviewedAt:date(),reviewerModel:'gpt-6-luna',catalogueSnapshotId:'test',catalogueIdentityHash:catalogueIdentityHash(products),
    products:outcome==='approve'?products.map(p=>({code:p.code,name:p.name,brand:p.brand})):[]};
}
test('agent reviewed alternatives switch prices and respect human rejection without paid reruns',()=>{
  const name='a reviewed unusual egg name',a=eggs('A',30,20),b=eggs('B',40,20),review=assessed(name,[a,b]);
  const requirement={name,occurrences:1};
  assert.equal(buildLinks([requirement],[a,b],{},Date.now(),{[name]:review})[0].selectedCode,'A');
  b.priceOre=2000;
  const cheaper=buildLinks([requirement],[a,b],{},Date.now(),{[name]:review})[0];
  assert.equal(cheaper.selectedCode,'B');assert.equal(cheaper.method,'agent_reviewed');
  const rejected={action:'reject' as const,code:'B',reason:'Confirmed incompatible option',reviewedAt:date(),rejectedCodes:['B']};
  assert.equal(buildLinks([requirement],[a,b],{[name]:rejected},Date.now(),{[name]:review})[0].selectedCode,'A');
  const replacement={...b,code:'NEW_ID',priceOre:1000};
  assert.equal(buildLinks([requirement],[a,replacement],{},Date.now(),{[name]:review})[0].selectedCode,'NEW_ID');
});
test('a reused product ID with a different food or missing specified attributes cannot use an agent approval',()=>{
  const name='a reviewed unusual egg name',a=eggs('A',30,20),review=assessed(name,[a]);
  a.name='Choklad';
  const changed=buildLinks([{name,occurrences:1}],[a],{},Date.now(),{[name]:review})[0];
  assert.equal(changed.selectedCode,null);assert.equal(changed.status,'needs_review');
  const highFat=product('Y','Yoghurt Naturell 3%',20,'1kg');
  assert.equal(reviewAttributeExclusion('nonfat yogurt',highFat),'fat_free_not_verified');
  assert.equal(reviewAttributeExclusion('organic yogurt',highFat),'organic_not_verified');
  assert.equal(reviewAttributeExclusion('2% yogurt',highFat),'percentage_not_verified');
  assert.equal(reviewAttributeExclusion('unsalted butter',product('S','Smör Normalsaltat',20,'500g')),'unsalted_not_verified');
  assert.equal(reviewAttributeExclusion('light brown sugar',product('F','Farinsocker',20,'500g','Skafferi')),null);
  assert.equal(reviewAttributeExclusion('red plums',product('P','Plommon Gula Klass 1',20,'500g','Frukt & Grönt')),'plum_colour_not_verified');
  assert.equal(reviewAttributeExclusion('artichoke bottoms',product('H','Kronärtskocka Hjärtan Inlagda',20,'500g','Skafferi')),'artichoke_bottom_not_verified');
  assert.equal(reviewAttributeExclusion('Grey Poupon mustard',product('M','Dijonsenap Original',20,'500g','Skafferi')),'requested_brand_not_verified');
  assert.equal(reviewAttributeExclusion('canned black beans',product('D','Svarta Bönor',20,'800g','Skafferi')),'preserved_beans_not_verified');
  assert.equal(reviewAttributeExclusion('canned black beans',product('C','Svarta Bönor Naturella',20,'380/230g','Skafferi')),null);
  assert.equal(reviewAttributeExclusion('dried black beans',product('C','Svarta Bönor Naturella',20,'380/230g','Skafferi')),'dry_beans_incompatible');
  assert.equal(reviewAttributeExclusion('vegan margarine',product('V','Margarin Mat & Bak',20,'500g')),'plant_based_margarine_not_verified');
  assert.equal(reviewAttributeExclusion('chai tea teabags',product('T','Chai Masala Te',20,'150g','Dryck')),'tea_bag_form_not_verified');
  assert.equal(reviewAttributeExclusion('dried chives',product('CH','Gräslök Finhackad Fryst',20,'50g','Fryst')),'dry_form_incompatible');
  assert.equal(reviewAttributeExclusion('dried ancho chiles',product('AN','Chili Ancho Torkad',20,'30g','Frukt & Grönt')),null);
  assert.equal(reviewAttributeExclusion('white bread machine flour',product('BR','Rostbröd Klassiskt',20,'450g','Bröd & Kakor')),'flour_identity_not_verified');
  assert.equal(reviewAttributeExclusion('medium hot salsa',product('SA','Salsa Stark',20,'300g','Skafferi')),'medium_salsa_not_verified');
});
test('verified catalogue absences are explicit and reopen when the catalogue identity changes',()=>{
  const name='unusual food requiring a speciality store',a=eggs('A',30,20),assessment=assessed(name,[a],'unavailable');
  const requirement={name,occurrences:1};
  assert.equal(buildLinks([requirement],[a],{},Date.now(),{[name]:assessment})[0].status,'unavailable');
  a.priceOre=5000;
  assert.equal(buildLinks([requirement],[a],{},Date.now(),{[name]:assessment})[0].status,'unavailable');
  const reopened=buildLinks([requirement],[a,eggs('NEW',30,20)],{},Date.now(),{[name]:assessment})[0];
  assert.equal(reopened.status,'needs_review');assert.match(reopened.reason,/Catalogue products/);
  const unclear=assessed('eggs',[a],'clarify');
  assert.equal(buildLinks([{name:'eggs',occurrences:1}],[a],{},Date.now(),{eggs:unclear})[0].status,'needs_review');
  assert.equal(buildLinks([{name:'eggs',occurrences:1}],[a],{},Date.now(),{eggs:unclear})[0].candidates.length,0);
  assert.equal(buildLinks([{name:'eggs',occurrences:1}],[a],{eggs:{action:'approve',code:'A',basis:'piece',reason:'Verified after clarification',reviewedAt:date()}},Date.now(),{eggs:unclear})[0].status,'matched');
});

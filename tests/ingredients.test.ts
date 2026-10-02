import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LocalDatabase,rows} from '../src/database.ts';
import {normalize} from '../src/products.ts';
import {buildLinks,packInfo} from '../src/ingredient-matching.ts';
import {refreshIngredientLinks} from '../src/ingredient-publish.ts';
import {publish} from '../src/publish.ts';
import {handle} from '../worker/index.ts';
import type {Entry,Scan,Statement} from '../src/types.ts';

const date=()=>new Date().toISOString();
function product(code:string,name:string,price:number,pack:string,category='Mejeri, ost & ägg'):Entry{
  return normalize({code,name,priceValue:price,priceUnit:'kr/st',displayVolume:pack,online:true,outOfStock:false,addToCartDisabled:false,potentialPromotions:[]},category,date());
}
const eggs=(code:string,price:number,count:number)=>product(code,`Ägg ${count}p Frigående Medium`,price,`${count}p`);
const requirements=[{name:'eggs',occurrences:100},{name:'water',occurrences:10},{name:'missing unusual food',occurrences:2}];
const inv={requirements,recipes:20,ingredientOccurrences:112,hash:'test-inventory'};
function db(){const d=new LocalDatabase(':memory:');for(const f of ['0001_catalog.sql','0002_ingredients.sql'])d.execute(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return d;}
function scan(entries:Entry[]):Scan{return {entries,store:{storeId:'2110',name:'Test',onlineStore:true},categories:[],requests:0,startedAt:date(),completedAt:date()};}
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
  const result=buildLinks(['unsalted butter','extra virgin olive oil','lean ground beef','garlic butter'].map(name=>({name,occurrences:1})),items);
  assert.deepEqual(result.map(l=>l.selectedCode),['UNSALTED','VIRGIN','LEAN',null]);
  assert.equal(result[3].status,'needs_review');
});
test('stale, unavailable and conditionally priced products do not win',()=>{
  const a=eggs('A',10,20),b=eggs('B',15,20),c=eggs('C',20,20),d=eggs('D',40,20);
  a.available=false;b.observedAt=new Date(Date.now()-25*3600000).toISOString();
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
    const link=(await rows(d,'SELECT selected_code FROM ingredient_links WHERE run_id=? AND ingredient_name=?',[second.runId,'eggs']))[0];
    assert.equal(link.selected_code,'C');assert.equal((await rows(d,"SELECT * FROM ingredient_change_history WHERE ingredient_name='eggs'")).length,2);
  }finally{d.close();}
});
test('incomplete or stale catalogue leaves the last connection version untouched',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));const first=await refreshIngredientLinks(d,inv);
    await d.query('UPDATE snapshots SET product_count=99');await assert.rejects(refreshIngredientLinks(d,inv),/Incomplete/);
    assert.equal((await rows(d,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0].value,first.runId);
    await d.query('UPDATE snapshots SET product_count=1');
    await d.query("UPDATE catalog_entries SET data_json=json_set(data_json,'$.observedAt',?)",[new Date(Date.now()-25*3600000).toISOString()]);
    await assert.rejects(refreshIngredientLinks(d,inv),/stale/);
    assert.equal((await rows(d,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0].value,first.runId);
  }finally{d.close();}
});
test('an interrupted connection upload cannot publish a partial version and can be retried',async()=>{
  const d=db();try{
    await publish(d,scan([eggs('A',30,20)]));const first=await refreshIngredientLinks(d,inv);
    const failed={query:async(sql:string,params?:Statement['params'])=>{
      if(sql.startsWith('INSERT INTO ingredient_links'))throw new Error('Simulated upload interruption');
      return d.query(sql,params);
    },batch:(statements:Statement[])=>d.batch(statements)};
    await assert.rejects(refreshIngredientLinks(failed,inv),/interruption/);
    assert.equal((await rows(d,"SELECT value FROM catalog_state WHERE key='active_ingredient_run'"))[0].value,first.runId);
    const retried=await refreshIngredientLinks(d,inv);assert.notEqual(retried.runId,first.runId);
    assert.equal((await rows(d,'SELECT COUNT(*) AS n FROM ingredient_links WHERE run_id=?',[retried.runId]))[0].n,3);
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

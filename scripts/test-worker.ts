import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalize } from '../src/products.ts';
import { LocalDatabase } from '../src/database.ts';
import { refreshIngredientLinks } from '../src/ingredient-publish.ts';
import { catalogStorageSchema } from '../src/catalog-storage.ts';
import { ingredientStorageSchema } from '../src/ingredient-storage.ts';
import { mealSchema } from '../src/meal-import.ts';
import { quoteProjectionSql } from '../src/meal-quote-projection.ts';
import { retailSchema, configureRetailDataset, publishRetailObservations } from '../src/retailers/storage.ts';
import { productIdentity, type ReviewedConnection } from '../src/retailers/identity.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';
import type { ProductObservation, RetailerId, StoreScope } from '../src/retailers/types.ts';

const folder = resolve('data/worker-test'); mkdirSync(folder, { recursive: true });
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
const config=resolve(folder,'wrangler.json');
const testConfig=JSON.parse(readFileSync(resolve('wrangler.jsonc'),'utf8'));testConfig.main=resolve('worker/index.ts');testConfig.d1_databases[1].database_id='00000000-0000-0000-0000-000000000001';
testConfig.d1_databases.push({binding:'COOP_DB',database_name:'coop-catalog-local-test',database_id:'00000000-0000-0000-0000-000000000002'});
testConfig.d1_databases.push({binding:'ICA_DB',database_name:'ica-catalog-local-test',database_id:'00000000-0000-0000-0000-000000000003'});
writeFileSync(config,JSON.stringify(testConfig));
const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_ACCOUNT_ID;
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/catalog.json', import.meta.url), 'utf8'));
const id = randomUUID(), date = new Date().toISOString(), token = 'local-worker-test-token-not-a-production-secret';
const quote = (value: unknown) => value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
let sql = readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8');
sql += readFileSync(new URL('../migrations/0002_ingredients.sql', import.meta.url), 'utf8');
// The smoke fixture runs the same compatibility views used by production reads.
sql += `\n${catalogStorageSchema()};\n${ingredientStorageSchema()};\n`;
sql += '\nDELETE FROM catalog_entries; DELETE FROM snapshots; DELETE FROM price_history; DELETE FROM catalog_state;\n';
sql += `INSERT INTO snapshots VALUES(${[id, fixture.store.storeId, fixture.store.name, date, date, fixture.products.length, 'complete', '{}'].map(quote).join(',')});\n`;
for (const product of fixture.products) {
  const entry = normalize({...product,name:product.code==='TEST_MILK_ST'?'Mjölk':product.name,displayVolume:product.code==='TEST_MILK_ST'?'1.5l':null}, 'Mejeri, ost & ägg', date);
  sql += `INSERT INTO catalog_entries VALUES(${[id, entry.code, entry.name, entry.brand, entry.priceHash, date, JSON.stringify(entry)].map(quote).join(',')});\n`;
}
sql += `INSERT INTO catalog_state VALUES('active_snapshot',${quote(id)});\n`;
// Seed through the real matcher/publication code, then transfer just its tables.
const connections = new LocalDatabase(':memory:');
connections.execute(sql);
await refreshIngredientLinks(connections, { requirements: [{name:'milk',occurrences:10},{name:'water',occurrences:2}],
  recipes:2,ingredientOccurrences:12,hash:'runtime-test' });
for(const table of ['catalog_snapshot_storage','catalog_product_versions','ingredient_runs','ingredient_links',
  'ingredient_change_history','ingredient_link_versions','ingredient_run_storage']){
  sql += `DELETE FROM ${table};\n`;
  for(const row of connections.db.prepare(`SELECT * FROM ${table}`).all())sql += `INSERT INTO ${table} VALUES(${Object.values(row).map(quote).join(',')});\n`;
}
const active = connections.db.prepare("SELECT value FROM catalog_state WHERE key='active_ingredient_run'").get()!;
sql += `INSERT INTO catalog_state VALUES('active_ingredient_run',${quote(active.value)});\n`;
connections.close();
const seed = resolve(folder, 'seed.sql'); writeFileSync(seed, sql);
const seeded = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--local', '--config', config,
  '--persist-to', folder, '--file', seed], { env, encoding: 'utf8' });
if (seeded.status !== 0) throw new Error(`Local D1 test setup failed: ${seeded.stderr}`);
let mealSql=mealSchema()+'\nDELETE FROM meal_import_progress; DELETE FROM meal_filter_sets; DELETE FROM meal_ingredients; DELETE FROM meal_recipes; DELETE FROM meal_meta;\n';
const dataset='a'.repeat(64),manifest={datasetId:dataset,recipes:1,ingredientOccurrences:12,distinctIngredients:2,reviews:1,inventoryHash:'runtime-test',repository:'test/fixture',releaseTag:'test',sourceSha256:dataset};
const definitions=[{filter_id:1,domain:'diet',key:'vegetarian',label_sv:'Vegetarisk'},{filter_id:2,domain:'allergen',key:'milk',label_sv:'Mjölk'}];
for(const [key,value] of Object.entries({active_dataset:dataset,ready:dataset,manifest:JSON.stringify(manifest),definitions:JSON.stringify(definitions)}))mealSql+=`INSERT INTO meal_meta VALUES(${quote(key)},${quote(value)});\n`;
const document={source:{RecipeId:'1',Name:'Runtime milk recipe',RecipeServings:2},ingredients:[{ingredient_index:0,ingredient_original:'milk',unit:'milliliter',measured_quantity:'500'},{ingredient_index:1,ingredient_original:'water',unit:'cup',measured_quantity:'1'}],quality:{state:'consistent'},filters:[{filter_id:1,state:'yes'}],profile:{nutrition_metrics:{nutrients_per_serving:{Calories:100}}},reviews:[{ReviewId:1,Review:'Runtime fixture'}]};
mealSql+=`INSERT INTO meal_recipes VALUES(${[dataset,1,'Runtime milk recipe',JSON.stringify(['milk','water']),JSON.stringify({id:1,name:'Runtime milk recipe'}),JSON.stringify(document),'fixture'].map(quote).join(',')});\n`;
mealSql+=`INSERT INTO meal_filter_sets VALUES(${[dataset,'1:yes','[1]'].map(quote).join(',')});\n`;
mealSql+=`INSERT OR REPLACE INTO meal_quote_projections SELECT r.dataset_id,r.recipe_id,r.content_hash,${quoteProjectionSql} FROM meal_recipes r;\n`;
const mealSeed=resolve(folder,'meal-seed.sql');writeFileSync(mealSeed,mealSql);
const seededMeal=spawnSync(process.execPath,[cli,'d1','execute','MEAL_DB','--local','--config',config,'--persist-to',folder,'--file',mealSeed],{env,encoding:'utf8'});if(seededMeal.status!==0)throw new Error('Local meal database test setup failed: '+seededMeal.stderr);
// Seed the retailer DB from the explicitly synthetic fixture, reshaped only to
// satisfy this smoke test's current milk/water recipe and meal manifest.
const demoRetailerFixture=JSON.parse(readFileSync(new URL('../tests/fixtures/retailers/demo-coop.json',import.meta.url),'utf8')) as any;
assert.match(demoRetailerFixture.sourceMarker,/^SYNTHETIC OFFLINE FIXTURE ONLY/);
const retailScope=demoRetailerFixture.scope as StoreScope, retailCheckedAt=new Date(Date.now()-60_000).toISOString();
const fixtureMilk=demoRetailerFixture.observations[0] as ProductObservation;
const milkProduct={...fixtureMilk.product,id:'runtime-demo-milk-1l',ean:null,name:'Synthetic Demo Milk 1 L',brand:'Synthetic Dairy',categories:['Dairy'],
  pack:{quantity:1000,unit:'ml' as const,approximate:false},ingredientsText:'Milk'};
const milkObservation:ProductObservation={...fixtureMilk,retailer:'coop',scope:retailScope,product:milkProduct,
  price:{amountOre:2990,basis:'pack',depositOre:0,memberOnly:false,minimumQuantity:null,validFrom:null,validUntil:null},
  availability:'available',checkedAt:retailCheckedAt,expiresAt:new Date(Date.now()+60*60_000).toISOString(),storeScopeVerified:true};
const milkConnection:ReviewedConnection={ingredientId:'runtime-milk',name:'milk',foodId:'food-milk',status:'matched',mainProductId:milkProduct.id,
  approvedProducts:[{productId:milkProduct.id,identity:productIdentity(milkProduct)}],policyVersion:DIETARY_POLICY_VERSION,
  reviewedAt:retailCheckedAt,reason:'Synthetic local smoke-test identity'};
const waterConnection=demoRetailerFixture.connections.find((c:any)=>c.name==='water') as ReviewedConnection;
const retailDataset={retailer:'coop' as RetailerId,scope:retailScope,datasetId:dataset,inventoryHash:manifest.inventoryHash,
  observations:[milkObservation],connections:[milkConnection,{...waterConnection,policyVersion:DIETARY_POLICY_VERSION}]};
const coopRetailDb=new LocalDatabase(':memory:');coopRetailDb.execute(retailSchema());
await configureRetailDataset(coopRetailDb,retailDataset);
await publishRetailObservations(coopRetailDb,'coop',retailScope,[milkObservation],[milkProduct.id],Date.now());
let coopSql=retailSchema();
for(const table of ['retail_meta','retail_stores','retail_connections','retail_tracked','retail_products','retail_runs','retail_scope_state','retail_price_history','retail_local_mappings']){
  coopSql+=`\nDELETE FROM ${table};\n`;
  for(const row of coopRetailDb.db.prepare(`SELECT * FROM ${table}`).all())coopSql+=`INSERT INTO ${table} VALUES(${Object.values(row).map(quote).join(',')});\n`;
}
coopRetailDb.close();
const coopSeed=resolve(folder,'coop-retail-seed.sql');writeFileSync(coopSeed,coopSql);
const seededCoop=spawnSync(process.execPath,[cli,'d1','execute','COOP_DB','--local','--config',config,'--persist-to',folder,'--file',coopSeed],{env,encoding:'utf8'});
if(seededCoop.status!==0)throw new Error('Local Coop retailer test setup failed: '+seededCoop.stderr);
const icaSeed=resolve(folder,'ica-retail-seed.sql');writeFileSync(icaSeed,retailSchema());
const seededIca=spawnSync(process.execPath,[cli,'d1','execute','ICA_DB','--local','--config',config,'--persist-to',folder,'--file',icaSeed],{env,encoding:'utf8'});
if(seededIca.status!==0)throw new Error('Local ICA retailer test setup failed: '+seededIca.stderr);
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); const chosen = typeof address === 'object' && address ? address.port : 0;
    server.close(() => resolvePort(chosen)); });
});
const child = spawn(process.execPath, [cli, 'dev', '--local', '--config', config, '--persist-to', folder,
  '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--var', `CATALOG_API_TOKEN:${token}`,
  '--var', `INGREDIENT_REVIEW_TOKEN:${token}-review`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
const base = `http://127.0.0.1:${port}`, headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Local Worker exited before starting.');
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (ready) break; await sleep(100);
  }
  assert.ok(ready, 'Worker starts locally');
  assert.equal((await fetch(`${base}/status`)).status, 401);
  const status = await (await fetch(`${base}/status`, { headers })).json() as any;
  assert.equal(status.products, 2); assert.equal(status.store.id, 'TEST'); assert.equal(status.fresh, true);
  const list = await (await fetch(`${base}/catalog?limit=1`, { headers })).json() as any;
  assert.equal(list.products.length, 1); assert.ok(list.nextCursor);
  const next = await (await fetch(`${base}/catalog?limit=1&cursor=${encodeURIComponent(list.nextCursor)}`, { headers })).json() as any;
  assert.equal(next.products.length, 1); assert.notEqual(next.products[0].code, list.products[0].code);
  const prices = await (await fetch(`${base}/prices/query`, { method: 'POST', headers,
    body: JSON.stringify({ storeId: 'TEST', currency: 'SEK', products: [
      { productId: 'milk', willysCode: 'TEST_MILK_ST' }, { productId: 'orange', willysCode: 'TEST_ORANGE_KG', unit: 'g', packQuantity: 275 }
    ] }) })).json() as any;
  assert.equal(prices.prices.length, 2); assert.equal(prices.prices[1].price, 6.3);
  const tracked=await(await fetch(`${base}/ingredients/status`,{headers})).json() as any;
  assert.equal(tracked.ingredientOccurrences,12);assert.equal(tracked.connectionsCurrent,true);
  const linked=await(await fetch(`${base}/ingredients/lookup`,{method:'POST',headers,body:JSON.stringify({ingredients:['milk','water']})})).json() as any;
  assert.equal(linked.ingredients[0].selectedCode,'TEST_MILK_ST');assert.equal(linked.ingredients[1].status,'non_purchased');
  const review={name:'milk',action:'reject',code:'TEST_MILK_ST',reason:'Runtime test exclusion'};
  assert.equal((await fetch(`${base}/ingredients/review`,{method:'POST',headers,body:JSON.stringify(review)})).status,401);
  assert.equal((await fetch(`${base}/ingredients/review`,{method:'POST',headers:{...headers,Authorization:`Bearer ${token}-review`},body:JSON.stringify(review)})).status,200);
  const mealStatus=await(await fetch(`${base}/meal/status`,{headers})).json() as any;
  assert.equal(mealStatus.ready,true,JSON.stringify(mealStatus));assert.equal(mealStatus.connectionsCurrent,true,JSON.stringify(mealStatus));
  const mealSearch=await(await fetch(`${base}/meal/recipes?diet=vegetarian`,{headers})).json() as any;assert.equal(mealSearch.recipes[0].id,1);
  const recipe=await(await fetch(`${base}/meal/recipes/1`,{headers})).json() as any;assert.equal(recipe.ingredients[0].connection.willysItemId,'TEST_MILK_ST');
  const mealQuote=await(await fetch(`${base}/meal/quote`,{method:'POST',headers,body:JSON.stringify({recipes:[{recipeId:1,servings:4}]})})).json() as any;
  assert.equal(mealQuote.complete,true);assert.equal(mealQuote.consumedCostOre,1127);assert.equal(mealQuote.shoppingList[0].packs,1);
  const archive=await(await fetch(`${base}/meal/recipes/1/archive`,{headers})).json() as any;assert.equal(archive.reviews[0].Review,'Runtime fixture');
  const openapi=await(await fetch(`${base}/meal/openapi.json`,{headers})).json() as any;assert.equal(openapi.openapi,'3.1.0');
  const retailers=await(await fetch(`${base}/retailers`,{headers})).json() as any;
  const coop=retailers.retailers.find((r:any)=>r.retailer==='coop'),ica=retailers.retailers.find((r:any)=>r.retailer==='ica');
  assert.equal(coop.connected,true);assert.equal(coop.configured,true);assert.equal(coop.referenceScope.storeId,retailScope.storeId);
  assert.equal(ica.connected,true);assert.equal(ica.configured,false);
  assert.equal((await fetch(`${base}/retailers/coop/products?ids=${milkProduct.id}`)).status,401);
  const coopProducts=await(await fetch(`${base}/retailers/coop/products?ids=${milkProduct.id}`,{headers})).json() as any;
  assert.equal(coopProducts.products[0].product.id,milkProduct.id);assert.equal(coopProducts.products[0].publicPriceUsable,true);
  assert.equal(coopProducts.products[0].product.pack.quantity,1000);assert.equal(coopProducts.products[0].price.amountOre,2990);
  assert.equal((await fetch(`${base}/stores?retailer=coop&postalCode=11455`,{headers})).status,503);
  const retailerQuote=await(await fetch(`${base}/meal/quote`,{method:'POST',headers,body:JSON.stringify({retailer:'coop',recipes:[{recipeId:1,servings:4}]})})).json() as any;
  assert.equal(retailerQuote.priceMode,'reference');assert.equal(retailerQuote.basket.complete,true);
  assert.equal(retailerQuote.basket.purchaseCostOre,2990);assert.equal(retailerQuote.basket.lines.length,1);
  assert.equal(retailerQuote.basket.lines[0].productId,milkProduct.id);assert.equal(retailerQuote.basket.lines[0].packs,1);
  assert.equal((await fetch(`${base}/meal/quote`,{method:'POST',headers,body:JSON.stringify({retailer:'ica',recipes:[{recipeId:1}]})})).status,503);
  const unknownQuote=await fetch(`${base}/meal/quote`,{method:'POST',headers,body:JSON.stringify({retailer:'unknown',recipes:[{recipeId:1}]})});
  assert.equal(unknownQuote.status,400);assert.deepEqual(await unknownQuote.json(),{error:'unknown_retailer'});
  const retailerOpenapi=await(await fetch(`${base}/retailers/openapi.json`,{headers})).json() as any;assert.equal(retailerOpenapi.openapi,'3.1.0');
  console.log('Local Cloudflare runtime: schema, private API, connections, separate review authorization, freshness, pagination pack prices, separate recipe DB binding, filtered search, current connections, quotes, archives, retailer routes, whole-pack retailer quote and OpenAPI passed. No remote resources were used.');
} catch (error) {
  console.error(output.slice(-4000)); throw error;
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), sleep(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

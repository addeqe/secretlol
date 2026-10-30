import test from'node:test';
import assert from'node:assert/strict';
import{normalize}from'../src/products.ts';
import{buildLinks,createIngredientMatcher}from'../src/ingredient-matching.ts';
import{createRecipeEngine}from'../src/recipe-ingredient-engine.ts';
import type{ParsedLine}from'../src/recipe-ingredient-engine.ts';
const asOf=Date.parse('2026-10-11T12:00:00Z');
function product(code:string,name:string,brand:string|null,category:string,volume='1000g'){
  return normalize({code,name,manufacturer:brand,displayVolume:volume,priceValue:20,priceUnit:'kr/st',depositPrice:'',
    online:true,outOfStock:false,addToCartDisabled:false,potentialPromotions:[]},category,new Date(asOf).toISOString());
}
function line(name:string,quantity=100,unit='g'):ParsedLine{
  return{raw:`${quantity} ${unit} ${name}`,name,query:name,names:[name],status:'parsed',
    amount:{quantity,unit},size:null,preparation:null};
}
const products=[product('FLOUR_ST','Vetemjöl','Eldorado','Skafferi'),
  product('CHICKEN_ST','Kycklingbröstfilé','Eldorado','Fryst'),
  product('BAD_CHICKEN_ST','Kycklingbröstfilé','Other brand','Fryst'),
  product('PORK_ST','Fläskfilé','Other brand','Kött'),
  product('OIL_ST','Olivolja','Eldorado','Skafferi','1000ml')];

test('streaming matcher keeps batch decisions and does not recreate product pools per line',()=>{
  const requirements=[{name:'flour',occurrences:1},{name:'olive oil',occurrences:1}];
  const matcher=createIngredientMatcher(products,{},asOf);
  assert.deepEqual(matcher(requirements),buildLinks(requirements,products,{},asOf));
  assert.deepEqual(matcher([requirements[0]])[0],matcher(requirements)[0]);
});
test('local engine uses existing halal exclusions including parsed vanilla identity',()=>{
  const engine=createRecipeEngine(products,{},asOf);
  assert.equal(engine.evaluate(line('pork')).status,'excluded');
  assert.equal(engine.evaluate(line('vanilla',1,'ml')).status,'excluded');
  assert.equal(engine.evaluate(line('red wine',100,'ml')).status,'excluded');
});
test('local engine only selects permitted chicken brands',()=>{
  const engine=createRecipeEngine(products,{},asOf);
  const result=engine.evaluate(line('chicken breasts'));
  assert.equal(result.status,'matched');
  assert.equal(result.selectedCode,'CHICKEN_ST');
  const rejected=createRecipeEngine(products.filter(p=>p.code==='BAD_CHICKEN_ST'),{},asOf).evaluate(line('chicken breasts'));
  assert.notEqual(rejected.status,'matched');
  assert.equal(rejected.selectedCode,null);
});
test('unknown amount can retain identity without claiming usable cost',()=>{
  const engine=createRecipeEngine(products,{},asOf);
  const request={...line('flour'),amount:null};
  const result=engine.evaluate(request);
  assert.equal(result.status,'amount_unresolved');
  assert.equal(result.selectedCode,'FLOUR_ST');
  assert.equal(result.amount,null);
});
test('local engine preserves source volume for verified flour density',()=>{
  const result=createRecipeEngine(products,{},asOf).evaluate({...line('all-purpose flour',236.5882365,'ml'),
    sourceAmount:{quantity:1,unit:'cup'}});
  assert.equal(result.status,'matched');
  assert.ok(result.amount&&result.amount.unit==='g'&&result.amount.quantity>100&&result.amount.quantity<200);
});
test('explicit product attributes cannot be bypassed by a review or parser stripping',()=>{
  const engine=createRecipeEngine(products,{'extra virgin olive oil':{action:'approve',code:'OIL_ST',reason:'test',reviewedAt:'2026-10-11'}},asOf);
  assert.notEqual(engine.evaluate(line('extra virgin olive oil',20,'ml')).status,'matched');
  assert.notEqual(engine.evaluate({...line('flour'),raw:'100 g gluten-free flour'}).status,'matched');
});
test('invalid amounts never become usable shopping amounts',()=>{
  const engine=createRecipeEngine(products,{},asOf);
  for(const quantity of [0,-10,Infinity,NaN])assert.equal(engine.evaluate(line('flour',quantity)).status,'amount_unresolved');
});
test('source water needs no SKU but retains explicit quantity',()=>{
  const result=createRecipeEngine(products,{},asOf).evaluate(line('water',100,'g'));
  assert.equal(result.status,'non_purchased');
  assert.deepEqual(result.amount,{quantity:100,unit:'g'});
});
test('retail fruit counts do not confuse edible grams with purchased whole fruit',()=>{
  const lemon={...product('100255117_ST','Citron Klass 1',null,'Frukt & Grönt','ca150g'),
    comparePriceOre:13333,comparePriceUnit:'kr/kg'};
  const result=createRecipeEngine([lemon],{},asOf).evaluate({...line('lemon',2,'piece'),
    sourceAmount:{quantity:2,unit:'piece'}});
  assert.equal(result.status,'matched');
  assert.deepEqual(result.amount,{quantity:2,unit:'piece'});
  assert.equal(result.selectedProduct?.comparisonPriceOre,2000);
  assert.equal(result.selectedProduct?.pack.quantity,1);
  assert.equal((result.conversion as {method:string}).method,'reviewed-retail-item-count');
  const altered={...lemon,raw:{...lemon.raw,displayVolume:'500g'}};
  const unreviewed=createRecipeEngine([altered],{},asOf).evaluate(line('lemon',2,'piece'));
  assert.notEqual(unreviewed.selectedProduct?.comparisonUnit,'piece');
});
test('potted herb packaging does not establish the weight of edible leaves',()=>{
  const basil={...product('BASIL_ST','Basilika i Kruka Ekologisk',null,'Frukt & Grönt','ca100g'),
    comparePriceOre:20000,comparePriceUnit:'kr/kg'};
  const result=createRecipeEngine([basil],{},asOf).evaluate(line('fresh basil',10,'g'));
  assert.notEqual(result.status,'matched');
  assert.equal(result.reason,'Edible herb yield of a potted plant is not established');
});
test('source-listed alternatives preserve halal exclusion of the entire source line',()=>{
  const result=createRecipeEngine(products,{},asOf).evaluate({...line('chicken breasts'),
    raw:'100 g chicken breasts or pork',selectionSource:'100 g chicken breasts'});
  assert.equal(result.status,'excluded');
});
test('flour tortillas are a prepared product and never match plain flour',()=>{
  const tortilla=product('TORTILLA_ST','Tortilla 8-pack',null,'Skafferi','320g');
  const result=createRecipeEngine([...products,tortilla],{},asOf).evaluate(line('flour tortillas'));
  assert.equal(result.status,'matched');
  assert.equal(result.selectedCode,'TORTILLA_ST');
});
test('unpriceable cheap items do not displace a costable compatible product',()=>{
  const broken={...product('UNPRICED_ST','Vetemjöl',null,'Skafferi',''),priceOre:1,comparePriceOre:1,comparePriceUnit:'kg'};
  const result=createRecipeEngine([...products,broken],{},asOf).evaluate(line('flour'));
  assert.equal(result.status,'matched');
  assert.equal(result.selectedCode,'FLOUR_ST');
});
test('a reviewed sauce identity must retain the reviewed label and pack',()=>{
  const sauce=product('101335651_ST','Chokladsås','Odense','Skafferi','250g');
  const result=createRecipeEngine([sauce],{},asOf).evaluate(line('chocolate syrup'));
  assert.equal(result.status,'matched');
  assert.equal(result.productEvidence?.allergensMayContain.includes('milk'),true);
  assert.notEqual(createRecipeEngine([{...sauce,raw:{...sauce.raw,displayVolume:'500g'}}],{},asOf)
    .evaluate(line('chocolate syrup')).status,'matched');
});

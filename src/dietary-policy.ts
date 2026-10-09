// The owner's ingredient/brand policy. This is a named-food filter, not a
// certification of hidden ingredients, manufacturing processes or suppliers.
import { INGREDIENT_POLICY_SEED, POLICY_SEED_INPUT_COUNT, POLICY_SEED_VERSION, POLICY_TEXT_SEED } from './dietary-policy-seed.ts';

export const DIETARY_POLICY_VERSION = 'owner-halal-brands-strict-2';
export const MEAT_BRANDS = ['affco','qibbla halal','agadeer','aladin','jack links'] as const;
export const CHICKEN_BRANDS = [...MEAT_BRANDS,'eldorado'] as const;
const POLICY_CACHE_LIMIT = 1024;
const POLICY_CACHE_MAX_INPUT_LENGTH = 4096;
const policySeedCurrent = POLICY_SEED_VERSION === DIETARY_POLICY_VERSION && POLICY_SEED_INPUT_COUNT <= 4096;
const policyTextSeed = policySeedCurrent ? new Map(POLICY_TEXT_SEED) : new Map<string, string>();
const ingredientPolicySeed = policySeedCurrent
  ? new Map(INGREDIENT_POLICY_SEED.map(([input, blockedReason, meat]) => [input, { blockedReason, meat }]))
  : new Map<string, PolicyClassification>();
function cacheGet<T>(cache:Map<string,T>,key:string):T|undefined {
  const value=cache.get(key);
  if(value===undefined)return undefined;
  cache.delete(key);cache.set(key,value);
  return value;
}
function cacheSet<T>(cache:Map<string,T>,key:string,value:T) {
  cache.delete(key);cache.set(key,value);
  if(cache.size>POLICY_CACHE_LIMIT)cache.delete(cache.keys().next().value!);
}
const policyTextCache=new Map<string,string>();
export function policyText(s:string) {
  if(s.length<=POLICY_CACHE_MAX_INPUT_LENGTH){
    const seeded=policyTextSeed.get(s);
    if(seeded!==undefined)return seeded;
    const key=`${DIETARY_POLICY_VERSION}\0${s}`,cached=cacheGet(policyTextCache,key);
    if(cached!==undefined)return cached;
    const value=normalizePolicyTextUncached(s);
    cacheSet(policyTextCache,key,value);return value;
  }
  return normalizePolicyTextUncached(s);
}
export function normalizePolicyTextUncached(s:string) {
  return s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
    .replace(/[’']/g,'').replace(/[^a-z0-9%]+/g,' ').trim().replace(/\s+/g,' ');
}
export type MeatKind = 'chicken'|'red_meat'|'other_meat';
export type PolicyClassification = {blockedReason:string|null;meat:MeatKind|null};
const plant = /\b(?:vegan|vegetarian|veggie|meatless|plant based|quorn|tempeh)\b|\b(?:soy|soya|imitation|coconut) (?:bacon|beef|chicken|meat|sausage)/;
const pork = /\b(?:pork|porcine|pig|swine|hog|boar|pancetta|prosciutto|lard|lardons|fatback|guanciale|speck|flask\w*|gris\w*|svin\w*|parmaskinka|cottage roll|jamon)\b/;
const alcohol = /\b(?:wine|beer|lager|ale|stout|porter|rum|brandy|vodka|bourbon|liqueur|liquor|sherry|whiskey|whisky|tequila|sake|marsala|vermouth|champagne|cognac|armagnac|calvados|amaretto|cointreau|kahlua|baileys|drambuie|grand marnier|triple sec|sambuca|ouzo|limoncello|kirsch|kirschwasser|curacao|frangelico|pernod|pastis|absinthe|aquavit|schnapps|schnaps|grappa|mirin|madeira|benedictine|galliano|campari|chartreuse|alcohol|alcoholic|alkohol|vin|ol|rom|konjak|irish cream|jack daniels|buttershots)\b|\b(?:hard|dry) (?:apple )?cider\b|^(?:gin|port|grenache|merlot|cabernet sauvignon|chardonnay|riesling|zinfandel|sauternes|shaoxing)(?:\b|$)/;
function withoutNonAlcoholFoods(s:string){
  return s.replace(/\b(?:wine|sherry|champagne|malt|vin) (?:vinegar|vinager|vinagre|vinager)\b/g,'vinegar')
    .replace(/\b(?:root beer|ginger beer|ginger ale|birch beer|beer yeast|brewers yeast|champagne yeast|champagne grapes)\b/g,'food')
    .replace(/\b(?:non alcoholic|nonalcoholic|alcohol free|alkoholfri|0 0%) (?:beer|wine|lager|ale|rum|vodka)\b/g,'food');
}
export function evaluateIngredientPolicyUncached(name:string):PolicyClassification {
  return evaluateNormalizedIngredient(normalizePolicyTextUncached(name));
}

function classifyIngredient(name:string):PolicyClassification {
  return evaluateNormalizedIngredient(policyText(name));
}

function evaluateNormalizedIngredient(s:string):PolicyClassification {
  const isPlant=plant.test(s);
  if(/\b(?:anisette|ricard|herbsaint|cachaca|pisco|eau de vie)\b|\bcreme de (?:cacao|menthe|cassis)\b/.test(s))return {blockedReason:'alcohol',meat:null};
  if(/\bdrunken cherries\b/.test(s))return {blockedReason:'uncertain_alcohol_source',meat:null};
  if(/^thai burgers$/.test(s))return {blockedReason:'uncertain_animal_source',meat:null};
  if(alcohol.test(withoutNonAlcoholFoods(s)))return {blockedReason:'alcohol',meat:null};
  if(/\b(?:blood|blod|blodpudding|blodkorv)\b/.test(s)&&!/\bblood oranges?\b/.test(s))return {blockedReason:'animal_blood',meat:null};
  if(/^(?:cider|pear cider)$/.test(s))return {blockedReason:'uncertain_alcohol_source',meat:null};
  if(/^(?:(?:real|pure|white|imitation|homemade) )?vanilla$|^vanilla bean paste$/.test(s))return {blockedReason:'uncertain_extract',meat:null};
  if(/\b(?:extract|extracts|\w*extrakt|essence|vanilla flavoring|vanilla flavouring|vaniljarom)\b/.test(s) &&
    !/\b(?:alcohol free|non alcoholic|nonalcoholic|alcoholfree|alkoholfri)\b/.test(s) &&
    !/\b(?:yeast|malt) extract\b|\b(?:emeril\w*|creole|bayou)\b/.test(s)){
    return {blockedReason:'uncertain_extract',meat:null};
  }
  if(!isPlant && (pork.test(s) || /\b(?:bacon|ham|skinka)\b/.test(s) &&
    !/\b(?:beef|chicken|turkey|nöt|not|kyckling|kalkon)\b/.test(s)))return {blockedReason:'pork',meat:null};
  if(!isPlant && /\b(?:gelatin|gelatine|gelatinblad|marshmallows?|rennet|animal fat|suet|tallow|jell o|jello)\b/.test(s) &&
    !/\b(?:jello|jell o) .*pudding\b/.test(s))return {blockedReason:'uncertain_animal_source',meat:null};
  if(/\bshortening\b/.test(s) && !/\b(?:vegetable|vegetarian|vegan|crisco|trex|flora|oil)\b/.test(s))return {blockedReason:'uncertain_animal_source',meat:null};
  if(isPlant)return {blockedReason:null,meat:null};
  // Explicit poultry/meat words include derivatives such as broth and fat.
  // Dairy from goats and shellfish 'meat' do not require a slaughter brand.
  if(/\b(?:chicken|chickens|hen|hens|poultry)\b|\b(?:kyckling\w*|hons\w*)\b/.test(s) &&
    !/\b(?:chicken spice|chicken seasoning|poultry seasoning|hen of the woods)\b/.test(s))return {blockedReason:null,meat:'chicken'};
  if(/\b(?:beef|veal|lamb|mutton|venison|bison|buffalo meat|elk|deer|rabbit|ox|oxtail|steak|steaks|sirloin|tenderloin|brisket|chuck|roast beef|hamburger|hamburgers|ground round|ground chuck|rump roast|round roast|round tip roast|tri tip roast|ribeye|bresaola)\b|\b(?:notfars|oxfile|lamm\w*|farfars|kalv\w*|ryggbiff|hogrev|biff|kottbuljong)\b/.test(s) &&
    !/\bhamburger (?:bun|buns|roll|rolls)\b/.test(s) ||
    /\bgoat\b/.test(s) && !/\b(?:cheese|milk|yogurt|yoghurt|butter)\b/.test(s))return {blockedReason:null,meat:'red_meat'};
  if(/\b(?:turkeys?|ducks?|ducklings?|goose|geese|quails?|pheasants?|partridges?|pigeons?|giblets?|foie gras|alligators?|crocodiles?|kangaroos?)\b|\b(?:kalkon\w*|anka|gaslever)\b/.test(s))return {blockedReason:null,meat:'other_meat'};
  if(/\b(?:meat|meatballs?|meatloaf|sausage|sausages|salami|pepperoni|chorizo|mortadella|bologna|pastrami|jerky|franks|frankfurters?|hot ?dogs?|wieners?|kielbasa|liver|kidneys?|tripe|sweetbreads|blood sausage|blood pudding)\b|\b(?:\w*wurst|korv|kottbullar|blodpudding|blodkorv|lever)\b/.test(s) &&
    !/\b(?:lobster|crab|crabmeat|fish|clam|clams|oyster|oysters|mussel|mussels|shrimp|prawn|scallop|coconut|nut|nuts|kidney bean|kidney beans|meat tenderizer)\b/.test(s))return {blockedReason:null,meat:'other_meat'};
  if(/\b(?:broth|stock|bouillon|consomme|dripping|drippings|bone broth)\b/.test(s) &&
    !/\b(?:vegetable|veggie|mushroom|fish|seafood|clam|clams|lobster|shrimp|prawn|bonito|herb|garlic|onion|dashi)\b/.test(s))return {blockedReason:'uncertain_animal_source',meat:null};
  return {blockedReason:null,meat:null};
}

const ingredientPolicyCache=new Map<string,PolicyClassification>();
export function ingredientPolicy(name:string):PolicyClassification {
  if(name.length<=POLICY_CACHE_MAX_INPUT_LENGTH){
    const seeded=ingredientPolicySeed.get(name);
    if(seeded)return {...seeded};
    const key=`${DIETARY_POLICY_VERSION}\0${name}`,cached=cacheGet(ingredientPolicyCache,key);
    if(cached!==undefined)return {...cached};
    const value=classifyIngredient(name);
    cacheSet(ingredientPolicyCache,key,value);
    return {...value};
  }
  return evaluateNormalizedIngredient(normalizePolicyTextUncached(name));
}

type Product={name:string;brand:string|null;categories?:string[]};
export function productPolicy(product:Product, ingredientName?:string):string|null {
  const own=ingredientPolicy(product.name), requested=ingredientName?ingredientPolicy(ingredientName):null;
  if(requested?.blockedReason)return 'ingredient_excluded_'+requested.blockedReason;
  if(own.blockedReason)return 'product_excluded_'+own.blockedReason;
  const title=policyText(product.name), categories=(product.categories??[]).map(policyText);
  // Meat category catches Swedish titles/cuts without an English animal word.
  const kind=own.meat ?? (!plant.test(title) && categories.some(c=>c.startsWith('kott'))?'other_meat':null);
  const required=requested?.meat;
  const brand=policyText(product.brand??'');
  if(kind && !(kind==='chicken'?CHICKEN_BRANDS:MEAT_BRANDS).some(b=>b===brand))return 'meat_brand_not_permitted';
  if(required && (!kind || required==='chicken' && kind!=='chicken' || required!=='chicken' && kind==='chicken'))return 'meat_identity_not_compatible';
  if(required && !(required==='chicken'?CHICKEN_BRANDS:MEAT_BRANDS).some(b=>b===brand))return 'meat_brand_not_permitted';
  return null;
}

export const DIETARY_POLICY = {version:DIETARY_POLICY_VERSION,chickenBrands:CHICKEN_BRANDS,
  otherMeatBrands:MEAT_BRANDS,excludeUncertainAnimalSources:true,excludeUncertainExtracts:true,
  scope:'Named ingredients and permitted meat brands; hidden ingredients and halal certification are not verified'};

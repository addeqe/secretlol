import { createHash } from 'node:crypto';
import { FOOD_RULES } from './ingredient-vocabulary.ts';
import type { FoodRule } from './ingredient-vocabulary.ts';
import type { Entry } from './types.ts';
import {ingredientPolicy,productPolicy,DIETARY_POLICY_VERSION} from './dietary-policy.ts';
import type {PolicyClassification} from './dietary-policy.ts';
import {catalogueIdentityHash,productIdentity} from './ingredient-assessments.ts';
import type {Assessment} from './ingredient-assessments.ts';

export type Requirement = { name: string; occurrences: number };
export type Pack = { label: string; quantity: number | null; unit: 'g' | 'ml' | 'piece' | null;
  drainedGrams: number | null; approximate: boolean };
export type Candidate = { code: string; name: string; brand: string | null; available: boolean;
  comparisonPriceOre: number | null; comparisonUnit: string; priceOre: number | null;
  priceUnit: string; pack: Pack; observedAt: string; expiresAt: string; eligible: boolean; exclusion: string | null };
export type Decision = { action: 'approve' | 'reject'; code: string; reason: string; reviewedAt: string;
  approvedCodes?: string[]; rejectedCodes?: string[]; basis?: FoodRule['basis'] };
export type Link = Requirement & { ingredientId: string; foodId: string | null;
  status: 'matched' | 'needs_review' | 'unavailable' | 'non_purchased' | 'excluded';
  selectedCode: string | null; selectedProduct: Candidate | null; candidates: Candidate[];
  reason: string; method: string; review?: Decision; matchConfidence: number | null;
  dietaryPolicy:PolicyClassification & {version:string};assessment?:Assessment };
export const MATCHER_VERSION = 'willys-food-rules-4-reviewed';
export const normalizeText = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[’']/g, '').replace(/[^a-z0-9%]+/g, ' ').trim().replace(/\s+/g, ' ');
const prep = /\b(?:finely|coarsely|freshly|chopped|diced|minced|sliced|grated|shredded|peeled|seeded|sifted|softened|melted|beaten|divided|packed|crushed|rinsed|drained|large|medium|small|optional)\b/g;
export function ingredientId(name: string) { return 'ing_' + createHash('sha256').update(name).digest('hex').slice(0,24); }
export function reviewAttributeExclusion(name:string,entry:Entry):string|null {
  const request=normalizeText(name),title=normalizeText(entry.name),cats=entry.categories.map(normalizeText);
  const checks:Array<[boolean,boolean,string]>=[
    [/\borganic\b/.test(request),/\beko\b|ekologisk/.test(title),'organic_not_verified'],
    [/\bgluten free\b|\bglutenfree\b/.test(request),/glutenfri/.test(title+' '+cats.join(' ')),'gluten_free_not_verified'],
    [/\blactose free\b|\blactosefree\b/.test(request),/laktosfri/.test(title),'lactose_free_not_verified'],
    [/\bunsalted\b/.test(request),/osalt|utan salt/.test(title),'unsalted_not_verified'],
    [/\bunsweetened\b/.test(request),/osotad|utan (?:tillsatt )?socker/.test(title),'unsweetened_not_verified'],
    [/\b(?:sugar free|sugarfree)\b/.test(request),/sockerfri|sugar free|0%.*socker/.test(title),'sugar_free_not_verified'],
    [/\b(?:fat free|nonfat|non fat)\b/.test(request),/fettfri|fat free|(?:^| )0%(?: |$)/.test(title),'fat_free_not_verified'],
    [/\b(?:low fat|reduced fat)\b|\blight (?:mayonnaise|mayo|cream cheese|cream|sour cream|yogurt|yoghurt|butter|margarine|cheddar|ricotta|milk|coconut milk)\b/.test(request),
      /\blatt\w*\b|\blight\b|lag.*fett|fettreducer/.test(title),'reduced_fat_not_verified'],
    [/\b(?:low sodium|low salt|reduced sodium|reduced salt)\b/.test(request),/saltreducer|lag.*salt|mindre salt|low sodium/.test(title),'reduced_salt_not_verified'],
    [/\b(?:no salt added|no added salt|salt free)\b/.test(request),/utan (?:tillsatt )?salt|saltfri/.test(title),'no_added_salt_not_verified'],
    [/\bextra virgin\b/.test(request),/extra virgin|extra vergine|extra jungfru/.test(title),'extra_virgin_not_verified'],
    [/\bfrozen\b/.test(request),/fryst|frysta/.test(title)||cats.some(c=>c.startsWith('fryst')),'frozen_not_verified'],
    [/\b(?:dry|dried)\b/.test(request),!(/fryst|frysta/.test(title)||cats.some(c=>c.startsWith('fryst')))&&
      (/torkad|dried/.test(title)||!(/farsk/.test(title)||cats.some(c=>c.startsWith('frukt')))),'dry_form_incompatible'],
    [/\bfresh\b/.test(request),!(/fryst|frysta|torkad/.test(title)||cats.some(c=>c.startsWith('fryst'))),'fresh_incompatible'],
    [/\bcooked\b/.test(request),/kokt|fardigkokt|tillagad|grillad|stekt/.test(title),'cooked_form_not_verified'],
    [/\bnon hydrogenated\b/.test(request),/icke hardad|non hydrogenated|ohardad/.test(title),'non_hydrogenated_not_verified'],
    [/\bwater packed\b|\bin water\b/.test(request),/i vatten|i lake|water packed/.test(title),'water_packed_not_verified'],
    [/\bcapers? packed in salt\b/.test(request),/i salt|saltpack|packed in salt/.test(title),'salt_packed_not_verified'],
    [/\b(?:artichoke bottoms?|artichoke bottom)\b/.test(request),/kronartskocksbottn|artichoke bottom/.test(title),'artichoke_bottom_not_verified'],
    [/\b(?:soy|soya) margarine\b/.test(request),/soja|soy/.test(title),'soy_margarine_not_verified'],
    [/\bstick margarine\b/.test(request),/stick|stav/.test(title),'stick_form_not_verified'],
    [/\bfrozen cut okra\b/.test(request),/hackad|bitar|skivad|cut/.test(title),'cut_okra_not_verified'],
    [/\b(?:vegan|vegetable) margarine\b/.test(request),/vaxtbas|vegan/.test(title),'plant_based_margarine_not_verified'],
    [/\bcanned\b/.test(request)&&/\b(?:beans?|cannellini)\b/.test(request),packInfo(entry).drainedGrams!==null||/konserv|kokt|fardigkokt/.test(title),'preserved_beans_not_verified'],
    [/\b(?:dry|dried)\b/.test(request)&&/\bbeans?\b/.test(request),packInfo(entry).drainedGrams===null&&!/konserv|kokt|fardigkokt/.test(title),'dry_beans_incompatible'],
    [/\bteabags?\b/.test(request),/tepase|tepasar|tea bags?/.test(title),'tea_bag_form_not_verified'],
    [/\bflour\b/.test(request),/mjol|flour|starkelse/.test(title),'flour_identity_not_verified'],
    [/\bmedium(?: hot)? salsa\b/.test(request),/\bmedium\b/.test(title),'medium_salsa_not_verified'],
    [/\bdry roasted\b/.test(request),/torrrost|dry roasted/.test(title),'dry_roasting_not_verified'],
  ];
  for(const [required,verified,reason] of checks)if(required&&!verified)return reason;
  const requested=/(\d+(?:\.\d+)?)%/.exec(request);
  if(requested){const actual=/(\d+(?:[,.]\d+)?)%/.exec(entry.name);if(!actual||Number(actual[1].replace(',','.'))!==Number(requested[1]))return 'percentage_not_verified';}
  if(/\bplums?\b/.test(request))for(const [english,swedish] of [['red','rod(?:a)?'],['yellow','gul(?:a)?'],['blue','bla']]){
    if(new RegExp(`\\b${english}\\b`).test(request)&&!new RegExp(`\\b${swedish}\\b`).test(title))return 'plum_colour_not_verified';
  }
  const brands=['philadelphia','velveeta','cool whip','splenda','miracle whip','bisquick','betty crocker','jell o','jello','nutella','kikkoman','tabasco','grey poupon','heinz','weetabix','classico','nestle','mccormick','lea perrins'];
  for(const brand of brands)if((` ${request} `).includes(` ${brand} `) &&
    !(`${normalizeText(entry.brand??'')} ${title}`).includes(brand))return 'requested_brand_not_verified';
  return null;
}
export function packInfo(entry: Entry): Pack {
  const label = typeof entry.raw?.displayVolume === 'string' ? entry.raw.displayVolume : '';
  const text = label.toLowerCase().replace(/,/g,'.').replace(/\s/g,'').replace(/^ca:?/, '');
  let quantity: number | null = null, unit: Pack['unit'] = null, drainedGrams: number | null = null;
  const weight = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(kg|g)$/.exec(text);
  const cubes = /^(\d+)(?:p|st)\/\d+(?:\.\d+)?l$/.exec(text);
  const multi = /^(?:(\d+)x)?(\d+(?:\.\d+)?)(kg|g|ml|cl|dl|l|p|st|pack)$/.exec(text);
  if(cubes){quantity=Number(cubes[1]);unit='piece';}
  else if (weight) { const scale=weight[3]==='kg'?1000:1; quantity=Number(weight[1])*scale; drainedGrams=Number(weight[2])*scale;unit='g'; }
  else if (multi) {
    const scale: Record<string,number>={kg:1000,g:1,l:1000,dl:100,cl:10,ml:1,p:1,st:1,pack:1};
    quantity=Number(multi[1]??1)*Number(multi[2])*scale[multi[3]];
    unit=/^(kg|g)$/.test(multi[3])?'g':/^(ml|cl|dl|l)$/.test(multi[3])?'ml':'piece';
  }
  return {label,quantity,unit,drainedGrams,approximate:/^ca/i.test(label) || /kr\/kg/i.test(entry.priceUnit)};
}
function expiry(entry: Entry) {
  let until=Date.parse(entry.observedAt)+86400000;
  for(const offer of entry.offers as Array<{validUntil?: number}>){
    if(typeof offer.validUntil==='number' && offer.validUntil>Date.parse(entry.observedAt))until=Math.min(until,offer.validUntil);
  }
  return new Date(until).toISOString();
}
export function candidate(entry: Entry, basis: FoodRule['basis'], now: number): Candidate {
  const pack=packInfo(entry); const priceUnit=entry.priceUnit.toLowerCase().replace(/\s/g,'');
  const compareUnit=entry.comparePriceUnit.toLowerCase().replace(/^kr\//,'').replace(/\s/g,'');
  let unitPrice: number|null=null;
  if(entry.priceOre!==null){
    if(priceUnit===`kr/${basis}`)unitPrice=entry.priceOre;
    else if(/^kr\/(?:st|styck|forp|förp|fp)$/.test(priceUnit)){
      const target=basis==='kg'?'g':basis==='l'?'ml':'piece';
      if(pack.unit===target && pack.quantity && !pack.approximate)unitPrice=entry.priceOre/pack.quantity*(basis==='piece'?1:1000);
      else if(entry.comparePriceOre!==null && compareUnit===(basis==='piece'?'st':basis))unitPrice=entry.comparePriceOre;
    }
  }
  let exclusion: string|null=productPolicy(entry);
  if(exclusion){} // Policy cannot be overridden by stock, price or review state.
  else if(!entry.available)exclusion='unavailable';
  else if(entry.priceOre===null || entry.depositOre===null || unitPrice===null)exclusion='price_or_comparison_basis_unknown';
  else if(Date.parse(expiry(entry))<=now || Date.parse(entry.observedAt)>now+60000)exclusion='stale_price';
  // Never turn a conditional offer into an unconditional cheap item selection.
  else if((entry.offers as Array<Record<string,unknown>>).some(o=>o.applied===true &&
    (Number(o.qualifyingCount)>1 || o.campaignType && o.campaignType!=='GENERAL')))exclusion='conditional_price';
  return {code:entry.code,name:entry.name,brand:entry.brand,available:entry.available,comparisonPriceOre:unitPrice,
    comparisonUnit:basis,priceOre:entry.priceOre,priceUnit:entry.priceUnit,pack,observedAt:entry.observedAt,
    expiresAt:expiry(entry),eligible:exclusion===null,exclusion};
}
type Classified = { rule: FoodRule; uncertain: boolean; reason: string; constraints: (e:Entry)=>boolean };
function classify(name: string): Classified|null {
  const original=normalizeText(name), clean=original.replace(prep,' ').replace(/\s+/g,' ').trim();
  let best: {rule:FoodRule;alias:string;exact:boolean}|undefined;
  for(const rule of FOOD_RULES)for(const raw of rule.aliases){
    const alias=normalizeText(raw), exact=original===alias || clean===alias;
    if(exact || (` ${clean} `).includes(` ${alias} `)){
      if(!best || Number(exact)>Number(best.exact) || exact===best.exact && alias.length>best.alias.length)best={rule,alias,exact};
    }
  }
  if(!best)return null;
  const {rule,alias}=best;
  const leftover=clean.replace(alias,'').replace(/\b(?:organic|extra virgin|fresh|frozen|dried|ground|raw|boneless|skinless)\b/g,' ').trim();
  let uncertain=!!rule.ambiguous || !best.exact && !!leftover;
  let reason=rule.ambiguous?'Food form or substitution requires review':leftover&&!best.exact?'Unrecognized food modifiers require review':'Bilingual food identity and product attributes';
  const requestedFresh=/\bfresh\b/.test(original), requestedFrozen=/\bfrozen\b/.test(original);
  const requestedDried=/\bdried\b/.test(original);
  if(requestedFresh && (rule.form==='dried'||rule.id.endsWith('-canned'))){uncertain=true;reason='Fresh food cannot be replaced with a dried or canned product without review';}
  if(requestedFresh && rule.form==='dried' || requestedDried && rule.form==='fresh' || /\bcooked\b/.test(original)){
    uncertain=true;reason='Preparation state needs a conversion or a different product';
  }
  const fat=/(\d+(?:\.\d+)?)%/.exec(name);
  const constraints=(entry:Entry)=>{
    const title=normalizeText(entry.name), cats=entry.categories.map(normalizeText);
    if(requestedFrozen && !cats.some(c=>c.startsWith('fryst')) && !/fryst/.test(title))return false;
    if(requestedFresh && cats.some(c=>c.startsWith('fryst')))return false;
    if(/\borganic\b/.test(original) && !/\beko\b|ekologisk/.test(title))return false;
    if(/\bextra virgin\b/.test(original) && !/extra virgin|extra vergine|extra jungfru/.test(title))return false;
    if(original.includes('philadelphia') && normalizeText(entry.brand??'')!=='philadelphia')return false;
    if(/gluten free|glutenfree/.test(original) && !title.includes('glutenfri'))return false;
    if(/unsalted/.test(original) && !title.includes('osalt'))return false;
    if(/unsweetened/.test(original) && ['applesauce','almond-milk','soy-milk'].includes(rule.id)&&!(/osotad|utan tillsatt socker|sockerfri/.test(title)))return false;
    if(rule.id==='honey'&&/\bliquid\b/.test(original)&&!title.includes('flytande'))return false;
    if(rule.id==='honey'&&/\braw\b/.test(original)&&!/raw|ra honung|oupphettad/.test(title))return false;
    if(rule.id==='pork-chop'&&/\bboneless\b/.test(original)&&!/benfri|utan ben/.test(title))return false;
    if(original.includes('tabasco')&&!title.includes('tabasco')&&normalizeText(entry.brand??'')!=='tabasco')return false;
    if(/\blean\b/.test(original)&&rule.id==='beef-mince'){
      const fat=/(\d+(?:[,.]\d+)?)%/.exec(entry.name);if(!fat||Number(fat[1].replace(',','.'))>10)return false;
    }
    if(/\bsharp\b/.test(original)&&rule.id==='cheddar'&&!/lagrad|mature|extra|\d+man/.test(title))return false;
    if(fat){const productFat=/(\d+(?:[,.]\d+)?)%/.exec(entry.name);if(!productFat||Number(productFat[1].replace(',','.'))!==Number(fat[1]))return false;}
    return true;
  };
  return {rule,uncertain,reason,constraints};
}
export function buildLinks(requirements: Requirement[], products: Entry[], reviews: Record<string,Decision>={}, now=Date.now(),assessments:Record<string,Assessment>={}):Link[]{
  if(!requirements.length || new Set(requirements.map(r=>r.name)).size!==requirements.length ||
    requirements.some(r=>!r.name.trim() || !Number.isSafeInteger(r.occurrences) || r.occurrences<1))throw new Error('Invalid ingredient inventory');
  if(new Set(products.map(p=>p.code)).size!==products.length)throw new Error('Duplicate catalogue products');
  const byCode=new Map(products.map(p=>[p.code,p]));
  const byIdentity=new Map<string,Entry[]>();
  for(const p of products){const key=productIdentity(p);const group=byIdentity.get(key)??[];group.push(p);byIdentity.set(key,group);}
  const catalogueHash=Object.keys(assessments).length?catalogueIdentityHash(products):'';
  const pools=new Map<string,Entry[]>();
  for(const rule of FOOD_RULES){
    const title=new RegExp(rule.title), exclude=rule.exclude?new RegExp(rule.exclude):null;
    pools.set(rule.id,products.filter(p=>p.categories.some(c=>rule.categories.some(prefix=>normalizeText(c).startsWith(prefix))) &&
      title.test(normalizeText(p.name)) && (!exclude || !exclude.test(normalizeText(p.name)))));
  }
  return requirements.map(requirement=>{
    const name=normalizeText(requirement.name), parsed=classify(requirement.name), policy=ingredientPolicy(requirement.name);
    const base:Link={...requirement,ingredientId:ingredientId(requirement.name),foodId:parsed?.rule.id??null,
      status:'needs_review',reason:'',selectedCode:null,selectedProduct:null,candidates:[],method:'food_rules',matchConfidence:null,
      dietaryPolicy:{...policy,version:DIETARY_POLICY_VERSION}};
    if(policy.blockedReason)return {...base,status:'excluded',method:'dietary_policy',reason:policy.blockedReason};
    if(/^(?:(?:boiling|hot|cold|warm|ice|tap|filtered|lukewarm|distilled) )?water$|^ice cubes?$/.test(name) && !reviews[requirement.name]){
      return {...base,status:'non_purchased',reason:'Tap water/ice assumed; no retail SKU or exact water cost assigned'};
    }
    const review=reviews[requirement.name],assessment=assessments[requirement.name];
    base.assessment=assessment;
    // An explicit review replaces the generic suggestions, which may have been
    // based on a misleading token (for example "pepper" in a cheese name).
    let pool=parsed&&!assessment?pools.get(parsed.rule.id)??[]:[];
    if(parsed)pool=pool.filter(parsed.constraints);
    pool=pool.filter(p=>!productPolicy(p,requirement.name));
    const basis=review?.basis??assessment?.basis??parsed?.rule.basis??'kg';
    let candidates=pool.map(p=>candidate(p,basis,now));
    const rejected=new Set(review?.rejectedCodes??(review?.action==='reject'?[review.code]:[]));
    const approvedCodes=new Set(review?.approvedCodes??(review?.action==='approve'?[review.code]:[]));
    const assessedCodes=new Set<string>();
    let missingAssessmentIdentity=false;
    if(assessment?.outcome==='approve')for(const before of assessment.products){
      const alternatives=(byIdentity.get(productIdentity(before))??[])
        .filter(p=>!reviewAttributeExclusion(requirement.name,p)&&!rejected.has(p.code));
      if(!alternatives.length)missingAssessmentIdentity=true;
      for(const current of alternatives){approvedCodes.add(current.code);assessedCodes.add(current.code);}
    }
    for(const code of approvedCodes){
      const approved=byCode.get(code);
      if(approved && !productPolicy(approved,requirement.name) && !candidates.some(c=>c.code===code))candidates.push(candidate(approved,basis,now));
    }
    candidates=candidates.filter(c=>!rejected.has(c.code));
    candidates.sort((a,b)=>Number(b.eligible)-Number(a.eligible) ||
      (a.comparisonPriceOre??Infinity)-(b.comparisonPriceOre??Infinity) || a.code.localeCompare(b.code));
    const selected=candidates.find(c=>c.eligible && (approvedCodes.has(c.code)||!assessment&&parsed&&!parsed.uncertain));
    const reason=!parsed?'No verified food rule; needs bilingual identity review':parsed.reason;
    if(selected){
      return {...base,review,status:'matched',method:assessedCodes.has(selected.code)?'agent_reviewed':approvedCodes.has(selected.code)?'reviewed':'food_rules',
        selectedCode:selected.code,selectedProduct:selected,candidates:candidates.slice(0,8),
        reason:assessedCodes.has(selected.code)?assessment!.reason:approvedCodes.has(selected.code)?review!.reason:reason};
    }
    if(assessment){
      const unchanged=assessment.catalogueIdentityHash===catalogueHash;
      const missing=assessment.outcome==='approve' && missingAssessmentIdentity;
      return {...base,review,status:assessment.outcome==='unavailable'&&unchanged||assessment.outcome==='approve'&&!missing?'unavailable':'needs_review',
        method:'agent_reviewed',candidates:candidates.slice(0,8),reason:missing?
          'Reviewed product identity changed, disappeared or was rejected; compatibility must be rechecked':
          assessment.outcome==='approve'?'No reviewed compatible product currently has an eligible fresh price':
          assessment.outcome==='unavailable'&&!unchanged?'Catalogue products or availability changed since the absence review; recheck: '+assessment.reason:assessment.reason};
    }
    return {...base,review,status:!parsed||parsed.uncertain?'needs_review':'unavailable',candidates:candidates.slice(0,8),
      reason:!parsed||parsed.uncertain?reason:pool.length?'No compatible product has an available, fresh comparable price':'No compatible product exists in this store catalogue'};
  });
}
export function summarizeLinks(links:Link[]){
  const names:Record<string,number>={}, occurrences:Record<string,number>={};
  for(const l of links){names[l.status]=(names[l.status]??0)+1;occurrences[l.status]=(occurrences[l.status]??0)+l.occurrences;}
  const totalOccurrences=links.reduce((n,l)=>n+l.occurrences,0);
  return {requirements:links.length,ingredientOccurrences:totalOccurrences,namesByStatus:names,occurrencesByStatus:occurrences,
    trackedFraction:1,matchedFraction:(occurrences.matched??0)/totalOccurrences,
    handledFraction:((occurrences.matched??0)+(occurrences.non_purchased??0))/totalOccurrences,
    matcherVersion:MATCHER_VERSION,correctnessCertified:false};
}

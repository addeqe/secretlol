import { createHash } from 'node:crypto';
import { FOOD_RULES } from './ingredient-vocabulary.ts';
import type { FoodRule } from './ingredient-vocabulary.ts';
import type { Entry } from './types.ts';

export type Requirement = { name: string; occurrences: number };
export type Pack = { label: string; quantity: number | null; unit: 'g' | 'ml' | 'piece' | null;
  drainedGrams: number | null; approximate: boolean };
export type Candidate = { code: string; name: string; brand: string | null; available: boolean;
  comparisonPriceOre: number | null; comparisonUnit: string; priceOre: number | null;
  priceUnit: string; pack: Pack; observedAt: string; expiresAt: string; eligible: boolean; exclusion: string | null };
export type Decision = { action: 'approve' | 'reject'; code: string; reason: string; reviewedAt: string;
  approvedCodes?: string[]; rejectedCodes?: string[]; basis?: FoodRule['basis'] };
export type Link = Requirement & { ingredientId: string; foodId: string | null;
  status: 'matched' | 'needs_review' | 'unavailable' | 'non_purchased';
  selectedCode: string | null; selectedProduct: Candidate | null; candidates: Candidate[];
  reason: string; method: string; review?: Decision; matchConfidence: number | null };
export const MATCHER_VERSION = 'willys-food-rules-1';
export const normalizeText = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[’']/g, '').replace(/[^a-z0-9%]+/g, ' ').trim().replace(/\s+/g, ' ');
const prep = /\b(?:finely|coarsely|freshly|chopped|diced|minced|sliced|grated|shredded|peeled|seeded|sifted|softened|melted|beaten|divided|packed|crushed|rinsed|drained|large|medium|small|optional)\b/g;
export function ingredientId(name: string) { return 'ing_' + createHash('sha256').update(name).digest('hex').slice(0,24); }
export function packInfo(entry: Entry): Pack {
  const label = typeof entry.raw?.displayVolume === 'string' ? entry.raw.displayVolume : '';
  const text = label.toLowerCase().replace(/,/g,'.').replace(/\s/g,'').replace(/^ca:?/, '');
  let quantity: number | null = null, unit: Pack['unit'] = null, drainedGrams: number | null = null;
  const weight = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(kg|g)$/.exec(text);
  const multi = /^(?:(\d+)x)?(\d+(?:\.\d+)?)(kg|g|ml|cl|dl|l|p|st|pack)$/.exec(text);
  if (weight) { const scale=weight[3]==='kg'?1000:1; quantity=Number(weight[1])*scale; drainedGrams=Number(weight[2])*scale;unit='g'; }
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
  let exclusion: string|null=null;
  if(!entry.available)exclusion='unavailable';
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
export function buildLinks(requirements: Requirement[], products: Entry[], reviews: Record<string,Decision>={}, now=Date.now()):Link[]{
  if(!requirements.length || new Set(requirements.map(r=>r.name)).size!==requirements.length ||
    requirements.some(r=>!r.name.trim() || !Number.isSafeInteger(r.occurrences) || r.occurrences<1))throw new Error('Invalid ingredient inventory');
  if(new Set(products.map(p=>p.code)).size!==products.length)throw new Error('Duplicate catalogue products');
  const byCode=new Map(products.map(p=>[p.code,p]));
  const pools=new Map<string,Entry[]>();
  for(const rule of FOOD_RULES){
    const title=new RegExp(rule.title), exclude=rule.exclude?new RegExp(rule.exclude):null;
    pools.set(rule.id,products.filter(p=>p.categories.some(c=>rule.categories.some(prefix=>normalizeText(c).startsWith(prefix))) &&
      title.test(normalizeText(p.name)) && (!exclude || !exclude.test(normalizeText(p.name)))));
  }
  return requirements.map(requirement=>{
    const name=normalizeText(requirement.name), parsed=classify(requirement.name);
    const base:Link={...requirement,ingredientId:ingredientId(requirement.name),foodId:parsed?.rule.id??null,
      status:'needs_review',reason:'',selectedCode:null,selectedProduct:null,candidates:[],method:'food_rules',matchConfidence:null};
    if(/^(?:(?:boiling|hot|cold|warm|ice|tap|filtered|lukewarm|distilled) )?water$|^ice cubes?$/.test(name) && !reviews[requirement.name]){
      return {...base,status:'non_purchased',reason:'Tap water/ice assumed; no retail SKU or exact water cost assigned'};
    }
    const review=reviews[requirement.name];
    let pool=parsed?pools.get(parsed.rule.id)??[]:[];
    if(parsed)pool=pool.filter(parsed.constraints);
    const basis=review?.basis??parsed?.rule.basis??'kg';
    let candidates=pool.map(p=>candidate(p,basis,now));
    const rejected=new Set(review?.rejectedCodes??(review?.action==='reject'?[review.code]:[]));
    const approvedCodes=new Set(review?.approvedCodes??(review?.action==='approve'?[review.code]:[]));
    for(const code of approvedCodes){
      const approved=byCode.get(code);
      if(approved && !candidates.some(c=>c.code===code))candidates.push(candidate(approved,basis,now));
    }
    candidates=candidates.filter(c=>!rejected.has(c.code));
    candidates.sort((a,b)=>Number(b.eligible)-Number(a.eligible) ||
      (a.comparisonPriceOre??Infinity)-(b.comparisonPriceOre??Infinity) || a.code.localeCompare(b.code));
    const selected=candidates.find(c=>c.eligible && (approvedCodes.has(c.code)||parsed&&!parsed.uncertain));
    const reason=!parsed?'No verified food rule; needs bilingual identity review':parsed.reason;
    if(selected){
      return {...base,review,status:'matched',method:approvedCodes.has(selected.code)?'reviewed':'food_rules',
        selectedCode:selected.code,selectedProduct:selected,candidates:candidates.slice(0,8),
        reason:approvedCodes.has(selected.code)?review!.reason:reason};
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

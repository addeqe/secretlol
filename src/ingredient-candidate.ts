import { calendarWeekEnd, scanIsCurrent } from './price-freshness.ts';
import type { Entry } from './types.ts';
import { productPolicy } from './dietary-policy.ts';
import { packInfo } from './product-pack.ts';
import type { FoodRule } from './ingredient-vocabulary.ts';

export type Candidate = { code: string; name: string; brand: string | null; available: boolean;
  comparisonPriceOre: number | null; comparisonUnit: string; priceOre: number | null;
  priceUnit: string; pack: ReturnType<typeof packInfo>; observedAt: string; expiresAt: string;
  eligible: boolean; exclusion: string | null };

export function candidateExpiry(entry: Pick<Entry,'observedAt'|'offers'>) {
  let until=calendarWeekEnd(Date.parse(entry.observedAt));
  for(const offer of entry.offers as Array<{validUntil?:number}>){
    if(typeof offer.validUntil==='number'&&offer.validUntil>Date.parse(entry.observedAt))until=Math.min(until,offer.validUntil);
  }
  return new Date(until).toISOString();
}

/** Pure, Worker-safe price/compatibility candidate projection shared with matching. */
export function candidate(entry: Entry, basis: FoodRule['basis'], now: number): Candidate {
  const pack=packInfo(entry); const priceUnit=entry.priceUnit.toLowerCase().replace(/\s/g,'');
  const compareUnit=entry.comparePriceUnit.toLowerCase().replace(/^kr\//,'').replace(/\s/g,'');
  let unitPrice: number|null=null;
  if(entry.priceOre!==null){
    if(priceUnit===`kr/${basis}`)unitPrice=entry.priceOre;
    else if(/^kr\/(?:st|styck|forp|förp|fp)$/.test(priceUnit)){
      const target=basis==='kg'?'g':basis==='l'?'ml':'piece';
      if(pack.unit===target&&pack.quantity&&!pack.approximate)unitPrice=entry.priceOre/pack.quantity*(basis==='piece'?1:1000);
      else if(entry.comparePriceOre!==null&&compareUnit===(basis==='piece'?'st':basis))unitPrice=entry.comparePriceOre;
    }
  }
  let exclusion:string|null=productPolicy(entry);
  if(!exclusion&&!entry.available)exclusion='unavailable';
  else if(!exclusion&&(entry.priceOre===null||entry.depositOre===null||unitPrice===null))exclusion='price_or_comparison_basis_unknown';
  else if(!exclusion&&(Date.parse(candidateExpiry(entry))<=now||!scanIsCurrent(Date.parse(entry.observedAt),now)))exclusion='stale_price';
  else if(!exclusion&&(entry.offers as Array<Record<string,unknown>>).some(o=>o.applied===true&&
    (Number(o.qualifyingCount)>1||o.campaignType&&o.campaignType!=='GENERAL')))exclusion='conditional_price';
  return {code:entry.code,name:entry.name,brand:entry.brand,available:entry.available,comparisonPriceOre:unitPrice,
    comparisonUnit:basis,priceOre:entry.priceOre,priceUnit:entry.priceUnit,pack,observedAt:entry.observedAt,
    expiresAt:candidateExpiry(entry),eligible:exclusion===null,exclusion};
}

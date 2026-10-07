// Conversions use the US customary recipe measures of the source dataset.
// Density, edible piece weight and optional quantities are never invented.
export type CostProduct={code:string;name:string;brand:string|null;priceOre:number|null;priceUnit:string;depositOre:number|null;available:boolean;observedAt:string;expiresAt:string;pack?:{quantity:number|null;unit:string|null;approximate:boolean;drainedGrams:number|null}};
export type IngredientAmount={ingredient_original:string;unit:string;measured_quantity:string|number|null;amount_kind?:string|null;qualitative_amount?:string|null;quantity_conflict?:number|null};
export type AmountOverride={unit:'g'|'ml'|'piece';quantity:number};
const MASS:Record<string,number>={g:1,gram:1,grams:1,kg:1000,kilogram:1000,kilograms:1000,mg:0.001,oz:28.349523125,ounce:28.349523125,ounces:28.349523125,lb:453.59237,lbs:453.59237,pound:453.59237,pounds:453.59237};
const VOLUME:Record<string,number>={ml:1,milliliter:1,milliliters:1,l:1000,liter:1000,liters:1000,dl:100,cl:10,teaspoon:4.92892159375,teaspoons:4.92892159375,tsp:4.92892159375,tablespoon:14.78676478125,tablespoons:14.78676478125,tbsp:14.78676478125,cup:236.5882365,cups:236.5882365,'fluid ounce':29.5735295625,'fluid ounces':29.5735295625,'fl oz':29.5735295625,fluid_ounce:29.5735295625,pint:473.176473,quart:946.352946,gallon:3785.411784};
const PIECES=new Set(['count','piece','pieces','each','item','items','egg','eggs']);
function number(value:unknown):number|null{
  if(typeof value==='number')return Number.isFinite(value)&&value>0?value:null;
  if(typeof value!=='string'||!value.trim())return null;
  const s=value.trim();if(/^[0-9]+(?:\.[0-9]+)?$/.test(s)){const n=Number(s);return n>0?n:null;}
  const m=/^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(s);if(m&&Number(m[3]))return Number(m[1]??0)+Number(m[2])/Number(m[3]);return null;
}
export function canonicalAmount(ingredient:IngredientAmount,scale=1,override?:AmountOverride){
  const quantity=override?.quantity??number(ingredient.measured_quantity);
  if(quantity===null||quantity===undefined)return {amount:null,reason:'quantity_unknown_or_qualitative'};
  if(!override&&ingredient.quantity_conflict)return {amount:null,reason:'conflicting_source_quantity'};
  const unit=(override?.unit??ingredient.unit).trim().toLowerCase();
  if(unit==='piece'||PIECES.has(unit))return {amount:{unit:'piece',quantity:quantity*scale},reason:null};
  if(MASS[unit])return {amount:{unit:'g',quantity:quantity*scale*MASS[unit]},reason:null};
  if(VOLUME[unit])return {amount:{unit:'ml',quantity:quantity*scale*VOLUME[unit]},reason:null};
  if(unit==='dozen')return {amount:{unit:'piece',quantity:quantity*scale*12},reason:null};
  return {amount:null,reason:'unit_conversion_unknown'};
}
export function calculateLine(ingredient:IngredientAmount,product:CostProduct|null,status:string,scale:number,override?:AmountOverride){
  if(status==='non_purchased')return {status:'not_purchased',consumedCostOre:0,amount:null,reason:null,product:null};
  if(status!=='matched'||!product)return {status:'unresolved',consumedCostOre:null,amount:null,reason:'ingredient_connection_unavailable',product};
  if(!product.available||!Number.isFinite(Date.parse(product.expiresAt))||Date.parse(product.expiresAt)<=Date.now()||Date.parse(product.observedAt)>Date.now()+60000)return {status:'unresolved',consumedCostOre:null,amount:null,reason:'product_unavailable_or_stale',product};
  if(product.priceOre===null||product.priceOre<0||product.depositOre===null)return {status:'unresolved',consumedCostOre:null,amount:null,reason:'price_unknown',product};
  const converted=canonicalAmount(ingredient,scale,override);
  if(!converted.amount)return {status:'unresolved',consumedCostOre:null,...converted,product};
  const amount=converted.amount,unit=product.priceUnit.replace(/\s+/g,'').toLowerCase();let cost:number|null=null;
  if(unit==='kr/kg'&&amount.unit==='g'||unit==='kr/l'&&amount.unit==='ml')cost=product.priceOre*amount.quantity/1000;
  if(/^kr\/(st|styck|forp|förp|fp)$/.test(unit)&&product.pack?.quantity&&product.pack.unit===amount.unit&&!product.pack.approximate){
    if(product.pack.drainedGrams!==null&&amount.unit==='g')return {status:'unresolved',consumedCostOre:null,amount,reason:'drained_weight_basis_requires_review',product};
    cost=product.priceOre*amount.quantity/product.pack.quantity;
  }
  if(cost===null)return {status:'unresolved',consumedCostOre:null,amount,reason:amount.unit==='ml'&&product.pack?.unit==='g'?'density_required':amount.unit==='piece'&&product.pack?.unit==='g'?'piece_weight_required':'package_or_unit_conversion_unknown',product};
  return {status:'priced',consumedCostOre:cost,amount,reason:null,product};
}
export function aggregateShopping(lines:Array<ReturnType<typeof calculateLine>>){
  const groups=new Map<string,{product:CostProduct;unit:string;quantity:number;consumedCostOre:number}>();
  for(const l of lines)if(l.status==='priced'&&l.product&&l.amount&&l.consumedCostOre!==null){
    const k=l.product.code+':'+l.amount.unit;const old=groups.get(k);
    if(old){old.quantity+=l.amount.quantity;old.consumedCostOre+=l.consumedCostOre;}
    else groups.set(k,{product:l.product,unit:l.amount.unit,quantity:l.amount.quantity,consumedCostOre:l.consumedCostOre});
  }
  return [...groups.values()].map(g=>{
    const p=g.product,pricedByWeight=/^kr\/(kg|l)$/.test(p.priceUnit.replace(/\s/g,'').toLowerCase());
    const packs=!pricedByWeight&&p.pack?.unit===g.unit&&p.pack.quantity&&!p.pack.approximate?Math.ceil(g.quantity/p.pack.quantity):null;
    return {willysItemId:p.code,name:p.name,brand:p.brand,amount:{unit:g.unit,quantity:g.quantity},consumedCostOre:Math.round(g.consumedCostOre),packs,
      purchaseCostOre:packs!==null?packs*p.priceOre!:pricedByWeight?Math.round(g.consumedCostOre):null,
      depositOre:packs!==null?packs*p.depositOre!:pricedByWeight&&p.depositOre===0?0:null,priceOre:p.priceOre,priceUnit:p.priceUnit,
      observedAt:p.observedAt,expiresAt:p.expiresAt,approximate:p.pack?.approximate??false};
  });
}
export const conversionPolicy={recipeVolumeConvention:'US customary',mass:'exact standard unit conversions',volumeToMass:'requires an explicit amount override; no assumed density',pieceToMass:'requires an explicit amount override; no assumed edible piece weight',unknownQuantity:'unresolved; never treated as zero',rounding:'öre totals rounded after adding unrounded ingredient costs',conditionalOffers:'not assumed',certifiedAccuracy:false};

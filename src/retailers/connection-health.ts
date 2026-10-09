import { approvedObservations, productIdentity, type ReviewedConnection } from './identity.ts';
import type { ProductObservation, RetailerId, StoreScope } from './types.ts';
export type ConnectionHealth = {ingredientId:string;name:string;status:'matched'|'needs_review'|'unavailable'|'non_purchased';productId:string|null;reason:string};
export function connectionHealth(c:ReviewedConnection,observations:ProductObservation[],retailer:RetailerId,scope:StoreScope,now=Date.now()):ConnectionHealth {
  const base={ingredientId:c.ingredientId,name:c.name};
  if(c.status!=='matched')return {...base,status:c.status,productId:null,reason:c.reason};
  const usable=approvedObservations(c,observations,retailer,scope,now).filter(o=>o.price?.depositOre!==null);
  const knownUnits=new Set(usable.map(o=>o.price!.basis==='kg'?'g':o.price!.basis==='l'?'ml':o.product.pack?.unit??'unknown'));
  const cost=(o:ProductObservation)=>o.price!.basis==='pack'?(o.product.pack&&!o.product.pack.approximate?o.price!.amountOre/o.product.pack.quantity:Infinity):o.price!.amountOre/1000;
  usable.sort((a,b)=>knownUnits.size===1 ? cost(a)-cost(b)||a.product.id.localeCompare(b.product.id) : Number(b.product.id===c.mainProductId)-Number(a.product.id===c.mainProductId)||a.product.id.localeCompare(b.product.id));
  const selected=usable.find(o=>Number.isFinite(cost(o)));
  if(selected)return {...base,status:'matched',productId:selected.product.id,reason:selected.product.id===c.mainProductId?'approved_main_available':'approved_alternative_available'};
  const byId=new Map(observations.map(o=>[o.product.id,o]));
  const changed=c.approvedProducts.some(p=>byId.has(p.productId)&&productIdentity(byId.get(p.productId)!.product)!==p.identity);
  return {...base,status:changed?'needs_review':'unavailable',productId:null,
    reason:changed?'product_identity_changed_review_required':'no_fresh_public_price_for_approved_product'};
}

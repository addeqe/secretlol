import type { ProductObservation, RetailCategory, RetailClient, RetailPage, StoreScope } from './types.ts';
import { RetailerUnsupportedError, scopeKey, validateScope } from './types.ts';
import { validateObservation } from './identity.ts';
function leaves(categories: RetailCategory[]): RetailCategory[] {
  const found:RetailCategory[]=[];
  const definitions=new Map<string,string>(),active=new Set<string>(),leafIds=new Set<string>();
  let visits=0;
  function visit(c:RetailCategory) {
    if (!c.id || active.has(c.id)) throw new Error('duplicate_category_or_cycle');
    if(++visits>50000||active.size>=100)throw new Error('category_tree_budget');
    const definition=JSON.stringify([c.name,c.children.map(child=>child.id).sort()]);
    if(definitions.has(c.id)&&definitions.get(c.id)!==definition)throw new Error('conflicting_category_definition');
    definitions.set(c.id,definition);active.add(c.id);
    // Coop links the same category under more than one navigation parent.
    // Validate every occurrence, but fetch each leaf only once.
    if (c.children.length)c.children.forEach(visit);
    else if(!leafIds.has(c.id)){leafIds.add(c.id);found.push(c);}
    active.delete(c.id);
  }
  categories.forEach(visit);return found;
}
export async function collectReference(client: RetailClient, scope: StoreScope,
  options: { maxPages?:number; maxProducts?:number; onPage?:(page:RetailPage)=>void }={}) {
  validateScope(scope);
  if (!client.capabilities.categories || !client.capabilities.browse || !client.capabilities.verifiedStorePricing) {
    throw new RetailerUnsupportedError(client.retailer,'complete_store_scan');
  }
  const maxPages=options.maxPages??1000,maxProducts=options.maxProducts??50000;
  if (!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>10000||!Number.isSafeInteger(maxProducts)||maxProducts<1||maxProducts>100000) throw new Error('invalid_collection_budget');
  const products=new Map<string,ProductObservation>(),report=[];let pages=0;
  const categories=leaves(await client.categories(scope));if(!categories.length)throw new Error('empty_category_tree');
  for(const category of categories){
    let cursor:string|undefined, total:number|null|undefined;const seenCursors=new Set<string>(),categoryIds=new Set<string>();let categoryPages=0;
    do{
      if(pages>=maxPages)throw new Error('collection_page_budget');
      const page=await client.browse(scope,category.id,cursor);pages++;categoryPages++;
      if(page.categoryId!==category.id||scopeKey(client.retailer,page.scope)!==scopeKey(client.retailer,scope))throw new Error('category_scope_changed');
      if(page.total!==null&&(!Number.isSafeInteger(page.total)||page.total<0))throw new Error('invalid_category_total');
      if(total!==undefined&&page.total!==total)throw new Error('category_total_changed');total=page.total;
      if(!page.products.length&&page.nextCursor!==null)throw new Error('empty_page_with_cursor');
      for(const o of page.products){
        validateObservation(o,client.retailer,scope);
        if(categoryIds.has(o.product.id))throw new Error('duplicate_product_in_category');
        categoryIds.add(o.product.id);const old=products.get(o.product.id);
        const comparable=(p:ProductObservation)=>JSON.stringify({...p,product:{...p.product,categories:[]},checkedAt:'',expiresAt:''});
        if(old&&comparable(old)!==comparable(o))throw new Error('product_changed_during_scan');
        products.set(o.product.id,old?{...o,product:{...o.product,categories:[...new Set([...old.product.categories,...o.product.categories])].sort()},
          checkedAt:new Date(Math.min(Date.parse(old.checkedAt),Date.parse(o.checkedAt))).toISOString(),
          expiresAt:new Date(Math.min(Date.parse(old.expiresAt),Date.parse(o.expiresAt))).toISOString()}:o);
        if(products.size>maxProducts)throw new Error('collection_product_budget');
      }
      options.onPage?.(page);
      if(page.nextCursor!==null){if(!page.nextCursor||seenCursors.has(page.nextCursor))throw new Error('pagination_cursor_loop');seenCursors.add(page.nextCursor);}
      cursor=page.nextCursor??undefined;
    }while(cursor!==undefined);
    if(total!==null&&categoryIds.size!==total)throw new Error('incomplete_category');
    report.push({categoryId:category.id,name:category.name,total:total??null,collected:categoryIds.size,pages:categoryPages});
  }
  if(!products.size)throw new Error('empty_reference_catalogue');
  return {retailer:client.retailer,scope,products:[...products.values()],categories:report,pages};
}
export async function collectTracked(client:RetailClient,scope:StoreScope,ids:string[],batchSize=25){
  validateScope(scope);
  if(!client.capabilities.productLookup||!client.capabilities.verifiedStorePricing)throw new RetailerUnsupportedError(client.retailer,'tracked_store_prices');
  const unique=[...new Set(ids)].sort();if(!unique.length||unique.length>5000||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>100)throw new Error('invalid_tracked_collection');
  const size=client.capabilities.batchLookup?batchSize:1,observations:ProductObservation[]=[];
  for(let i=0;i<unique.length;i+=size){
    const group=unique.slice(i,i+size),found=await client.products(scope,group);
    if(found.length!==group.length||new Set(found.map(o=>o.product.id)).size!==group.length||found.some(o=>!group.includes(o.product.id)))throw new Error('incomplete_tracked_refresh');
    for(const o of found)validateObservation(o,client.retailer,scope);observations.push(...found);
  }
  return observations;
}

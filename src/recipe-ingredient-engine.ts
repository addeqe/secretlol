import{createHash}from'node:crypto';
import{createIngredientMatcher,normalizeText,reviewAttributeExclusion,MATCHER_VERSION}from'./ingredient-matching.ts';
import type{Link,Decision}from'./ingredient-matching.ts';
import{DIETARY_POLICY_VERSION,ingredientPolicy,productPolicy}from'./dietary-policy.ts';
import{loadAssessments}from'./ingredient-assessments.ts';
import{referenceAmount,amountConversionVersion}from'./meal-conversions.ts';
import type{Entry}from'./types.ts';
import{packInfo}from'./product-pack.ts';
import retailCounts from'../offline/assets/retail-item-counts.json' with{type:'json'};
import equivalences from'../offline/assets/product-equivalences.json' with{type:'json'};

export const RECIPE_ENGINE_VERSION='local-recipe-ingredients-1';
export type ParsedLine={raw:string;name:string|null;query:string|null;names:string[];
  status:string;amount:{quantity:number;unit:string}|null;size:string|null;preparation:string|null;
  sourceAmount?:{quantity:number;unit:string}|null;preparedBeforeMeasurement?:boolean;
  selectionSource?:string;amountEvidence?:{method:string}};
export type RecipeMatch={status:string;reason:string;foodId:string|null;selectedCode:string|null;
  selectedProduct:Link['selectedProduct'];amount:{quantity:number;unit:'g'|'ml'|'piece'}|null;
  conversion:unknown;policy:ReturnType<typeof ingredientPolicy>&{version:string};method:string;
  productEvidence?:{sources:string[];allergensPresent:string[];allergensMayContain:string[]}};
export function createRecipeEngine(products:Entry[],reviews:Record<string,Decision>,asOf:number){
  if(!products.length||!Number.isFinite(asOf))throw new Error('Invalid offline catalogue/evaluation time');
  const assessed=loadAssessments();
  const localReviews={...reviews},localAssessments={...assessed.records};
  const equivalenceByCode=new Map<string,typeof equivalences.products[number]>();
  for(const review of equivalences.products){
    const product=products.find(p=>p.code===review.code&&p.name===review.name&&p.brand===review.brand&&p.raw?.displayVolume===review.displayVolume);
    if(!product)continue;
    equivalenceByCode.set(product.code,review);
    for(const alias of review.aliases){
      for(const name of Object.keys(localReviews))if(normalizeText(name)===normalizeText(alias))delete localReviews[name];
      for(const name of Object.keys(localAssessments))if(normalizeText(name)===normalizeText(alias))delete localAssessments[name];
      localReviews[alias]={action:'approve',code:product.code,basis:review.basis as 'kg'|'l'|'piece',
        reason:review.reason,reviewedAt:equivalences.reviewedAt};
    }
  }
  const aliases=new Map<string,string|null>();
  for(const name of [...Object.keys(localAssessments),...Object.keys(localReviews)]){
    const key=normalizeText(name),previous=aliases.get(key);
    aliases.set(key,previous===undefined||previous===name?name:null);
  }
  // Reject unusable retail cost metadata before choosing the cheapest item,
  // so a valid alternative may win instead of stopping at an unpriceable SKU.
  const costable=products.filter(p=>{
    const pack=packInfo(p),unit=p.priceUnit.replace(/\s/g,'').toLowerCase();
    return !(/^kr\/(?:st|styck)$/.test(unit)&&!pack.quantity&&/^(?:kr\/)?(?:kg|l)$/.test((p.comparePriceUnit??'').replace(/\s/g,'').toLowerCase()));
  });
  const match=createIngredientMatcher(costable,localReviews,asOf,localAssessments);
  const byCode=new Map(products.map(p=>[p.code,p]));
  const cache=new Map<string,Link>();
  const getLink=(query:string)=>{
    const key=aliases.get(normalizeText(query))??query;
    let result=cache.get(key);
    if(!result){result=match([{name:key,occurrences:1}])[0];cache.set(key,result);
      if(cache.size>10000)cache.delete(cache.keys().next().value!);}
    return result;
  };
  function evaluate(line:ParsedLine):RecipeMatch{
    const policy={...ingredientPolicy(line.raw),version:DIETARY_POLICY_VERSION};
    const base:RecipeMatch={status:'needs_review',reason:line.status,foodId:null,selectedCode:null,
      selectedProduct:null,amount:null,conversion:null,policy,method:'existing_willys_rules'};
    if(policy.blockedReason)return{...base,status:'excluded',reason:policy.blockedReason};
    for(const name of line.names){const p=ingredientPolicy(name);if(p.blockedReason)return{...base,status:'excluded',reason:p.blockedReason,policy:{...p,version:DIETARY_POLICY_VERSION}};}
    if(line.status!=='parsed'||!line.query||!line.name)return base;
    const link=getLink(line.query);
    let linked:RecipeMatch={...base,status:link.status,reason:link.reason,foodId:link.foodId,policy:link.dietaryPolicy,
      selectedCode:link.selectedCode,selectedProduct:link.selectedProduct,method:link.method};
    if(!['matched','non_purchased'].includes(link.status))return linked;
    if(link.selectedCode){
      const p=byCode.get(link.selectedCode)!;
      let selectedSource=line.selectionSource??line.raw;
      if(line.amountEvidence?.method==='US-customary-butter-stick')selectedSource=selectedSource.replace(/^\s*[\d\s./]+\s+sticks?\s+/i,'');
      const exclusion=productPolicy(p,line.query)||productPolicy(p,selectedSource)||reviewAttributeExclusion(line.query,p)||reviewAttributeExclusion(selectedSource,p);
      if(exclusion)return{...linked,status:'needs_review',reason:exclusion,selectedCode:null,selectedProduct:null};
      if(/\b(?:lemon|lime|orange) juice\b/i.test(line.query)&&!/juice|pressad|koncentrat/i.test(p.name))
        return{...linked,status:'needs_review',reason:'Whole-fruit juice yield must be established before costing'};
      if(/\bi kruka\b|\bpotted\b/i.test(p.name))
        return{...linked,status:'needs_review',reason:'Edible herb yield of a potted plant is not established'};
      const count=retailCounts.products.find(r=>r.code===p.code&&r.name===p.name&&
        r.displayVolume===p.raw?.displayVolume&&r.foodId===link.foodId);
      if(line.amount?.unit==='piece'&&count&&/^(?:piece|item|count|)$/i.test(line.sourceAmount?.unit??'piece')&&
          /^kr\/(?:st|styck)$/.test(p.priceUnit.replace(/\s/g,'').toLowerCase())&&p.priceOre!==null){
        const c=link.selectedProduct!;
        linked={...linked,selectedProduct:{...c,comparisonUnit:'piece',comparisonPriceOre:p.priceOre/count.count,
          pack:{...c.pack,quantity:count.count,unit:'piece',approximate:false}}};
        return{...linked,amount:{quantity:line.amount.quantity,unit:'piece'},
          conversion:{method:'reviewed-retail-item-count',countPerPack:count.count,
            originalPack:c.pack,source:retailCounts.provenance}};
      }
      const equivalence=equivalenceByCode.get(p.code);
      if(equivalence)linked={...linked,productEvidence:{sources:equivalence.sources,
        allergensPresent:equivalence.allergensPresent,allergensMayContain:equivalence.allergensMayContain}};
      const c=linked.selectedProduct!;
      const target=c.comparisonUnit==='kg'?'g':c.comparisonUnit==='l'?'ml':'piece';
      const byWeight=p.priceUnit.replace(/\s/g,'').toLowerCase()===`kr/${c.comparisonUnit}`;
      if(c.pack.drainedGrams!==null)return{...linked,status:'needs_review',reason:'drained_weight_basis_requires_review'};
      // A labelled approximate produce weight is a usable price estimate. The
      // label and approximate flag remain in the document; missing weights do not.
      if(!byWeight&&(!c.pack.quantity||c.pack.unit!==target))return{...linked,status:'needs_review',reason:'package_cost_basis_unverified'};
    }
    if(!line.amount)return{...linked,status:'amount_unresolved',reason:'No explicit, unambiguous numeric quantity'};
    const a=line.amount;
    if(!Number.isFinite(a.quantity)||a.quantity<=0||a.quantity>10000000||!['g','ml','piece'].includes(a.unit))return{...linked,status:'amount_unresolved',reason:'Invalid canonical source amount'};
    if(link.status==='non_purchased')return{...linked,amount:{quantity:a.quantity,unit:a.unit as 'g'|'ml'|'piece'}};
    const target=link.selectedProduct!.comparisonUnit==='kg'?'g':link.selectedProduct!.comparisonUnit==='l'?'ml':'piece';
    if(a.unit===target)return{...linked,amount:{quantity:a.quantity,unit:target}};
    if(target==='g'){
      // Qualifiers remain in the lookup: cooked/drained food must never inherit
      // the density or piece weight of an unqualified/raw ingredient.
      const sourceName=[line.size,line.query,line.preparation].filter(Boolean).join(' ');
      const sourceAmount=line.sourceAmount??a;
      const reference=referenceAmount(sourceName,sourceAmount.unit,sourceAmount.quantity);
      if(reference)return{...linked,amount:reference.amount,conversion:reference.evidence};
    }
    return{...linked,status:'amount_unresolved',reason:`No verified ${a.unit}-to-${target} conversion`};
  }
  return{evaluate,policy:(text:string)=>ingredientPolicy(text),metadata:{engineVersion:RECIPE_ENGINE_VERSION,
    matcherVersion:MATCHER_VERSION,policyVersion:DIETARY_POLICY_VERSION,amountConversionVersion,
    reviewHash:assessed.report.assessmentHash,asOf:new Date(asOf).toISOString()}};
}

import { DIETARY_POLICY_VERSION, ingredientPolicy, productPolicy } from '../dietary-policy.ts';
import type { ProductObservation, RetailProduct, RetailerId, StoreScope } from './types.ts';
import { productId, scopeKey, validateScope } from './types.ts';
export type ReviewedConnection = { ingredientId: string; name: string; foodId: string | null;
  status: 'matched' | 'needs_review' | 'unavailable' | 'non_purchased';
  mainProductId: string | null; approvedProducts: Array<{ productId: string; identity: string }>;
  policyVersion: string; reviewedAt: string; reason: string };
type ProductIdentityCacheEntry = { id: string; ean: string|null; name: string; brand: string|null;
  categories: string[]; pack: [number, string, boolean, number|null]|null; ingredientsText: string|null; identity: string };
const productIdentityCache = new WeakMap<RetailProduct, ProductIdentityCacheEntry>();
const policyProductCache = new WeakMap<object, { name: string; brand: string|null;
  ingredientsText: string|null; categories: string[];
  results: Map<string, string|null> }>();
const ingredientPolicyCache = new Map<string, ReturnType<typeof ingredientPolicy>>();

export function cachedIngredientPolicy(name: string) {
  const key = `${DIETARY_POLICY_VERSION}\0${name}`;
  const cached = ingredientPolicyCache.get(key);
  if (cached) { ingredientPolicyCache.delete(key); ingredientPolicyCache.set(key, cached); return cached; }
  const result = ingredientPolicy(name);
  if (ingredientPolicyCache.size >= 512) ingredientPolicyCache.delete(ingredientPolicyCache.keys().next().value!);
  ingredientPolicyCache.set(key, result);
  return result;
}

export function productIdentity(product: RetailProduct): string {
  const cached = productIdentityCache.get(product);
  const pack = product.pack ? [product.pack.quantity, product.pack.unit,
    product.pack.approximate, product.pack.drainedGrams ?? null] as [number,string,boolean,number|null] : null;
  if (cached && cached.id === product.id && cached.ean === product.ean && cached.name === product.name
    && cached.brand === product.brand && cached.ingredientsText === product.ingredientsText
    && (cached.pack === null) === (pack === null)
    && cached.pack?.[0] === pack?.[0] && cached.pack?.[1] === pack?.[1]
    && cached.pack?.[2] === pack?.[2] && cached.pack?.[3] === pack?.[3]
    && cached.categories.length === product.categories.length
    && cached.categories.every((category, index) => category === product.categories[index])) return cached.identity;
  // Checkpoints and JSON exports may reorder object keys. Identity must depend
  // on package values, while still noticing genuine size/drained-weight changes.
  const categories = [...product.categories], identity = JSON.stringify([product.id, product.ean, product.name, product.brand,
    [...categories].sort(), pack, product.ingredientsText]);
  productIdentityCache.set(product, { id: product.id, ean: product.ean, name: product.name, brand: product.brand,
    categories, pack, ingredientsText: product.ingredientsText, identity });
  return identity;
}
/** Apply the owner policy to both the package title and disclosed ingredients. */
export function reviewedProductPolicy(product: Pick<RetailProduct, 'name'|'brand'|'categories'|'ingredientsText'>, ingredientName?: string): string | null {
  const categories = product.categories ?? [];
  const productCache = policyProductCache.get(product);
  const sameProduct = productCache?.name === product.name && productCache.brand === product.brand
    && productCache.ingredientsText === product.ingredientsText && productCache.categories.length === categories.length
    && productCache.categories.every((category, index) => category === categories[index]);
  const resultKey = `${DIETARY_POLICY_VERSION}\0${ingredientName ?? ''}`;
  if (sameProduct && productCache.results.has(resultKey)) return productCache.results.get(resultKey)!;
  const titleReason = productPolicy(product, ingredientName);
  if (titleReason) return remember(titleReason);
  const text = product.ingredientsText?.trim();
  if (!text) return remember(null);
  const normalized = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const eggOnlyHenWording = /\b(?:egg|eggs|egg yolk|agg|aggula|aeg)\b/.test(normalized)
    && !/\b(?:chicken|kyckling\w*|poultry|h[oö]n(?:s)?k[oö]tt)\b/.test(normalized);
  const policyText = eggOnlyHenWording ? normalized.replace(/\b(?:hons|hens?)\b/g, ' ') : text;
  const ingredientReason = cachedIngredientPolicy(policyText).blockedReason;
  if (ingredientReason) return remember(`product_excluded_ingredient_${ingredientReason}`);
  if (/\b(?:ystenzym|lope|rennet)\b/.test(normalized)
    && !/\b(?:mikrobiell\w*|microbial\w*|vegetabilisk\w*|vegetable\s+rennet)\b/.test(normalized)) {
    return remember('product_excluded_uncertain_animal_source');
  }
  const disclosedMeatReason = productPolicy({ name: policyText, brand: product.brand, categories: [] }, ingredientName);
  return remember(disclosedMeatReason?.includes('meat_brand_not_permitted')
    ? 'product_excluded_ingredient_meat_brand_not_permitted' : null);
  function remember(reason: string|null) {
    const results = sameProduct ? productCache.results : new Map<string, string|null>();
    if (results.size >= 16) results.delete(results.keys().next().value!);
    results.set(resultKey, reason);
    policyProductCache.set(product, { name: product.name, brand: product.brand,
      ingredientsText: product.ingredientsText ?? null, categories: [...categories], results });
    return reason;
  }
}
export function observationUsable(observation: ProductObservation, retailer: RetailerId, scope: StoreScope,
  now = Date.now()): boolean {
  const checked = Date.parse(observation.checkedAt), expires = Date.parse(observation.expiresAt);
  const price = observation.price;
  return observation.retailer === retailer && scopeKey(retailer, observation.scope) === scopeKey(retailer, scope)
    && observation.storeScopeVerified && observation.availability === 'available'
    && Number.isFinite(checked) && checked <= now + 60000 && Number.isFinite(expires) && expires > now
    && now - checked < 86400000 && !!price && Number.isSafeInteger(price.amountOre) && price.amountOre >= 0
    && !price.memberOnly && (price.minimumQuantity === null || price.minimumQuantity <= 1)
    && (!price.validFrom || Date.parse(price.validFrom) <= now)
    && (!price.validUntil || Date.parse(price.validUntil) > now);
}
export function approvedObservations(connection: ReviewedConnection, observations: ProductObservation[],
  retailer: RetailerId, scope: StoreScope, now = Date.now()): ProductObservation[] {
  if (connection.status !== 'matched' || connection.policyVersion !== DIETARY_POLICY_VERSION
    || cachedIngredientPolicy(connection.name).blockedReason) return [];
  const approved = new Map(connection.approvedProducts.map(p => [p.productId, p.identity]));
  return observations.filter(o => approved.has(o.product.id) && observationUsable(o, retailer, scope, now)
    && approved.get(o.product.id) === productIdentity(o.product) && !reviewedProductPolicy(o.product, connection.name));
}
export function validateObservation(o: ProductObservation, retailer: RetailerId, scope: StoreScope): void {
  validateScope(o.scope);
  if (o.retailer !== retailer || scopeKey(retailer, o.scope) !== scopeKey(retailer, scope)
    || (!o.storeScopeVerified && !(o.identityEvidence?.status === 'prior' && o.price === null && o.availability === 'unknown'))
    || !productId(o.product.id) || !o.product.name?.trim()
    || !['available', 'unavailable', 'unknown'].includes(o.availability)
    || !Number.isFinite(Date.parse(o.checkedAt)) || !Number.isFinite(Date.parse(o.expiresAt))
    || Date.parse(o.expiresAt) <= Date.parse(o.checkedAt)
    || Date.parse(o.expiresAt) - Date.parse(o.checkedAt) > 86400000) throw new Error('invalid_product_observation');
  if (o.identityEvidence !== undefined && (o.identityEvidence.status !== 'prior'
    || !Number.isFinite(Date.parse(o.identityEvidence.lastVerifiedAt))
    || Date.parse(o.identityEvidence.lastVerifiedAt) > Date.parse(o.checkedAt) + 60000
    || o.price !== null || o.availability !== 'unknown')) throw new Error('invalid_prior_product_identity_evidence');
  if (o.price && (!Number.isSafeInteger(o.price.amountOre) || o.price.amountOre < 0
    || !['pack','kg','l'].includes(o.price.basis)
    || o.price.depositOre !== null && (!Number.isSafeInteger(o.price.depositOre) || o.price.depositOre < 0)
    || o.price.minimumQuantity !== null && (!Number.isSafeInteger(o.price.minimumQuantity) || o.price.minimumQuantity < 1)
    || o.price.validFrom !== null && !Number.isFinite(Date.parse(o.price.validFrom))
    || o.price.validUntil !== null && !Number.isFinite(Date.parse(o.price.validUntil)))) throw new Error('invalid_product_price');
  if (o.product.pack && (!Number.isFinite(o.product.pack.quantity) || o.product.pack.quantity <= 0
    || !['g','ml','piece'].includes(o.product.pack.unit)
    || o.product.pack.drainedGrams!==undefined&&o.product.pack.drainedGrams!==null
      && (!Number.isFinite(o.product.pack.drainedGrams)||o.product.pack.drainedGrams<=0))) throw new Error('invalid_product_pack');
}
export function validateConnections(connections: ReviewedConnection[], products: RetailProduct[]): void {
  if (!connections.length || new Set(connections.map(c=>c.ingredientId)).size !== connections.length
    || new Set(connections.map(c=>c.name)).size !== connections.length) throw new Error('invalid_connection_inventory');
  const catalog = new Map(products.map(p=>[p.id,p]));
  for (const c of connections) {
    if (!c.ingredientId || !c.name?.trim() || c.policyVersion !== DIETARY_POLICY_VERSION
      || !Number.isFinite(Date.parse(c.reviewedAt)) || !c.reason?.trim()
      || !['matched','needs_review','unavailable','non_purchased'].includes(c.status)
      || cachedIngredientPolicy(c.name).blockedReason) throw new Error('invalid_connection_review');
    if (c.status === 'non_purchased' && !/^(?:(?:boiling|hot|cold|warm|ice|tap|filtered|lukewarm|distilled) )?water$|^ice cubes?$/i.test(c.name)) {
      throw new Error('non_purchased_requires_water');
    }
    if (c.status !== 'matched' && (c.mainProductId !== null || c.approvedProducts.length)) throw new Error('unmatched_connection_has_products');
    if (c.status === 'matched' && (!c.mainProductId || c.approvedProducts.length < 1 || c.approvedProducts.length > 3
      || !c.approvedProducts.some(p=>p.productId===c.mainProductId)
      || new Set(c.approvedProducts.map(p=>p.productId)).size !== c.approvedProducts.length)) throw new Error('invalid_approved_products');
    for (const p of c.approvedProducts) {
      const source = catalog.get(p.productId);
      if (!source || p.identity !== productIdentity(source) || reviewedProductPolicy(source,c.name)) throw new Error('connection_product_not_permitted');
    }
  }
}

// V8 defers expensive policy-regex compilation until first use. Do this small,
// pure initialization within the Worker's startup budget, before serving requests.
reviewedProductPolicy({ name: 'water', brand: null, categories: [], ingredientsText: 'water' }, 'water');

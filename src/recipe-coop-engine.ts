import { ingredientPolicy, productPolicy, DIETARY_POLICY_VERSION } from './dietary-policy.ts';
import { referenceAmount, amountConversionVersion } from './meal-conversions.ts';
import { reviewAttributeExclusion } from './ingredient-matching.ts';
import { FOOD_RULES } from './ingredient-vocabulary.ts';
import { observationUsable, productIdentity, reviewedProductPolicy, validateObservation } from './retailers/identity.ts';
import type { ReviewedConnection } from './retailers/identity.ts';
import type { ProductObservation, RetailProduct, StoreScope } from './retailers/types.ts';
import type { ParsedLine } from './recipe-ingredient-engine.ts';
import { scanIsCurrent } from './price-freshness.ts';

type CoopReviewedDataset = {
  retailer: 'coop'; datasetId: string; inventoryHash: string; scope: StoreScope;
  observations: ProductObservation[]; connections: ReviewedConnection[];
  productFormReviews?: ProductFormReview[];
};
type ProductFormReview = { foodId: string; productId: string; productIdentity: string; form: 'dried';
  reviewedAt: string; sourceSha256: string; reason: string };
type LiveProduct = { retailer: 'coop'; productId: string; productIdentity: string;
  identityHash?: string; status: string; checkedAt?: string; nutritionSource?: RetailProduct['nutritionSource'] | null;
  observation?: ProductObservation };
type LiveCollection = { schemaVersion: 1; retailer: 'coop'; mode: 'live'; datasetId: string;
  inventoryHash: string; scope: StoreScope; source?: { inputSha256?: string };
  products: LiveProduct[] };

export type CoopRecipeEvaluation = {
  retailer: 'coop';
  status: 'matched' | 'amount_unresolved' | 'needs_review' | 'excluded' | 'non_purchased';
  reason: string;
  foodId: string | null;
  productId: string | null;
  selectedProduct: null | {
    id: string; name: string; brand: string | null; categories: string[];
    pack: RetailProduct['pack']; ingredientsText: string | null;
    eligible: true; priceEligible: boolean; price: ProductObservation['price'] | null;
    priceAmount: { quantity: number; unit: 'g' | 'ml' | 'piece' } | null; nutritionEligible: boolean;
    nutritionSource: LiveProduct['nutritionSource'] | null;
    approvedIdentity: string; reviewedQuery: string;
  };
  selectionEvidence: null | { reasons: Array<'nutrition_complete_preference' | 'approved_same_food_id_connection' | 'reviewed_order_fallback'>;
    approvedConnectionName: string; reviewedQuery: string; foodId: string | null;
    nutritionContentHash: string | null; nutritionCoreComplete: boolean };
  sourcePendingEvidence: null | { ingredientId: string; sourceName: string; reason: string };
  sourceExactReviewedQuery: string | null;
  amount: { quantity: number; unit: 'g' | 'ml' | 'piece' } | null;
  conversion: unknown;
  policy: ReturnType<typeof ingredientPolicy> & { version: string };
  method: 'approved_coop_exact_name' | 'approved_coop_shared_food_id' | 'plain_water_non_purchased';
  identityEvidence: null | { source: 'willys_recipe_engine'; canonicalQuery: string; canonicalName: string;
    foodId: string; selectedCode: string; status: 'matched' | 'amount_unresolved' };
};

export type CanonicalWillysIdentityEvidence = {
  status: string; foodId: string | null; selectedCode: string | null;
  selectedProduct: { eligible: boolean; name?: string; brand?: string | null } | null;
  query?: string; name?: string;
};

const exactName = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const explicitlyRejectedPendingReason = (reason: string) =>
  /\b(?:not approved|rejected|excluded|not permitted|incompatible|blocked)\b/i.test(reason);
const plainWaterNames = new Set([
  'water', 'water to cover', 'water as needed', 'water for boiling',
  'tap water', 'filtered water', 'boiling water', 'hot water', 'cold water',
  'warm water', 'lukewarm water', 'distilled water',
  ...['tap', 'filtered', 'boiling', 'hot', 'cold', 'warm', 'lukewarm', 'distilled']
    .flatMap(prefix => [`${prefix} water to cover`, `${prefix} water as needed`, `${prefix} water for boiling`]),
]);
function formExclusion(foodId: string | null, sourceText: string, productText: string,
  reviewedDriedForm = false): string | null {
  const rule = foodId ? FOOD_RULES.find(item => item.id === foodId) : undefined;
  const source = sourceText.toLowerCase();
  const product = productText.toLowerCase();
  if (/\bwhole\b/.test(source) && /\b(?:ground|malen|powder(?:ed)?)\b/.test(product))
    return 'product_form_incompatible';
  const sourceDried = /\b(?:dried|dry|ground|powder(?:ed)?|torkad|malen|pulver)\b/.test(source)
    || rule?.form === 'dried' || !!foodId?.endsWith('-dried');
  const sourceFresh = /\bfresh(?:ly)?\b/.test(source) || rule?.form === 'fresh' || !!foodId?.endsWith('-fresh');
  const produceIdentity = !!rule?.categories.some(category => /^(?:frukt|vegetable)$/.test(category));
  const candidateDried = /\b(?:dried|dry|ground|powder(?:ed)?|torkad|malen|pulver)\b/.test(product);
  const candidatePreserved = /\b(?:canned|preserved|tinned|jarred|konserver|konserv|inlagd|pickled)\b/.test(product);
  const candidateFrozen = /\b(?:frozen|fryst|frysta)\b/.test(product);
  if ((sourceFresh || produceIdentity && !sourceDried) && (candidateDried || candidatePreserved || candidateFrozen))
    return 'product_form_incompatible';
  if (sourceDried && !candidateDried && !reviewedDriedForm) return 'product_form_incompatible';
  return null;
}
function reviewedSourceRemainder(source: string): string {
  return source.replace(/^\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?(?:\s+\d+(?:\s*\/\s*\d+)?)?\s*(?:(?:kg|g|grams?|ml|l|liters?|litres?|cups?|c|tbsp|tablespoons?|tsp|teaspoons?|pieces?|pcs?|st|cl|dl)\b\s*)?/i, '')
    .replace(/\s+/g, ' ').trim();
}
function reviewedPlainWaterRemainder(source: string): string {
  // The source parser accepts the common "c." cup spelling. Normalize only
  // that exact quantity prefix here so other ingredient remainder matching
  // retains its existing strict behavior.
  const normalized = source.replace(/^(\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?(?:\s+\d+(?:\s*\/\s*\d+)?)?\s+)c\.(?=\s)/i, '$1c ');
  return reviewedSourceRemainder(normalized);
}
type CanonicalAmount = { quantity: number; unit: 'g' | 'ml' | 'piece' };
const validAmount = (amount: ParsedLine['amount']): amount is CanonicalAmount => !!amount && Number.isFinite(amount.quantity)
  && amount.quantity > 0 && amount.quantity <= 10_000_000
  && ['g', 'ml', 'piece'].includes(amount.unit);

/**
 * Build an offline engine from owner-reviewed Coop name-to-product bindings.
 * Name resolution deliberately folds only case and whitespace. Historical
 * retail prices are never exposed as current price eligibility.
 */
export function createCoopRecipeEngine(dataset: CoopReviewedDataset, sourceCollection: LiveCollection,
  asOf: number, options: { categoryMap?: Record<string, string[]>;
    nutritionCapabilities?: Record<string, { contentHash: string; coreComplete: boolean }>;
    preferCompleteNutrition?: boolean } = {}) {
  if (!Number.isFinite(asOf) || dataset?.retailer !== 'coop' || sourceCollection?.retailer !== 'coop'
    || sourceCollection.schemaVersion !== 1 || sourceCollection.mode !== 'live'
    || dataset.datasetId !== sourceCollection.datasetId || dataset.inventoryHash !== sourceCollection.inventoryHash
    || JSON.stringify(dataset.scope) !== JSON.stringify(sourceCollection.scope)
    || !Array.isArray(dataset.connections) || !Array.isArray(dataset.observations)
    || !Array.isArray(sourceCollection.products)) throw new Error('invalid_coop_recipe_snapshots');

  const productFormReviews = new Map<string, ProductFormReview>();
  if (dataset.productFormReviews !== undefined && !Array.isArray(dataset.productFormReviews))
    throw new Error('invalid_coop_product_form_reviews');
  for (const review of dataset.productFormReviews ?? []) {
    if (!review || typeof review.foodId !== 'string' || !review.foodId.trim()
      || typeof review.productId !== 'string' || !review.productId.trim()
      || typeof review.productIdentity !== 'string' || !review.productIdentity.trim()
      || review.form !== 'dried' || typeof review.reviewedAt !== 'string'
      || !Number.isFinite(Date.parse(review.reviewedAt))
      || typeof review.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(review.sourceSha256)
      || typeof review.reason !== 'string' || !review.reason.trim())
      throw new Error('invalid_coop_product_form_reviews');
    const key = JSON.stringify([review.foodId, review.productId]);
    if (productFormReviews.has(key)) throw new Error('duplicate_coop_product_form_review');
    productFormReviews.set(key, review);
  }

  const observations = new Map<string, ProductObservation>();
  const observationSignatures = new Map<string, string>();
  for (const observation of dataset.observations) {
    if (observation.retailer !== 'coop' || !observation.product?.id) continue;
    const signature = JSON.stringify([productIdentity(observation.product), observation.retailer, observation.scope,
      observation.price, observation.availability, observation.checkedAt, observation.expiresAt, observation.storeScopeVerified]);
    const previous = observationSignatures.get(observation.product.id);
    if (previous !== undefined && previous !== signature) throw new Error('conflicting_duplicate_coop_observation');
    if (previous === undefined) {
      observations.set(observation.product.id, observation);
      observationSignatures.set(observation.product.id, signature);
    }
  }
  const live = new Map<string, LiveProduct>();
  const liveSignatures = new Map<string, string>();
  for (const item of sourceCollection.products) {
    if (item.retailer !== 'coop' || !item.productId) continue;
    const signature = JSON.stringify([item.status, item.productIdentity, item.identityHash, item.checkedAt, item.nutritionSource,
      item.observation ? [productIdentity(item.observation.product), item.observation.retailer, item.observation.scope,
        item.observation.price, item.observation.availability, item.observation.checkedAt,
        item.observation.expiresAt, item.observation.storeScopeVerified] : null]);
    const previous = liveSignatures.get(item.productId);
    if (previous !== undefined && previous !== signature) throw new Error('conflicting_duplicate_coop_live_product');
    if (previous === undefined) {
      live.set(item.productId, item);
      liveSignatures.set(item.productId, signature);
    }
  }
  const byName = new Map<string, ReviewedConnection>();
  const knownNames = new Set<string>();
  const pendingByName = new Map<string, ReviewedConnection[]>();
  const byFoodId = new Map<string, ReviewedConnection[]>();
  for (const connection of dataset.connections) {
    if (!connection.name?.trim()) continue;
    const key = exactName(connection.name);
    knownNames.add(key);
    if (connection.status === 'needs_review') {
      const pending = pendingByName.get(key) ?? [];
      pending.push(connection); pendingByName.set(key, pending);
    }
    if (connection.status === 'matched' && connection.policyVersion === DIETARY_POLICY_VERSION
      && connection.mainProductId) {
      if (byName.has(key)) throw new Error('ambiguous_coop_approved_name');
      byName.set(key, connection);
      if (connection.foodId) {
        const group = byFoodId.get(connection.foodId) ?? [];
        group.push(connection); byFoodId.set(connection.foodId, group);
      }
    }
  }

  function evaluate(line: ParsedLine, canonical: CanonicalWillysIdentityEvidence | null = null): CoopRecipeEvaluation {
    const policy = { ...ingredientPolicy(line.raw), version: DIETARY_POLICY_VERSION };
    const base: CoopRecipeEvaluation = { retailer: 'coop', status: 'needs_review', reason: line.status,
      foodId: null, productId: null, selectedProduct: null, amount: null, conversion: null,
      policy, method: 'approved_coop_exact_name', identityEvidence: null, selectionEvidence: null,
      sourceExactReviewedQuery: null, sourcePendingEvidence: null };
    if (policy.blockedReason) return { ...base, status: 'excluded', reason: policy.blockedReason };
    if (!line.name || !line.query) return base;

    // The Willys engine treats explicit plain water as non-purchased. Preserve
    // that convention only for exact water phrases; bottled, mineral, flavored,
    // stock, broth, and other water-containing ingredients still need review.
    const sourceWaterName = exactName(reviewedPlainWaterRemainder(line.selectionSource ?? line.raw));
    const sourceHasNumericQuantity = /^\s*[\d¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/.test(line.selectionSource ?? line.raw);
    if (line.status === 'parsed' && plainWaterNames.has(exactName(line.name))
      && plainWaterNames.has(exactName(line.query)) && plainWaterNames.has(sourceWaterName)
      && (!sourceHasNumericQuantity || validAmount(line.amount))) {
      const amount = validAmount(line.amount) ? { quantity: line.amount.quantity, unit: line.amount.unit } : null;
      return { ...base, status: 'non_purchased', reason: 'plain_water_non_purchased_no_retail_sku_or_cost',
        foodId: 'water', amount, method: 'plain_water_non_purchased' };
    }

    // Bind only the parsed ingredient's exact reviewed spelling, allowing case
    // and whitespace normalization. Modifiers stay in the policy checks below.
    const parsedName = line.name, parsedQuery = line.query;
    const parsedKey = exactName(parsedName);
    const rawSourceRemainder = exactName(reviewedSourceRemainder(line.raw));
    const sourceConnection = rawSourceRemainder !== parsedKey ? byName.get(rawSourceRemainder) : undefined;
    const sourceNameIsKnown = rawSourceRemainder !== parsedKey && knownNames.has(rawSourceRemainder);
    const sourcePendingRecords = pendingByName.get(rawSourceRemainder) ?? pendingByName.get(parsedKey) ?? [];
    const sourcePending = sourcePendingRecords.length === 1 ? sourcePendingRecords[0] : undefined;
    if (sourcePending && explicitlyRejectedPendingReason(sourcePending.reason))
      return { ...base, reason: 'exact_coop_source_name_is_not_approved',
        sourcePendingEvidence: { ingredientId: sourcePending.ingredientId, sourceName: sourcePending.name,
          reason: sourcePending.reason } };
    if (sourceNameIsKnown && !sourceConnection && !pendingByName.has(rawSourceRemainder))
      return { ...base, reason: 'exact_coop_source_name_is_not_approved' };
    const exactConnection = sourceConnection ?? (pendingByName.has(rawSourceRemainder) ? undefined : byName.get(parsedKey));
    if (!exactConnection && knownNames.has(parsedKey) && !pendingByName.has(parsedKey) && !sourcePending)
      return { ...base, reason: 'exact_coop_name_is_not_approved' };
    const sharedEvidence = !exactConnection && (!knownNames.has(parsedKey) || !!sourcePending) && canonical
      && ['matched', 'amount_unresolved'].includes(canonical.status) && !!canonical.selectedCode
      && canonical.selectedProduct?.eligible === true && !!canonical.foodId?.trim()
      ? canonical : null;
    if (!exactConnection && sourcePendingRecords.length > 1)
      return { ...base, reason: 'pending_coop_name_is_ambiguous' };
    if (!exactConnection && sourcePending && !sharedEvidence)
      return { ...base, reason: 'pending_coop_name_requires_verified_canonical_identity',
        sourcePendingEvidence: { ingredientId: sourcePending.ingredientId, sourceName: sourcePending.name,
          reason: sourcePending.reason } };
    if (!exactConnection && !sharedEvidence) return { ...base, reason: 'no_exact_approved_coop_name' };
    if (!exactConnection && sourcePending?.foodId && sharedEvidence?.foodId !== sourcePending.foodId)
      return { ...base, reason: 'pending_coop_canonical_food_id_mismatch',
        foodId: sourcePending.foodId, sourcePendingEvidence: { ingredientId: sourcePending.ingredientId,
          sourceName: sourcePending.name, reason: sourcePending.reason } };
    const canonicalQuery = sharedEvidence?.query?.trim() || parsedQuery;
    const canonicalName = sharedEvidence?.name?.trim() || parsedName;
    const sharedConnections = sharedEvidence ? byFoodId.get(sharedEvidence.foodId!) ?? [] : [];
    if (sharedEvidence && !sharedConnections.length) return { ...base,
      reason: sourcePending ? 'pending_coop_no_approved_products_for_canonical_food_id'
        : 'no_approved_coop_products_for_canonical_food_id',
      ...(sourcePending ? { sourcePendingEvidence: { ingredientId: sourcePending.ingredientId,
        sourceName: sourcePending.name, reason: sourcePending.reason } } : {}) };
    const exactFoodConnections = options.preferCompleteNutrition && exactConnection?.foodId
      ? byFoodId.get(exactConnection.foodId) ?? [] : [];
    const connections = exactConnection ? [exactConnection, ...exactFoodConnections] : sharedConnections;
    const method = exactConnection ? 'approved_coop_exact_name' as const : 'approved_coop_shared_food_id' as const;
    const recordedIdentity = sharedEvidence ? { source: 'willys_recipe_engine' as const,
      canonicalQuery, canonicalName, foodId: sharedEvidence.foodId!, selectedCode: sharedEvidence.selectedCode!,
      status: sharedEvidence.status as 'matched' | 'amount_unresolved' } : null;
    const sourceFoodId = exactConnection ? exactConnection.foodId : sharedEvidence!.foodId!;
    const resolvedBase = { ...base, method, identityEvidence: recordedIdentity, foodId: sourceFoodId,
      sourceExactReviewedQuery: sourceConnection ? sourceConnection.name : null,
      sourcePendingEvidence: sourcePending ? { ingredientId: sourcePending.ingredientId,
        sourceName: sourcePending.name, reason: sourcePending.reason } : null };
    const connection = connections[0];
    if (line.status !== 'parsed') {
      const exactPendingSource = !!sourcePending && !!sharedEvidence && line.status === 'needs_review'
        && exactName(reviewedSourceRemainder(line.raw)) === exactName(sourcePending.name);
      if ((!exactConnection || line.status !== 'needs_review'
        || exactName(reviewedSourceRemainder(line.raw)) !== exactName(connection.name)) && !exactPendingSource)
        return { ...resolvedBase, reason: 'low_confidence_source_not_exact' };
    }
    const ingredientCheck = ingredientPolicy(line.raw);
    if (ingredientCheck.blockedReason) return { ...resolvedBase, status: 'excluded', reason: ingredientCheck.blockedReason,
      policy: { ...ingredientCheck, version: DIETARY_POLICY_VERSION } };

    const directMainId = exactConnection?.mainProductId ?? null;
    const mainApproval = exactConnection?.approvedProducts.find(item => item.productId === directMainId);
    const mainLive = directMainId ? live.get(directMainId) : undefined;
    if (exactConnection && mainApproval && mainLive && (mainLive.status === 'product_identity_changed'
      || ['collected', 'retained'].includes(mainLive.status) && mainLive.productIdentity !== mainApproval.identity))
      return { ...resolvedBase, reason: 'approved_product_identity_changed' };

    const bindings = connections.flatMap(binding => {
      const mainId = binding.mainProductId;
      return [...binding.approvedProducts].sort((a, b) => Number(b.productId === mainId) - Number(a.productId === mainId))
        .map(approved => ({ connection: binding, approved }));
    });
    const seenBindings = new Set<string>();
    const orderedBindings = bindings.filter(binding => {
      if (seenBindings.has(binding.approved.productId)) return false;
      seenBindings.add(binding.approved.productId); return true;
    });
    type Candidate = { id: string; identity: string; observation: ProductObservation; current: LiveProduct;
      categories: string[]; priceEligible: boolean; connection: ReviewedConnection;
      nutritionCoreComplete: boolean; nutritionContentHash: string | null };
    let choice: Candidate | null = null;
    let firstEligible: Candidate | null = null;
    let policyExclusion: string | null = null;
    for (const { connection: binding, approved } of orderedBindings) {
      if (ingredientPolicy(binding.name).blockedReason) continue;
      const historicalObservation = observations.get(approved.productId);
      const current = live.get(approved.productId);
      if (!historicalObservation || approved.identity !== productIdentity(historicalObservation.product)
        || !current || ['product_missing', 'product_identity_changed'].includes(current.status)
        || !['collected', 'retained'].includes(current.status) || current.productIdentity !== approved.identity) continue;

      let observation = historicalObservation;
      let priceEligible = false;
      if (current.observation) {
        try { validateObservation(current.observation, 'coop', dataset.scope); }
        catch { continue; }
        if (current.observation.product.id !== approved.productId
          || productIdentity(current.observation.product) !== approved.identity
          || current.checkedAt && current.checkedAt !== current.observation.checkedAt
          || Date.parse(current.observation.checkedAt) > asOf + 60_000) continue;
        observation = current.observation;
        priceEligible = observationUsable(observation, 'coop', dataset.scope, asOf);
      }
      const categories = [...observation.product.categories,
        ...(options.categoryMap ? observation.product.categories.flatMap(id => options.categoryMap?.[id] ?? []) : [])];
      const policyProduct = { ...observation.product, categories };
      const pack = observation.product.pack;
      const displayVolume = pack ? pack.drainedGrams !== null && pack.drainedGrams !== undefined
        ? `${pack.quantity}/${pack.drainedGrams}g`
        : `${pack.quantity}${pack.unit === 'piece' ? 'st' : pack.unit}` : '';
      const entry = { code: observation.product.id, name: observation.product.name,
        brand: observation.product.brand, categories, raw: { displayVolume } } as unknown as Parameters<typeof reviewAttributeExclusion>[1];
      const queries = [...new Set([binding.name, parsedQuery, canonicalQuery, canonicalName])];
      const formReview = productFormReviews.get(JSON.stringify([sourceFoodId, approved.productId]));
      const reviewedDriedForm = !!formReview && formReview.foodId === binding.foodId
        && formReview.productIdentity === approved.identity && formReview.form === 'dried'
        && FOOD_RULES.some(rule => rule.id === sourceFoodId && rule.form === 'dried')
        && !/\bfresh(?:ly)?\b/i.test([line.raw, parsedName, parsedQuery, canonicalQuery, canonicalName].filter(Boolean).join(' '));
      let exclusion: string | null = formExclusion(sourceFoodId,
        [line.raw, parsedName, parsedQuery, canonicalQuery, canonicalName].filter(Boolean).join(' '),
        [binding.name, observation.product.name, ...categories, observation.product.ingredientsText ?? ''].join(' '),
        reviewedDriedForm);
      if (!exclusion) {
        for (const query of queries) {
          exclusion = productPolicy(policyProduct, query) || reviewedProductPolicy(policyProduct, query)
            || reviewAttributeExclusion(query, entry);
          if (exclusion) break;
        }
      }
      if (!exclusion) exclusion = productPolicy(policyProduct, line.raw) || reviewedProductPolicy(policyProduct, line.raw)
          || reviewAttributeExclusion(line.raw, entry);
      if (exclusion) { policyExclusion ??= exclusion; continue; }
      const nutritionSource = current.nutritionSource ?? null;
      const capability = options.nutritionCapabilities?.[approved.productId];
      const nutritionCoreComplete = !!capability && capability.coreComplete === true
        && typeof capability.contentHash === 'string'
        && capability.contentHash === nutritionSource?.contentHash
        && !!current.checkedAt && scanIsCurrent(Date.parse(current.checkedAt), asOf);
      const candidate: Candidate = { id: approved.productId, identity: approved.identity, observation, current,
        categories, priceEligible, connection: binding, nutritionCoreComplete,
        nutritionContentHash: nutritionSource?.contentHash ?? null };
      if (!firstEligible) firstEligible = candidate;
      if (options.preferCompleteNutrition && nutritionCoreComplete) { choice = candidate; break; }
    }
    choice ??= firstEligible;
    if (!choice) return { ...resolvedBase, reason: policyExclusion ?? (exactConnection
      && (mainLive?.status === 'product_missing' || !mainLive)
      ? 'approved_product_missing_from_live_collection' : 'approved_products_unavailable_from_live_collection'),
      foodId: sourceFoodId };

    const amount: CoopRecipeEvaluation['amount'] = validAmount(line.amount)
      ? { quantity: line.amount.quantity, unit: line.amount.unit } : null;
    let conversion: unknown = null;
    let convertedForPrice: CoopRecipeEvaluation['amount'] = null;
    const referenceName = exactConnection ? exactConnection.name : canonicalQuery;
    const sourceIsExact = exactName(reviewedSourceRemainder(line.raw)) === exactName(referenceName)
      && !line.size && !line.preparation && exactName(parsedQuery) === exactName(referenceName);
    if (amount && sourceIsExact) {
      const sourceAmount = line.sourceAmount ?? line.amount!;
      if (sourceAmount.unit !== amount.unit || amount.unit !== 'g') {
        const reference = referenceAmount(referenceName, sourceAmount.unit, sourceAmount.quantity);
        if (reference) { convertedForPrice = reference.amount; conversion = reference.evidence; }
      }
    }
    let priceAmount: CoopRecipeEvaluation['amount'] = null;
    const price = choice.priceEligible ? choice.observation.price : null;
    if (amount && price && ((price.basis === 'kg' && amount.unit === 'g')
      || (price.basis === 'l' && amount.unit === 'ml'))) priceAmount = amount;
    else if (amount && price?.basis === 'pack' && choice.observation.product.pack?.unit === amount.unit) priceAmount = amount;
    else if (convertedForPrice && price?.basis === 'kg' && convertedForPrice.unit === 'g') priceAmount = convertedForPrice;
    else if (convertedForPrice && price?.basis === 'pack'
      && choice.observation.product.pack?.unit === convertedForPrice.unit) priceAmount = convertedForPrice;
    const selectedProduct = { id: choice.observation.product.id, name: choice.observation.product.name,
      brand: choice.observation.product.brand, categories: choice.categories, pack: choice.observation.product.pack,
      ingredientsText: choice.observation.product.ingredientsText, eligible: true as const,
      priceEligible: choice.priceEligible, price, priceAmount,
      nutritionEligible: !!choice.current.nutritionSource, nutritionSource: choice.current.nutritionSource ?? null,
      approvedIdentity: choice.identity, reviewedQuery: exactConnection ? exactConnection.name : canonicalQuery };
    const selectionReasons: NonNullable<CoopRecipeEvaluation['selectionEvidence']>['reasons'] = [];
    if (options.preferCompleteNutrition && choice.nutritionCoreComplete) selectionReasons.push('nutrition_complete_preference');
    if (exactConnection && choice.connection.name !== exactConnection.name) selectionReasons.push('approved_same_food_id_connection');
    if (!selectionReasons.length) selectionReasons.push('reviewed_order_fallback');
    const selectionEvidence: NonNullable<CoopRecipeEvaluation['selectionEvidence']> = {
      reasons: selectionReasons,
      approvedConnectionName: choice.connection.name,
      reviewedQuery: exactConnection ? exactConnection.name : canonicalQuery,
      foodId: sourceFoodId,
      nutritionContentHash: choice.nutritionContentHash,
      nutritionCoreComplete: choice.nutritionCoreComplete,
    };
    const matched = { ...resolvedBase, status: 'matched' as const,
      reason: options.preferCompleteNutrition && choice.nutritionCoreComplete
        ? 'approved_product_preferred_for_complete_nutrition'
        : exactConnection ? 'exact_approved_coop_product' : 'approved_coop_product_for_canonical_food_id',
      productId: choice.id, selectedProduct, selectionEvidence, amount, conversion };
    return amount ? matched : { ...matched, status: 'amount_unresolved', reason: 'No verified canonical source amount or exact-food conversion' };
  }

  return { evaluate, metadata: { engineVersion: 'local-coop-reviewed-recipe-1',
    policyVersion: DIETARY_POLICY_VERSION, amountConversionVersion, asOf: new Date(asOf).toISOString(),
    retailer: 'coop', datasetId: dataset.datasetId, inventoryHash: dataset.inventoryHash } };
}

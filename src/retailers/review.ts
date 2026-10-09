import { createHash } from 'node:crypto';
import { ingredientId, buildLinks, reviewAttributeExclusion, type Requirement, type Link } from '../ingredient-matching.ts';
import { candidate } from '../ingredient-candidate.ts';
import type { Assessment } from '../ingredient-assessments.ts';
import { ingredientPolicy, DIETARY_POLICY_VERSION } from '../dietary-policy.ts';
import type { Entry } from '../types.ts';
import { packInfo } from '../product-pack.ts';
import { productIdentity as retailProductIdentity, reviewedProductPolicy, validateConnections, validateObservation } from './identity.ts';
import type { ReviewedConnection } from './identity.ts';
import type { ProductObservation, RetailProduct, RetailerId, StoreScope } from './types.ts';
import { productId, scopeKey, validateScope } from './types.ts';

export type CloudIngredientInventory = {
  schemaVersion?: number;
  datasetId: string;
  sourceDatabaseSha256?: string;
  inventorySource: 'cloud-recipe-database';
  hash: string;
  recipes: number;
  ingredientOccurrences: number;
  distinctIngredients?: number;
  distinctIngredientNames?: number;
  filteredCounts?: { distinctIngredientNames?: number; ingredients?: number };
  dietaryPolicy: { version: string };
  requirements: Requirement[];
};
export type RetailCategoryLabel = { categoryId: string; name: string };
export type RetailCategoryMap = Record<string, string[]>;
export type ManualReviewNominations = { schemaVersion: 1; retailer: RetailerId; scope: StoreScope;
  datasetId: string; inventoryHash: string; catalogueHash: string; source: 'scoped-coop-reference-scan';
  nominations: Array<{ name: string; productIds: string[]; reason: string }> };

export function reviewCatalogueHash(observations: ProductObservation[]): string {
  return sha256(JSON.stringify(observations));
}

export function manualNominationsHash(nominations: ManualReviewNominations | null): string | null {
  return nominations ? sha256(JSON.stringify(nominations)) : null;
}

/** Add matcher families to Coop's opaque category IDs; original IDs remain on product identities. */
export function coopReviewCategoryMap(categories: RetailCategoryLabel[]): RetailCategoryMap {
  const map: RetailCategoryMap = {};
  const rules: Array<[RegExp, string]> = [
    [/\b(?:fryst|frysta|frozen|frys|glass|isglass)\b/, 'fryst'],
    [/\b(?:kyckling|fagel|not|kalv|lamm|kott|korv|bacon|skinka|flask|vilt|kottbullar)\b/, 'kott'],
    [/\b(?:fisk|lax|tonfisk|torsk|sill|ansjovis|rakor|skaldjur|kraftor|caviar)\b/, 'fisk'],
    [/\b(?:mjolk|mjol|ost|cheddar|brie|feta|gouda|yoghurt|fil|gradde|smor|margarin|agg|jaste? ost|dessertost|kvarg|keso)\b/, 'mejeri'],
    [/\b(?:juice|dryck|dricka|must|soda|läsk|kaffe|te|vin|ol|water)\b/, 'dryck'],
    [/\b(?:frukt|bar|ananas|banan|citrus|druvor|kiwi|mango|melon|p[aä]ron|[aä]pple|avokado|blomk[aå]l|broccoli|b[oö]nor|gr[oö]nsaker|gurka|k[aå]l|l[oö]k|mor[oö]tter|paprika|potatis|sallad|svamp|tomat|zucchini|aubergine|sparris|selleri|rotfrukt|groddar|[oö]rter|kryddor|oliver|citron|lime|ingef[aä]ra)\b/, 'frukt'],
    [/\b(?:m[jy]ol|socker|pasta|ris|gryner|baljv[aä]xter|konserv|senap|s[aå]s|krydda|bakning|baking|mj[oö]l|olja|vin[aä]ger|ketchup|sylt|honung|sirap|choklad|kakao|n[oö]tter|fr[oö]|br[oö]d|spannm[aå]l|skafferi|kex|kn[aä]ckebr[oö]d|nudlar|buljong)\b/, 'skafferi'],
  ];
  for (const category of categories) {
    const normalized = category.name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const families = rules.filter(([pattern]) => pattern.test(normalized)).map(([, family]) => family);
    if (families.length) map[category.categoryId] = [...new Set([...families, category.name])];
  }
  return map;
}

export type ReviewCandidate = {
  productId: string;
  name: string;
  brand: string | null;
  ean: string | null;
  ingredientsText: string | null;
  productIdentity: string;
  normalizedPack: ReturnType<typeof packInfo> | null;
  availability: ProductObservation['availability'];
  price: ProductObservation['price'];
  matcherEligible: boolean;
  matcherExclusion: string | null;
  productPolicyReason: string | null;
  proposalSource: 'matcher' | 'prior_review_same_name_brand' | 'manual_nomination' | 'both'
    | 'matcher_and_manual_nomination' | 'prior_review_and_manual_nomination' | 'all_sources';
  nominationReason: string | null;
};

export type ReviewItem = {
  ingredientId: string;
  name: string;
  occurrences: number;
  sourceFoodId: string | null;
  reviewStatus: 'needs_review';
  reason: string;
  policyReason: string | null;
  candidates: ReviewCandidate[];
};

export type ReviewBatch = {
  retailer: RetailerId;
  scope: StoreScope;
  datasetId: string;
  inventoryHash: string;
  policyVersion: string;
  batch: number;
  batchCount: number;
  items: ReviewItem[];
};

export type ReviewDecisionSet = {
  retailer: RetailerId;
  scope: StoreScope;
  datasetId: string;
  inventoryHash: string;
  policyVersion: string;
  catalogueHash?: string;
  nominationsHash?: string | null;
  nominations?: ManualReviewNominations | null;
  connections: ReviewedConnection[];
};

export type CompactReviewCandidate = Pick<ReviewCandidate, 'productId' | 'name' | 'brand' | 'ean'
  | 'ingredientsText' | 'normalizedPack' | 'availability' | 'price' | 'matcherEligible' | 'matcherExclusion'
  | 'proposalSource' | 'nominationReason'>;
export type CompactReviewItem = Pick<ReviewItem, 'ingredientId' | 'name' | 'occurrences' | 'sourceFoodId' | 'reason'> & {
  candidates: CompactReviewCandidate[];
};
export type CompactReviewBatch = Omit<ReviewBatch, 'batch' | 'batchCount' | 'items'> & {
  part: number;
  partCount: number;
  catalogueHash: string;
  nominationsHash: string | null;
  items: CompactReviewItem[];
};
export type CompactReviewDecision = Pick<CompactReviewItem, 'ingredientId' | 'name' | 'sourceFoodId'> & {
  status: ReviewedConnection['status'];
  approvedProductIds: string[];
  reason: string;
};
export type CompactReviewDecisionSet = Omit<ReviewDecisionSet, 'connections'> & {
  part: number;
  partCount: number;
  catalogueHash: string;
  nominationsHash: string | null;
  connections: CompactReviewDecision[];
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);


export function validateCloudIngredientInventory(inventory: CloudIngredientInventory): void {
  if (!inventory || inventory.schemaVersion !== undefined && inventory.schemaVersion !== 1
    || inventory.inventorySource !== 'cloud-recipe-database'
    || !isHash(inventory.datasetId) || !isHash(inventory.hash)
    || inventory.sourceDatabaseSha256 !== undefined && inventory.sourceDatabaseSha256 !== inventory.datasetId
    || inventory.dietaryPolicy?.version !== DIETARY_POLICY_VERSION
    || !Number.isSafeInteger(inventory.recipes) || inventory.recipes < 1
    || !Number.isSafeInteger(inventory.ingredientOccurrences) || inventory.ingredientOccurrences < 1
    || !Array.isArray(inventory.requirements) || inventory.requirements.length < 1) {
    throw new Error('invalid_cloud_ingredient_inventory');
  }
  if (new Set(inventory.requirements.map(requirement => requirement?.name)).size !== inventory.requirements.length
    || inventory.requirements.some(requirement => !requirement?.name?.trim()
      || requirement.name !== requirement.name.trim()
      || !Number.isSafeInteger(requirement.occurrences) || requirement.occurrences < 1
      || ingredientPolicy(requirement.name).blockedReason)) {
    throw new Error('invalid_cloud_ingredient_inventory');
  }
  const occurrenceCount = inventory.requirements.reduce((sum, requirement) => sum + requirement.occurrences, 0);
  const distinctCount = inventory.requirements.length;
  const publishedDistinct = inventory.distinctIngredients ?? inventory.distinctIngredientNames
    ?? inventory.filteredCounts?.distinctIngredientNames;
  if (occurrenceCount !== inventory.ingredientOccurrences
    || publishedDistinct !== undefined && publishedDistinct !== distinctCount
    || inventory.filteredCounts?.ingredients !== undefined && inventory.filteredCounts.ingredients !== occurrenceCount
    || sha256(JSON.stringify(inventory.requirements)) !== inventory.hash) {
    throw new Error('cloud_ingredient_inventory_hash_mismatch');
  }
}

function packLabel(product: RetailProduct): string | null {
  const pack = product.pack;
  if (!pack) return null;
  if (!Number.isFinite(pack.quantity) || pack.quantity <= 0) throw new Error('invalid_product_pack');
  const unit = pack.unit === 'piece' ? 'st' : pack.unit;
  return `${pack.approximate ? 'ca' : ''}${pack.quantity}${unit}`;
}

function normalizedRetailPack(product: RetailProduct): ReturnType<typeof packInfo> | null {
  const pack = product.pack;
  if (!pack) return null;
  return { label: packLabel(product) ?? '', quantity: pack.quantity, unit: pack.unit,
    drainedGrams: pack.drainedGrams??null, approximate: pack.approximate };
}

function toEntry(observation: ProductObservation, categoryMap?: RetailCategoryMap): Entry {
  const { product, price } = observation;
  const basisUnit = price?.basis === 'kg' ? 'kg' : price?.basis === 'l' ? 'l' : 'förp';
  const offer = price ? {
    applied: true,
    campaignType: price.memberOnly ? 'MEMBER' : 'GENERAL',
    qualifyingCount: price.minimumQuantity ?? 1,
    ...(price.validUntil ? { validUntil: Date.parse(price.validUntil) } : {}),
  } : null;
  return {
    code: product.id,
    name: product.name,
    brand: product.brand,
    categories: product.categories.flatMap(category => categoryMap?.[category] ?? [category]),
    priceOre: price?.amountOre ?? null,
    priceUnit: price ? `kr/${basisUnit}` : '',
    comparePriceOre: null,
    comparePriceUnit: '',
    depositOre: price?.depositOre ?? null,
    available: observation.availability === 'available',
    observedAt: observation.checkedAt,
    priceHash: JSON.stringify(price),
    offers: offer ? [offer] : [],
    raw: { code: product.id, name: product.name, ...(packLabel(product) ? { displayVolume: packLabel(product) } : {}),
      ...(product.ingredientsText !== null ? { ingredientsText: product.ingredientsText } : {}) },
    sourcePricing: price ? { amountOre: price.amountOre, basis: price.basis } : {},
  };
}

function validateReviewInputs(inventory: CloudIngredientInventory, observations: ProductObservation[],
  retailer: RetailerId, scope: StoreScope, categoryMap?: RetailCategoryMap) {
  validateCloudIngredientInventory(inventory);
  validateScope(scope);
  if (!['coop', 'ica'].includes(retailer) || !Array.isArray(observations)) {
    throw new Error('invalid_review_catalogue');
  }
  const ids = new Set<string>();
  for (const observation of observations) {
    validateObservation(observation, retailer, scope);
    if (ids.has(observation.product.id)) throw new Error('duplicate_review_product');
    ids.add(observation.product.id);
    if (!productId(observation.product.id) || !observation.product.name.trim()
      || !Array.isArray(observation.product.categories)
      || observation.product.brand !== null && typeof observation.product.brand !== 'string') {
      throw new Error('invalid_review_product');
    }
  }
  return observations.map(observation => toEntry(observation, categoryMap));
}

export function mergeManualReviewNominations(sets: ManualReviewNominations[]): ManualReviewNominations | null {
  if (!sets.length) return null;
  const first = sets[0], seen = new Set<string>(), nominations = sets.flatMap(set => {
    if (set.schemaVersion !== 1 || set.source !== 'scoped-coop-reference-scan' || set.retailer !== 'coop'
      || set.retailer !== first.retailer || scopeKey(set.retailer, set.scope) !== scopeKey(first.retailer, first.scope)
      || set.datasetId !== first.datasetId || set.inventoryHash !== first.inventoryHash
      || set.catalogueHash !== first.catalogueHash) throw new Error('manual_nomination_snapshot_mismatch');
    return set.nominations;
  });
  for (const nomination of nominations) {
    if (seen.has(nomination.name)) throw new Error('manual_nomination_name_repeated');
    seen.add(nomination.name);
  }
  return { ...first, nominations };
}

function validateManualReviewNominations(nominations: ManualReviewNominations | null | undefined,
  inventory: CloudIngredientInventory, observations: ProductObservation[], entries: Entry[], retailer: RetailerId,
  scope: StoreScope): ManualReviewNominations | null {
  if (!nominations) return null;
  const requirements = new Set(inventory.requirements.map(requirement => requirement.name));
  const byCode = new Map(entries.map(entry => [entry.code, entry]));
  if (nominations.schemaVersion !== 1 || nominations.source !== 'scoped-coop-reference-scan' || retailer !== 'coop'
    || nominations.retailer !== retailer || scopeKey(nominations.retailer, nominations.scope) !== scopeKey(retailer, scope)
    || nominations.datasetId !== inventory.datasetId || nominations.inventoryHash !== inventory.hash
    || nominations.catalogueHash !== reviewCatalogueHash(observations) || !Array.isArray(nominations.nominations)) {
    throw new Error('manual_nomination_snapshot_mismatch');
  }
  const names = new Set<string>();
  for (const nomination of nominations.nominations) {
    if (!requirements.has(nomination.name) || names.has(nomination.name) || !nomination.reason?.trim()
      || !Array.isArray(nomination.productIds) || nomination.productIds.length < 1 || nomination.productIds.length > 8
      || new Set(nomination.productIds).size !== nomination.productIds.length) throw new Error('manual_nomination_invalid');
    names.add(nomination.name);
    for (const productId of nomination.productIds) {
      const entry = byCode.get(productId);
      if (!entry) throw new Error('manual_nomination_product_not_in_scan');
      if (reviewedProductPolicy({ name: entry.name, brand: entry.brand, categories: entry.categories,
        ingredientsText: typeof entry.raw.ingredientsText === 'string' ? entry.raw.ingredientsText : null }, nomination.name)) {
        throw new Error('manual_nomination_product_policy_excluded');
      }
      if (reviewAttributeExclusion(nomination.name, entry)) throw new Error('manual_nomination_attribute_mismatch');
    }
  }
  return nominations;
}

type ReviewLink = Omit<Link, 'candidates'> & { candidates: Array<Link['candidates'][number]
  & { proposalSource: ReviewCandidate['proposalSource']; nominationReason: string | null }> };
function buildReviewLinks(requirements: Requirement[], entries: Entry[], now: number,
  assessments: Record<string, Assessment> = {}, nominations: ManualReviewNominations | null = null): ReviewLink[] {
  const matcher = buildLinks(requirements, entries, {}, now);
  const priorReviews = Object.fromEntries(Object.entries(assessments).filter(([, assessment]) => assessment.outcome === 'approve'));
  if (!Object.keys(priorReviews).length && !nominations) return matcher.map(link => ({ ...link,
    candidates: link.candidates.map(candidate => ({ ...candidate, proposalSource: 'matcher', nominationReason: null })) }));
  const prior = Object.keys(priorReviews).length ? buildLinks(requirements, entries, {}, now, priorReviews) : matcher;
  const byCode = new Map(entries.map(entry => [entry.code, entry]));
  const nominated = new Map((nominations?.nominations ?? []).map(item => [item.name, item]));
  return matcher.map((link, index): ReviewLink => {
    const other = prior[index];
    const genericCodes = new Set(link.candidates.map(candidate => candidate.code));
    const priorCodes = new Set(other.candidates.map(candidate => candidate.code));
    const manual = nominated.get(link.name);
    const union = new Map([...link.candidates, ...other.candidates].map(candidate => [candidate.code, candidate]));
    for (const productId of manual?.productIds ?? []) {
      if (union.has(productId)) continue;
      const entry = byCode.get(productId);
      if (!entry) continue;
      const pack = packInfo(entry);
      const basis = entry.priceUnit.toLowerCase().includes('/kg') ? 'kg'
        : entry.priceUnit.toLowerCase().includes('/l') ? 'l'
        : pack.unit === 'ml' ? 'l' : pack.unit === 'piece' ? 'piece' : 'kg';
      union.set(productId, candidate(entry, basis, now));
    }
    const candidates = [...union.values()].filter(candidate => {
      const entry = byCode.get(candidate.code);
      return !!entry && !reviewedProductPolicy({ name: entry.name, brand: entry.brand, categories: entry.categories,
        ingredientsText: typeof entry.raw.ingredientsText === 'string' ? entry.raw.ingredientsText : null }, link.name)
        && !reviewAttributeExclusion(link.name, entry);
    }).map(candidate => {
      const isGeneric = genericCodes.has(candidate.code), isPrior = priorCodes.has(candidate.code);
      const isNomination = manual?.productIds.includes(candidate.code) ?? false;
      const proposalSource: ReviewCandidate['proposalSource'] = isGeneric && isPrior && isNomination ? 'all_sources'
        : isGeneric && isPrior ? 'both' : isGeneric && isNomination ? 'matcher_and_manual_nomination'
        : isPrior && isNomination ? 'prior_review_and_manual_nomination'
        : isNomination ? 'manual_nomination' : isPrior ? 'prior_review_same_name_brand' : 'matcher';
      return { ...candidate, proposalSource, nominationReason: isNomination ? manual!.reason : null };
    })
      .sort((a, b) => Number(b.eligible) - Number(a.eligible)
        || Number(a.proposalSource === 'matcher') - Number(b.proposalSource === 'matcher')
        || (a.comparisonPriceOre ?? Infinity) - (b.comparisonPriceOre ?? Infinity)
        || a.code.localeCompare(b.code)).slice(0, 8);
    return { ...link, candidates };
  });
}

export function prepareReviewBatches(inventory: CloudIngredientInventory, observations: ProductObservation[],
  retailer: RetailerId, scope: StoreScope, groupSize = 25, now = Date.now(), categoryMap?: RetailCategoryMap,
  assessments: Record<string, Assessment> = {}, nominations?: ManualReviewNominations | null): ReviewBatch[] {
  if (!Number.isSafeInteger(groupSize) || groupSize < 1 || groupSize > 25) throw new Error('invalid_review_group_size');
  const entries = validateReviewInputs(inventory, observations, retailer, scope, categoryMap);
  const reviewedNominations = validateManualReviewNominations(nominations, inventory, observations, entries, retailer, scope);
  const links = buildReviewLinks(inventory.requirements, entries, now, assessments, reviewedNominations);
  if (links.length !== inventory.requirements.length || links.some(link => link.status === 'excluded')) {
    throw new Error('review_inventory_policy_mismatch');
  }
  const observationsById = new Map(observations.map(observation => [observation.product.id, observation]));
  const items: ReviewItem[] = links.map(link => ({
    ingredientId: link.ingredientId,
    name: link.name,
    occurrences: link.occurrences,
    sourceFoodId: link.foodId,
    reviewStatus: 'needs_review',
    reason: link.reason,
    policyReason: link.dietaryPolicy.blockedReason,
    candidates: link.candidates.flatMap(candidate => {
      const observation = observationsById.get(candidate.code);
      if (!observation) return [];
      const entry = entries.find(product => product.code === candidate.code);
      if (!entry) return [];
      const policyReason = reviewedProductPolicy({ name: entry.name, brand: entry.brand, categories: entry.categories,
        ingredientsText: typeof entry.raw.ingredientsText === 'string' ? entry.raw.ingredientsText : null }, link.name);
      if (policyReason) return [];
      return [{
        productId: observation.product.id,
        name: observation.product.name,
        brand: observation.product.brand,
        ean: observation.product.ean,
        ingredientsText: observation.product.ingredientsText,
        productIdentity: retailProductIdentity(observation.product),
        normalizedPack: normalizedRetailPack(observation.product),
        availability: observation.availability,
        price: observation.price,
        matcherEligible: candidate.eligible,
        matcherExclusion: candidate.exclusion,
        productPolicyReason: null,
        proposalSource: candidate.proposalSource,
        nominationReason: candidate.nominationReason,
      }];
    }),
  }));
  const batchCount = Math.ceil(items.length / groupSize);
  return Array.from({ length: batchCount }, (_, index) => ({
    retailer,
    scope: { ...scope },
    datasetId: inventory.datasetId,
    inventoryHash: inventory.hash,
    policyVersion: DIETARY_POLICY_VERSION,
    batch: index + 1,
    batchCount,
    items: items.slice(index * groupSize, (index + 1) * groupSize),
  }));
}

/** Compact model-facing batches; full product identity stays in the source scan and is restored on expansion. */
export function compactReviewBatches(inventory: CloudIngredientInventory, observations: ProductObservation[],
  retailer: RetailerId, scope: StoreScope, partCount = 3, now = Date.now(), categoryMap?: RetailCategoryMap,
  assessments: Record<string, Assessment> = {}, nominations?: ManualReviewNominations | null): CompactReviewBatch[] {
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > 12) throw new Error('invalid_review_part_count');
  const items = prepareReviewBatches(inventory, observations, retailer, scope, 25, now, categoryMap, assessments, nominations).flatMap(batch => batch.items)
    .map(({ ingredientId, name, occurrences, sourceFoodId, reason, candidates }) => ({ ingredientId, name,
      occurrences, sourceFoodId, reason, candidates: candidates.map(({ productId, name, brand, ean,
        ingredientsText, normalizedPack, availability, price, matcherEligible, matcherExclusion,
        proposalSource, nominationReason }) => ({ productId, name, brand, ean, ingredientsText, normalizedPack,
        availability, price, matcherEligible, matcherExclusion, proposalSource, nominationReason })) }));
  const perPart = Math.ceil(items.length / partCount);
  return Array.from({ length: partCount }, (_, index) => ({ retailer, scope: { ...scope },
    datasetId: inventory.datasetId, inventoryHash: inventory.hash, policyVersion: DIETARY_POLICY_VERSION,
    part: index + 1, partCount, catalogueHash: reviewCatalogueHash(observations),
    nominationsHash: manualNominationsHash(nominations ?? null), items: items.slice(index * perPart, (index + 1) * perPart) }));
}

/** Restore compact decisions only through the current emitted candidate IDs and their full product identities. */
export function expandCompactReviewDecisions(inventory: CloudIngredientInventory, observations: ProductObservation[],
  compactBatches: CompactReviewBatch[], decisionSets: CompactReviewDecisionSet[], retailer: RetailerId,
  scope: StoreScope, now = Date.now(), categoryMap?: RetailCategoryMap,
  assessments: Record<string, Assessment> = {}, nominations?: ManualReviewNominations | null): ReviewedConnection[] {
  const currentBatches = compactReviewBatches(inventory, observations, retailer, scope,
    compactBatches[0]?.partCount ?? 3, now, categoryMap, assessments, nominations);
  if (compactBatches.length !== currentBatches.length || decisionSets.length !== currentBatches.length) {
    throw new Error('compact_review_parts_incomplete');
  }
  const allNames = new Set<string>();
  const batchByPart = new Map<number, CompactReviewBatch>();
  for (const batch of compactBatches) {
    if (batchByPart.has(batch.part) || batch.partCount !== currentBatches.length || batch.part < 1
      || batch.part > currentBatches.length || batch.retailer !== retailer
      || scopeKey(batch.retailer, batch.scope) !== scopeKey(retailer, scope)
      || batch.datasetId !== inventory.datasetId || batch.inventoryHash !== inventory.hash
      || batch.policyVersion !== DIETARY_POLICY_VERSION || batch.catalogueHash !== reviewCatalogueHash(observations)
      || batch.nominationsHash !== manualNominationsHash(nominations ?? null)) throw new Error('compact_review_batch_snapshot_mismatch');
    batchByPart.set(batch.part, batch);
    for (const item of batch.items) {
      if (allNames.has(item.name)) throw new Error('compact_review_name_repeated');
      allNames.add(item.name);
    }
  }
  const expectedByName = new Map(currentBatches.flatMap(batch => batch.items.map(item => [item.name, item] as const)));
  if (allNames.size !== expectedByName.size || [...expectedByName.keys()].some(name => !allNames.has(name))) {
    throw new Error('compact_review_batches_inventory_mismatch');
  }
  for (const batch of compactBatches) for (const item of batch.items) {
    const expected = expectedByName.get(item.name)!;
    if (item.ingredientId !== expected.ingredientId || item.sourceFoodId !== expected.sourceFoodId
      || item.occurrences !== expected.occurrences || item.reason !== expected.reason
      || item.candidates.length !== expected.candidates.length
      || item.candidates.some((candidate, index) => {
        const source = expected.candidates[index];
        return candidate.productId !== source.productId || candidate.name !== source.name
          || candidate.brand !== source.brand || candidate.ean !== source.ean
          || candidate.ingredientsText !== source.ingredientsText
          || JSON.stringify(candidate.normalizedPack) !== JSON.stringify(source.normalizedPack)
          || candidate.availability !== source.availability || JSON.stringify(candidate.price) !== JSON.stringify(source.price)
          || candidate.matcherEligible !== source.matcherEligible || candidate.matcherExclusion !== source.matcherExclusion
          || candidate.proposalSource !== source.proposalSource || candidate.nominationReason !== source.nominationReason;
      })) throw new Error('compact_review_batch_candidates_changed');
  }
  const fullItemsByName = new Map(prepareReviewBatches(inventory, observations, retailer, scope, 25, now, categoryMap,
    assessments, nominations)
    .flatMap(batch => batch.items.map(item => [item.name, item] as const)));
  const decisionsByName = new Map<string, CompactReviewDecision>();
  for (const decisionSet of decisionSets) {
    if (decisionSet.partCount !== currentBatches.length || !batchByPart.has(decisionSet.part)
      || decisionSet.retailer !== retailer || scopeKey(decisionSet.retailer, decisionSet.scope) !== scopeKey(retailer, scope)
      || decisionSet.datasetId !== inventory.datasetId || decisionSet.inventoryHash !== inventory.hash
      || decisionSet.policyVersion !== DIETARY_POLICY_VERSION || decisionSet.catalogueHash !== reviewCatalogueHash(observations)
      || decisionSet.nominationsHash !== manualNominationsHash(nominations ?? null)) throw new Error('compact_review_decision_snapshot_mismatch');
    const partNames = new Set(batchByPart.get(decisionSet.part)!.items.map(item => item.name));
    for (const decision of decisionSet.connections) {
      if (!partNames.has(decision.name) || decisionsByName.has(decision.name)) throw new Error('compact_review_decision_name_mismatch');
      decisionsByName.set(decision.name, decision);
    }
  }
  if (decisionsByName.size !== expectedByName.size || [...expectedByName.keys()].some(name => !decisionsByName.has(name))) {
    throw new Error('compact_review_decisions_incomplete');
  }
  return currentBatches.flatMap(batch => batch.items.map(item => {
    const decision = decisionsByName.get(item.name)!;
    if (decision.ingredientId !== item.ingredientId || decision.sourceFoodId !== item.sourceFoodId
      || !decision.reason?.trim() || !['matched', 'needs_review', 'unavailable', 'non_purchased'].includes(decision.status)
      || !Array.isArray(decision.approvedProductIds) || new Set(decision.approvedProductIds).size !== decision.approvedProductIds.length) {
      throw new Error('compact_review_decision_invalid');
    }
    const candidates = new Map(item.candidates.map(candidate => [candidate.productId, candidate]));
    if (decision.status !== 'matched' && decision.approvedProductIds.length) throw new Error('compact_review_unmatched_has_products');
    if (decision.status === 'matched' && (decision.approvedProductIds.length < 1 || decision.approvedProductIds.length > 3)) {
      throw new Error('compact_review_match_requires_products');
    }
    const approvedProducts = decision.approvedProductIds.map(productId => {
      const candidate = candidates.get(productId);
      if (!candidate) throw new Error('compact_review_product_not_emitted');
      if (!candidate.matcherEligible) throw new Error(`compact_review_product_not_eligible:${candidate.matcherExclusion ?? 'unknown'}`);
      const full = fullItemsByName.get(item.name)?.candidates.find(candidate => candidate.productId === productId);
      if (!full || full.name !== candidate.name || full.brand !== candidate.brand || full.ean !== candidate.ean
        || JSON.stringify(full.normalizedPack) !== JSON.stringify(candidate.normalizedPack)
        || full.ingredientsText !== candidate.ingredientsText) throw new Error('compact_review_candidate_identity_changed');
      return { productId, identity: full.productIdentity };
    });
    return { ingredientId: item.ingredientId, name: item.name, foodId: item.sourceFoodId, status: decision.status,
      mainProductId: decision.status === 'matched' ? decision.approvedProductIds[0] : null,
      approvedProducts, policyVersion: DIETARY_POLICY_VERSION, reviewedAt: new Date(now).toISOString(), reason: decision.reason };
  }));
}

export function validateReviewedInventory(inventory: CloudIngredientInventory, observations: ProductObservation[],
  decisionSet: ReviewDecisionSet, retailer: RetailerId, scope: StoreScope, now = Date.now(), categoryMap?: RetailCategoryMap,
  assessments: Record<string, Assessment> = {}, nominations?: ManualReviewNominations | null): ReviewedConnection[] {
  const entries = validateReviewInputs(inventory, observations, retailer, scope, categoryMap);
  const sourceNominations = nominations === undefined ? decisionSet?.nominations ?? null : nominations;
  const reviewedNominations = validateManualReviewNominations(sourceNominations, inventory, observations, entries, retailer, scope);
  if (!decisionSet || decisionSet.retailer !== retailer
    || scopeKey(decisionSet.retailer, decisionSet.scope) !== scopeKey(retailer, scope)
    || decisionSet.datasetId !== inventory.datasetId || decisionSet.inventoryHash !== inventory.hash
    || decisionSet.policyVersion !== DIETARY_POLICY_VERSION || !Array.isArray(decisionSet.connections)) {
    throw new Error('review_snapshot_scope_mismatch');
  }
  const requirements = new Map(inventory.requirements.map(requirement => [requirement.name, requirement]));
  const connections = decisionSet.connections;
  if (decisionSet.catalogueHash !== undefined && decisionSet.catalogueHash !== reviewCatalogueHash(observations)
    || decisionSet.nominationsHash !== undefined && decisionSet.nominationsHash !== manualNominationsHash(reviewedNominations)
    || decisionSet.nominations && manualNominationsHash(decisionSet.nominations) !== manualNominationsHash(reviewedNominations)) {
    throw new Error('review_nominations_mismatch');
  }
  if (connections.length !== requirements.size || new Set(connections.map(connection => connection.name)).size !== requirements.size
    || connections.some(connection => !requirements.has(connection.name))) {
    throw new Error('review_inventory_names_mismatch');
  }
  const currentLinks = buildReviewLinks(inventory.requirements, entries, now, assessments, reviewedNominations);
  const linkByName = new Map(currentLinks.map(link => [link.name, link]));
  for (const connection of connections) {
    const link = linkByName.get(connection.name);
    if (!link || connection.ingredientId !== ingredientId(connection.name) || connection.foodId !== link.foodId) {
      throw new Error('review_inventory_identity_mismatch');
    }
    if (connection.status === 'matched') {
      const allowedCandidateIds = new Set(link.candidates.map(candidate => candidate.code));
      if (connection.approvedProducts.some(product => !allowedCandidateIds.has(product.productId))) {
        throw new Error('review_product_not_a_matcher_candidate');
      }
    }
  }
  validateConnections(connections, observations.map(observation => observation.product));
  return connections.map(connection => ({ ...connection, approvedProducts: connection.approvedProducts.map(product => ({ ...product })) }));
}

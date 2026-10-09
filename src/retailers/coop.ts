import {
  RetailerUnsupportedError,
  postalCode as validatePostalCode,
  productId as isProductId,
  validateScope,
  type ProductObservation,
  type RetailCapabilities,
  type RetailCategory,
  type RetailClient,
  type RetailPage,
  type RetailStore,
  type RetailTransport,
  type RetailProduct,
  type RetailPrice,
  type StoreScope,
} from './types.ts';

const API_ROOT = 'https://external.api.coop.se/ecommerce/coop';
const PERSONALIZATION_ROOT = 'https://external.api.coop.se/personalization';
const CATEGORIES = '/users/anonymous/categories/tree/';
const POINT_OF_SERVICES = '/pointofservices';
const SEARCH_VERSION = 'v1';

export type CoopClientOptions = {
  transport?: RetailTransport;
  /** The public browser subscription header used by Coop's published API. */
  publicSubscriptionKey?: string;
  /** Coop currently publishes a separate key for personalization; falls back to the shared key. */
  personalizationSubscriptionKey?: string;
  now?: () => Date;
};

/** A complete, well-formed by-ID response omitted these requested products. */
export class CoopMissingProductsError extends Error {
  readonly retailer = 'coop' as const;
  readonly requestedProductIds: string[];
  readonly missingProductIds: string[];
  readonly observations: ProductObservation[];
  readonly scope: StoreScope;
  constructor(scope: StoreScope, requestedProductIds: string[], missingProductIds: string[], observations: ProductObservation[]) {
    super('coop_requested_products_missing');
    this.name = 'CoopMissingProductsError';
    this.scope = { ...scope };
    this.requestedProductIds = [...requestedProductIds];
    this.missingProductIds = [...missingProductIds];
    this.observations = [...observations];
  }
}

const unsupportedCapabilities: RetailCapabilities = {
  stores: true,
  categories: true,
  browse: true,
  productLookup: true,
  batchLookup: true,
  verifiedStorePricing: true,
  notes: [
    'Postal-code lookup returns the first page of nearby pickup-capable stores and may include lockers whose physical pickup point differs from the fulfilment store.',
    'Category products and EAN details use the fulfilment store context; prices are online pickup prices for that pricing store, not physical pickup-point shelf prices.',
    'Delivery and delivery-slot price scope are not exposed by the verified public frontend request.',
    'Member-only and multi-buy offers are not selected as public prices; ambiguous offers fall back to the regular public price.',
  ],
};

export class CoopClient implements RetailClient {
  readonly retailer = 'coop' as const;
  readonly capabilities: RetailCapabilities = {
    ...unsupportedCapabilities,
    notes: [...unsupportedCapabilities.notes],
  };
  private readonly transport: RetailTransport;
  private readonly publicSubscriptionKey: string | undefined;
  private readonly personalizationSubscriptionKey: string | undefined;
  private readonly now: () => Date;

  constructor(options: CoopClientOptions = {}) {
    this.transport = options.transport ?? ((input, init) => globalThis.fetch(input, init));
    this.publicSubscriptionKey = options.publicSubscriptionKey;
    this.personalizationSubscriptionKey = options.personalizationSubscriptionKey ?? options.publicSubscriptionKey;
    this.now = options.now ?? (() => new Date());
  }

  async stores(postal: string): Promise<RetailStore[]> {
    const code = validatePostalCode(postal);
    const query = new URLSearchParams({ query: code, fields: 'FULL', 'api-version': 'v1' });
    const response = await this.request(`${POINT_OF_SERVICES}?${query.toString()}`);
    const raw = unwrap(response);
    if (!isRecord(raw) || !Array.isArray(raw.stores)) throw new Error('coop_unexpected_stores_response');
    return raw.stores.map(parseStore).filter((store): store is RetailStore => store !== null);
  }

  async categories(scope: StoreScope): Promise<RetailCategory[]> {
    validateScope(scope);
    const query = new URLSearchParams({ 'api-version': 'v1' });
    const response = await this.request(`${CATEGORIES}${encodeURIComponent(scope.storeId)}?${query.toString()}`);
    const data = unwrap(response);
    const raw = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.nodes) ? data.nodes : null;
    if (!raw) throw new Error('coop_unexpected_category_tree');
    // The live tree contains two unnamed, empty navigation placeholders at its root.
    // Ignore only those exact observed nodes; malformed named categories still fail closed.
    return raw.filter(node => !isKnownRootCategoryPlaceholder(node)).map(parseCategory);
  }

  async browse(scope: StoreScope, categoryId: string, cursor?: string): Promise<RetailPage> {
    validatePricingScope(scope);
    if (typeof categoryId !== 'string' || !categoryId.trim()) throw new Error('invalid_category_id');
    const offset = parseCursor(cursor);
    const body = {
      attribute: { name: 'categoryIds', value: categoryId.trim() },
      resultsOptions: {
        skip: offset,
        take: 24,
        sortBy: [],
        facets: [
          { attributeName: 'brand', type: 'distinct', operator: 'AND', selected: [] },
          { attributeName: 'filterLabels', type: 'distinct', operator: 'OR', selected: [] },
          { attributeName: 'topCategory', type: 'distinct', operator: 'OR', selected: [] },
        ],
      },
      customData: { getEntitiesByAttributeABTest: true },
    };
    const payload = await this.personalizationRequest('/search/entities/by-attribute', scope.storeId, body);
    const result = searchItems(payload);
    if (!result) throw new Error('coop_unexpected_category_products');
    const checkedAt = this.now();
    const products = result.items.map(item => parseCoopProductValidated(item, scope, checkedAt, true));
    const nextOffset = offset + result.items.length;
    if (result.items.length === 0 && offset < result.count) throw new Error('coop_empty_nonterminal_category_page');
    return {
      products,
      nextCursor: result.items.length > 0 && nextOffset < result.count ? String(nextOffset) : null,
      total: result.count,
      scope,
      categoryId: categoryId.trim(),
    };
  }

  async products(scope: StoreScope, productIds: string[]): Promise<ProductObservation[]> {
    validatePricingScope(scope);
    if (!Array.isArray(productIds) || productIds.some(id => !isProductId(id))) throw new Error('invalid_product_ids');
    const uniqueIds = [...new Set(productIds)];
    if (!uniqueIds.length) return [];
    const payload = await this.personalizationRequest('/search/entities/by-id', scope.storeId, uniqueIds);
    const result = searchItems(payload);
    if (!result) throw new Error('coop_unexpected_products_response');
    if (result.count !== result.items.length) throw new Error('coop_incomplete_products_response');
    const requested = new Set(uniqueIds), rawById = new Map<string, Record<string, unknown>>();
    for (const item of result.items) {
      const id = firstString(item, ['id', 'code', 'productId', 'ean']);
      if (!id || !requested.has(id) || rawById.has(id)) throw new Error('coop_incomplete_products_response');
      rawById.set(id, item);
    }
    const checkedAt = this.now();
    const foundById = new Map<string, ProductObservation>();
    for (const [id, item] of rawById) foundById.set(id, parseCoopProductValidated(item, scope, checkedAt, true));
    const missing = uniqueIds.filter(id => !foundById.has(id));
    const found = [...foundById.values()];
    if (missing.length) throw new CoopMissingProductsError(scope, uniqueIds, missing, found);
    return uniqueIds.map(id => foundById.get(id)!);
  }

  private async request(path: string): Promise<unknown> {
    return this.send(new URL(`${API_ROOT}${path}`), 'GET', undefined, this.publicSubscriptionKey);
  }

  private async personalizationRequest(path: string, storeId: string, body: unknown): Promise<unknown> {
    const url = new URL(`${PERSONALIZATION_ROOT}${path}`);
    url.searchParams.set('api-version', SEARCH_VERSION);
    url.searchParams.set('store', storeId);
    url.searchParams.set('groups', 'CUSTOMER_PRIVATE');
    url.searchParams.set('device', 'desktop');
    url.searchParams.set('direct', 'false');
    if (path === '/search/entities/by-id') url.searchParams.set('quickSearch', 'false');
    return this.send(url, 'POST', body, this.personalizationSubscriptionKey);
  }

  private async send(url: URL, method: 'GET' | 'POST', body: unknown, key: string | undefined): Promise<unknown> {
    const allowed = url.origin === 'https://external.api.coop.se'
      && (url.pathname.startsWith('/ecommerce/coop/') || url.pathname.startsWith('/personalization/'));
    if (!allowed) throw new Error('untrusted_coop_url');
    if (!key) throw new Error('coop_public_subscription_key_required');
    const response = await this.transport(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        'Ocp-Apim-Subscription-Key': key,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`coop_http_${response.status}:${url.pathname}`);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error(`coop_invalid_json:${url.pathname}`); }
    return payload;
  }
}

export function parseCategory(input: unknown): RetailCategory {
  if (!isRecord(input)) throw new Error('coop_unexpected_category');
  const id = firstString(input, ['code', 'id', 'categoryId']);
  const name = firstString(input, ['name', 'title', 'label']);
  const childrenValue = Array.isArray(input.children) ? input.children : Array.isArray(input.nodes) ? input.nodes : [];
  if (!id || !name) throw new Error('coop_unexpected_category');
  return { id, name, children: childrenValue.map(parseCategory) };
}

function isKnownRootCategoryPlaceholder(input: unknown): boolean {
  return isRecord(input)
    && (input.code === '0001' || input.code === '0002')
    && input.url === '/varor/'
    && Array.isArray(input.children) && input.children.length === 0
    && !firstString(input, ['name', 'title', 'label']);
}

function parseStore(input: unknown): RetailStore | null {
  if (!isRecord(input)) return null;
  const id = firstString(input, ['storeId', 'code', 'id']);
  const name = firstString(input, ['displayName', 'name']);
  if (!id || !name) return null;
  const pointId = firstString(input, ['pickupPointId', 'pointOfServiceId', 'code', 'id']);
  const pickupModes = Array.isArray(input.pickupDeliveryModes) ? input.pickupDeliveryModes : [];
  if (pickupModes.length === 0) return null;
  const address = record(input.address);
  const postal = address ? firstString(address, ['postalCode', 'postcode']) : null;
  const street = address ? firstString(address, ['line1', 'streetAddress', 'addressLine1', 'formattedAddress']) : null;
  const town = address ? firstString(address, ['town', 'city', 'locality']) : null;
  const addressText = [street, town].filter((value): value is string => value !== null).join(', ');
  return {
    retailer: 'coop',
    id,
    pricingStoreId: id,
    name,
    channels: ['pickup'],
    ...(pointId && pointId !== id ? { pickupPointId: pointId } : {}),
    ...(postal ? { postalCode: postal } : {}),
    ...(addressText ? { address: addressText } : {}),
    ...(firstString(input, ['url']) ? { url: firstString(input, ['url'])! } : {}),
  };
}

/** Parse product identity and source pricing, retaining prices only when the caller
 * verified the source request's explicit pickup-store context. */
export function parseCoopProduct(
  payload: unknown,
  scope: StoreScope,
  checkedAt: Date,
  storeScopeVerified: boolean,
): ProductObservation {
  validateScope(scope);
  return parseCoopProductValidated(payload, scope, checkedAt, storeScopeVerified);
}

function parseCoopProductValidated(
  payload: unknown,
  scope: StoreScope,
  checkedAt: Date,
  storeScopeVerified: boolean,
): ProductObservation {
  const raw = productRecord(payload);
  if (!raw) throw new Error('coop_unexpected_product');

  const id = firstString(raw, ['code', 'id', 'productId', 'ean']);
  const eanValue = firstString(raw, ['ean', 'gtin', 'barcode']) ?? (id && /^\d{8,14}$/.test(id) ? id : null);
  const ean = eanValue && /^\d{8,14}$/.test(eanValue) ? eanValue : null;
  const name = firstString(raw, ['name', 'displayName', 'title']);
  if (!id || !name) throw new Error('coop_unexpected_product');

  const pack = parsePack(raw);
  const drainedSource=record(raw.drainedWeight);
  const drainedText=typeof raw.drainedWeight==='string'?raw.drainedWeight:
    drainedSource?`${drainedSource.value??drainedSource.quantity??''} ${drainedSource.unit??''}`:'';
  const drained=quantityAndUnit(drainedText);
  const drainedGrams=positiveNumber(raw.drainedWeightGrams)??(drained?.unit==='g'?drained.quantity:null);
  if(pack&&drainedGrams!==null)pack.drainedGrams=drainedGrams;
  const url=firstString(raw,['url','productUrl']),imageUrl=firstString(raw,['imageUrl','image']);
  const product: RetailProduct = {
    id,
    ean,
    name,
    brand: firstString(raw, ['manufacturerName', 'manufacturer', 'brand', 'brandName']),
    categories: parseCategories(raw),
    pack,
    ingredientsText: firstString(raw, ['listOfIngredients', 'ingredientsText', 'ingredients']),
    ...(url ? { url } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };

  const checked = checkedAt.toISOString();
  const explicitScope = readStoreScope(raw);
  const scopeWasReturned = ['store', 'storeScope', 'scope'].some(key => Object.prototype.hasOwnProperty.call(raw, key));
  const verifiedForRequestedStore = storeScopeVerified
    && scope.channel === 'pickup'
    && scope.slotId === undefined
    && (!scopeWasReturned || (explicitScope !== null && explicitScope.storeId === scope.storeId
      && explicitScope.channel === scope.channel
      && explicitScope.slotId === undefined));
  const price = verifiedForRequestedStore ? parsePrice(raw, checkedAt) : null;
  const stock = nestedRecords(raw, ['stock', 'availability']).find(value =>
    typeof value.outOfStock === 'boolean' || typeof value.stockLevel === 'number');
  const availability: ProductObservation['availability'] = !verifiedForRequestedStore ? 'unknown'
    : typeof raw.availableOnline === 'boolean'
    ? raw.availableOnline ? 'available' : 'unavailable'
    : stock
    ? stock.outOfStock === true || (typeof stock.stockLevel === 'number' && stock.stockLevel <= 0)
      ? 'unavailable'
      : 'available'
    : 'unknown';
  const sourceExpiry = Math.min(checkedAt.getTime() + 24 * 60 * 60_000,
    price?.validUntil ? Date.parse(price.validUntil) : Infinity);

  return {
    retailer: 'coop',
    scope,
    product,
    price,
    availability: verifiedForRequestedStore ? availability : 'unknown',
    checkedAt: checked,
    // Source observations can support daily reference snapshots; the local resolver
    // applies its own shorter 30-minute cache window.
    expiresAt: new Date(sourceExpiry).toISOString(),
    storeScopeVerified: verifiedForRequestedStore,
  };
}

function parsePrice(raw: Record<string, unknown>, checkedAt: Date): RetailPrice | null {
  const coopPrice = coopPublicPrice(raw, checkedAt);
  if (coopPrice) return coopPrice;
  const priceSource = record(raw.price) ?? raw;
  const amount = parseMoney(priceSource.value ?? priceSource.amount ?? priceSource.price);
  if (amount === null) return null;
  // Legacy generic detail's `priceUnit` is a comparison-unit label, not a
  // verified selling unit. Only the first-party `salesUnit` path can set kg.
  const basis: RetailPrice['basis'] = 'pack';
  const promotions = Array.isArray(raw.potentialPromotions) ? raw.potentialPromotions
    : Array.isArray(raw.offers) ? raw.offers : [];
  const active = promotions.map(record).filter((offer): offer is Record<string, unknown> => offer !== null);
  const memberOnly = active.some(offer => offer.memberOnly === true || offer.membersOnly === true || offer.customerGroup === 'member');
  const minimum = active.map(offer => positiveNumber(offer.qualifyingCount ?? offer.minimumQuantity)).find(value => value !== null) ?? null;
  const validFrom = active.map(offer => isoDate(offer.startDate ?? offer.validFrom)).find(value => value !== null) ?? null;
  const validUntil = active.map(offer => isoDate(offer.endDate ?? offer.validUntil)).find(value => value !== null) ?? null;
  return {
    amountOre: amount,
    basis,
    depositOre: parseMoney(raw.depositPrice ?? record(raw.deposit)?.value),
    memberOnly,
    minimumQuantity: minimum,
    validFrom,
    validUntil,
  };
}

function coopPublicPrice(raw: Record<string, unknown>, checkedAt: Date): RetailPrice | null {
  const salesUnit = (firstString(raw, ['salesUnit']) ?? '').toLowerCase();
  const soldByWeight = salesUnit === 'vikt' || salesUnit === 'kg';
  const regularData = record(soldByWeight ? raw.salesPriceData : raw.piecePriceData);
  const ordinaryAmount = parseMoney(regularData?.b2cPrice);
  if (ordinaryAmount === null) return null;

  const now = checkedAt.getTime();
  const offers = Array.isArray(raw.onlinePromotions) ? raw.onlinePromotions
    .map(record).filter((offer): offer is Record<string, unknown> => offer !== null) : [];
  const eligible = offers.flatMap(offer => {
    const start = isoDate(offer.startDate);
    const end = isoDate(offer.endDate);
    const promoData = record(soldByWeight ? offer.priceData : offer.piecePriceData);
    const amount = parseMoney(promoData?.b2cPrice);
    const type = firstString(offer, ['type']);
    const minRaw = offer.minimumQuantity ?? offer.qualifyingCount ?? offer.numberOfProductRequired;
    const min = minRaw === undefined || minRaw === null ? null : positiveNumber(minRaw);
    if (offer.medMeraRequired !== false || type !== 'FIXED_PRICE' || amount === null
      || (minRaw !== undefined && minRaw !== null && min !== 1)
      || start === null || end === null
      || Date.parse(start) > now || Date.parse(end) < now) return [];
    return [{ amount, start, end }];
  }).sort((a, b) => a.amount - b.amount);
  const selected = eligible[0];
  const basis: RetailPrice['basis'] = soldByWeight ? 'kg' : 'pack';
  return {
    amountOre: selected?.amount ?? ordinaryAmount,
    basis,
    depositOre: parseMoney(record(raw.depositData)?.b2cPrice),
    memberOnly: false,
    minimumQuantity: selected ? 1 : null,
    validFrom: selected?.start ?? null,
    validUntil: selected?.end ?? null,
  };
}

function parsePack(raw: Record<string, unknown>): RetailProduct['pack'] {
  const candidates: unknown[] = [raw.packageSize, raw.size, raw.netContent, raw.quantity];
  const nested = record(raw.package) ?? record(raw.productMeasure);
  if (nested) candidates.unshift(nested);
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      const rawUnit = firstString(raw, ['packageSizeUnit', 'packageUnit', 'unitOfMeasure', 'unit']) ?? '';
      const unit = rawUnit.replace(/\s*(?:ungefärlig\s+vikt|approx(?:imate)?\s+weight)\s*/i, '').toLowerCase();
      const parsed = quantityAndUnit(`${candidate} ${unit}`);
      if (parsed) return { ...parsed, approximate: /ungefärlig|approx/i.test(rawUnit)
        || /ungefärlig|approx/i.test(firstString(raw, ['packageSizeInformation']) ?? '') };
    }
    if (typeof candidate === 'string') {
      const parsed = quantityAndUnit(candidate);
      if (parsed) return { ...parsed, approximate: false };
    }
    if (isRecord(candidate)) {
      const quantity = positiveNumber(candidate.value ?? candidate.quantity ?? candidate.amount);
      const unit = firstString(candidate, ['unit', 'unitOfMeasure', 'unitCode']);
      const parsed = quantity && unit ? quantityAndUnit(`${quantity} ${unit}`) : null;
      if (parsed) return { ...parsed, approximate: candidate.approximate === true };
    }
  }
  return null;
}

function quantityAndUnit(value: string): { quantity: number; unit: 'g' | 'ml' | 'piece' } | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(kilograms?|kg|grams?|g|mg|millilit(?:er|re)s?|liters?|litres?|l|ml|cl|st|styck|pcs?|piece|pieces)?\s*$/i.exec(value);
  if (!match) return null;
  const quantity = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const unit = (match[2] ?? 'st').toLowerCase();
  if (['kg', 'kilogram', 'kilograms', 'g', 'gram', 'grams', 'mg'].includes(unit)) {
    const factor = ['kg', 'kilogram', 'kilograms'].includes(unit) ? 1000 : unit === 'mg' ? 0.001 : 1;
    return { quantity: quantity * factor, unit: 'g' };
  }
  if (['l', 'liter', 'litre', 'liters', 'litres', 'ml', 'milliliter', 'millilitre', 'milliliters', 'millilitres', 'cl'].includes(unit)) {
    const factor = ['l', 'liter', 'litre', 'liters', 'litres'].includes(unit) ? 1000 : unit === 'cl' ? 10 : 1;
    return { quantity: quantity * factor, unit: 'ml' };
  }
  return { quantity, unit: 'piece' };
}

function productRecord(payload: unknown): Record<string, unknown> | null {
  let data = unwrap(payload);
  if (Array.isArray(data)) data = data.length === 1 ? data[0] : null;
  if (!isRecord(data)) return null;
  const search = searchItems(data);
  if (search?.items.length === 1) return search.items[0];
  if (isRecord(data.product)) return data.product;
  return data;
}

function searchItems(payload: unknown): { count: number; items: Record<string, unknown>[] } | null {
  const raw = unwrap(payload);
  if (!isRecord(raw) || !isRecord(raw.results) || !Array.isArray(raw.results.items)
    || typeof raw.results.count !== 'number' || !Number.isSafeInteger(raw.results.count) || raw.results.count < 0
    || raw.results.items.some(item => !isRecord(item))) return null;
  const items = raw.results.items as Record<string, unknown>[];
  const count = raw.results.count;
  if (count < items.length) return null;
  return { count, items };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,9}$/.test(cursor)) throw new Error('invalid_coop_cursor');
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error('invalid_coop_cursor');
  return offset;
}

function validatePricingScope(scope: StoreScope): void {
  validateScope(scope);
  if (scope.channel !== 'pickup' || scope.slotId !== undefined) {
    throw new RetailerUnsupportedError('coop', 'requested_price_scope');
  }
}

function unwrap(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if ('data' in payload) return payload.data;
  if ('result' in payload) return payload.result;
  return payload;
}

function parseCategories(raw: Record<string, unknown>): string[] {
  if (Array.isArray(raw.navCategories)) {
    const categories: string[] = [], seen = new Set<string>();
    const add = (value: unknown) => {
      const category = record(value);
      if (!category) return;
      const code = firstString(category, ['code', 'id']);
      if (code && !seen.has(code)) { seen.add(code); categories.push(code); }
      if (Array.isArray(category.superCategories)) category.superCategories.forEach(add);
    };
    raw.navCategories.forEach(add);
    return categories;
  }
  const candidates = raw.categories ?? raw.categoryCodes ?? raw.category;
  if (!Array.isArray(candidates)) return typeof candidates === 'string' ? [candidates] : [];
  return candidates.map(value => typeof value === 'string' ? value
    : isRecord(value) ? firstString(value, ['code', 'id', 'name', 'title']) : null)
    .filter((value): value is string => value !== null);
}

function readStoreScope(raw: Record<string, unknown>): { storeId: string; channel: string; slotId?: string } | null {
  const scope = record(raw.store) ?? record(raw.storeScope) ?? record(raw.scope);
  if (!scope) return null;
  const storeId = firstString(scope, ['storeId', 'id', 'code']);
  const channel = firstString(scope, ['channel', 'salesChannel', 'fulfillmentType']);
  const slotId = firstString(scope, ['slotId', 'deliverySlotId']);
  return storeId && channel ? { storeId, channel, ...(slotId ? { slotId } : {}) } : null;
}

function parseMoney(value: unknown): number | null {
  if (isRecord(value)) return parseMoney(value.value ?? value.amount ?? value.formattedValue);
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).replace(/\u00a0/g, ' ').replace(/kr/gi, '').trim();
  const normalized = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function nestedRecords(raw: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const key of keys) {
    const child = record(raw[key]);
    if (child) result.push(child);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

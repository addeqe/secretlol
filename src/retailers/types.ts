export type RetailerId = 'coop' | 'ica';
export type SalesChannel = 'pickup' | 'delivery';
export type QuantityUnit = 'g' | 'ml' | 'piece';
export type StoreScope = { storeId: string; channel: SalesChannel; slotId?: string };
export type RetailStore = { retailer: RetailerId; id: string; name: string;
  channels: SalesChannel[]; postalCode?: string; address?: string; url?: string };
export type RetailCategory = { id: string; name: string; children: RetailCategory[] };
export type RetailPack = { quantity: number; unit: QuantityUnit; approximate: boolean; drainedGrams?: number | null };
export type RetailProduct = { id: string; ean: string | null; name: string; brand: string | null;
  categories: string[]; pack: RetailPack | null; ingredientsText: string | null;
  url?: string; imageUrl?: string };
export type RetailPrice = { amountOre: number; basis: 'pack' | 'kg' | 'l';
  depositOre: number | null; memberOnly: boolean; minimumQuantity: number | null;
  validFrom: string | null; validUntil: string | null };
export type ProductObservation = { retailer: RetailerId; scope: StoreScope;
  product: RetailProduct; price: RetailPrice | null;
  availability: 'available' | 'unavailable' | 'unknown';
  checkedAt: string; expiresAt: string; storeScopeVerified: boolean };
export type RetailPage = { products: ProductObservation[]; nextCursor: string | null;
  total: number | null; scope: StoreScope; categoryId: string };
export type RetailCapabilities = { stores: boolean; categories: boolean; browse: boolean;
  productLookup: boolean; batchLookup: boolean; verifiedStorePricing: boolean;
  notes: string[] };
export type RetailTransport = (url: string, init?: RequestInit) => Promise<Response>;
export interface RetailClient {
  readonly retailer: RetailerId;
  readonly capabilities: RetailCapabilities;
  stores(postalCode: string): Promise<RetailStore[]>;
  categories(scope: StoreScope): Promise<RetailCategory[]>;
  browse(scope: StoreScope, categoryId: string, cursor?: string): Promise<RetailPage>;
  products(scope: StoreScope, productIds: string[]): Promise<ProductObservation[]>;
}
export class RetailerUnsupportedError extends Error {
  readonly retailer: RetailerId;
  readonly operation: string;
  constructor(retailer: RetailerId, operation: string) {
    super(`${retailer}_${operation}_not_verified`);
    this.name = 'RetailerUnsupportedError';
    this.retailer = retailer;
    this.operation = operation;
  }
}
export function scopeKey(retailer: RetailerId, scope: StoreScope): string {
  return JSON.stringify([retailer, scope.storeId, scope.channel, scope.slotId ?? null]);
}
export function validateScope(scope: StoreScope): void {
  if (!scope || typeof scope.storeId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(scope.storeId)
    || !['pickup', 'delivery'].includes(scope.channel)
    || scope.slotId !== undefined && (typeof scope.slotId !== 'string' || !scope.slotId.length || scope.slotId.length > 100)) {
    throw new Error('invalid_store_scope');
  }
}
export function postalCode(value: string): string {
  if (typeof value !== 'string' || !/^\d{3}\s?\d{2}$/.test(value)) throw new Error('invalid_postal_code');
  return value.replace(/\s/g, '');
}
export function productId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

// Compatible IDs are explicit, reviewed eligibility sets, not fuzzy name matches.
export type IngredientDemand = { ingredientId: string; name: string; quantity: number | null;
  unit: QuantityUnit | null; approvedProductIds: string[]; nonPurchased?: boolean };
export type BasketRequest = { retailer: RetailerId; scope: StoreScope;
  demands: IngredientDemand[]; observations: ProductObservation[];
  now?: number; maxStates?: number; maxWork?: number; budgetOre?: number };
export type BasketLine = { productId: string; name: string; packs: number | null;
  quantity: number; unit: QuantityUnit; consumedQuantity: number; leftoverQuantity: number;
  consumedCostOre: number; purchaseCostOre: number; depositOre: number };
export type BasketResult = { complete: boolean; optimizationComplete: boolean;
  consumedCostOre: number | null; purchaseCostOre: number | null;
  knownPurchaseCostOre: number; withinBudget: boolean | null; lines: BasketLine[];
  unresolved: Array<{ ingredientId: string; reason: string }>; statesExplored: number; workExplored: number };
export type MenuFinalist = { id: string; demands: IngredientDemand[]; referenceCostOre: number | null };
export type RankedMenu = { id: string; referenceCostOre: number | null; basket: BasketResult };

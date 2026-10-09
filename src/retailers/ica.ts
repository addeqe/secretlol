import {
  postalCode as normalizePostalCode,
  RetailerUnsupportedError,
  validateScope,
  type RetailCapabilities,
  type RetailCategory,
  type RetailClient,
  type RetailPage,
  type RetailStore,
  type RetailTransport,
  type StoreScope,
} from './types.ts';

const STORE_API = 'https://handla.ica.se/api/store/v1';
const STORE_PAGE = 'https://handlaprivatkund.ica.se/stores';
const STORE_WEB_API = 'https://handlaprivatkund.ica.se/stores';

type IcaStoreRecord = {
  id?: unknown;
  accountId?: unknown;
  name?: unknown;
  city?: unknown;
  street?: unknown;
  zipCode?: unknown;
  deliveryMethods?: unknown;
  slug?: unknown;
};

type IcaStoreResponse = {
  forHomeDelivery?: unknown;
  forPickupDelivery?: unknown;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function channelValues(value: unknown): Array<'pickup' | 'delivery'> {
  if (!Array.isArray(value)) return [];
  const channels: Array<'pickup' | 'delivery'> = [];
  for (const method of value) {
    if (method === 'PICKUP' && !channels.includes('pickup')) channels.push('pickup');
    if (method === 'HOME_DELIVERY' && !channels.includes('delivery')) channels.push('delivery');
  }
  return channels;
}

function parseStore(value: unknown, inferredChannel: 'pickup' | 'delivery'): RetailStore | null {
  if (!record(value)) return null;
  const source = value as IcaStoreRecord;
  const accountId = string(source.accountId);
  const name = string(source.name);
  if (!accountId || !/^[a-zA-Z0-9_-]{1,100}$/.test(accountId) || !name) return null;

  const channels = channelValues(source.deliveryMethods);
  if (!channels.includes(inferredChannel)) channels.push(inferredChannel);
  return {
    retailer: 'ica',
    // ICA's store page uses accountId in /stores/{accountId}; the branch code is `id`.
    id: accountId,
    name,
    channels,
    ...(string(source.zipCode) ? { postalCode: string(source.zipCode)! } : {}),
    ...(string(source.street) || string(source.city)
      ? { address: [string(source.street), string(source.city)].filter(Boolean).join(', ') }
      : {}),
    url: `${STORE_PAGE}/${encodeURIComponent(accountId)}`,
  };
}

function mergeStores(stores: RetailStore[]): RetailStore[] {
  const byId = new Map<string, RetailStore>();
  for (const store of stores) {
    const existing = byId.get(store.id);
    if (!existing) {
      byId.set(store.id, store);
      continue;
    }
    byId.set(store.id, {
      ...existing,
      channels: [...new Set([...existing.channels, ...store.channels])],
      postalCode: existing.postalCode ?? store.postalCode,
      address: existing.address ?? store.address,
      url: existing.url ?? store.url,
    });
  }
  return [...byId.values()];
}

export class IcaClient implements RetailClient {
  readonly retailer = 'ica' as const;
  readonly capabilities: RetailCapabilities = {
    stores: true,
    categories: true,
    browse: false,
    productLookup: false,
    batchLookup: false,
    verifiedStorePricing: false,
    notes: [
      'Postcode store resolution is available from ICA’s public store endpoint.',
      'Store-scoped categories are available through the selected store page base path. Product listing and price behavior remain unverified.',
      'Generic ICA catalogue pages or product prices are not treated as store-specific observations.',
    ],
  };

  private readonly transport: RetailTransport;

  constructor(options: { transport?: RetailTransport } = {}) {
    this.transport = options.transport ?? fetch;
  }

  async stores(postalCode: string): Promise<RetailStore[]> {
    const zip = normalizePostalCode(postalCode);
    const url = new URL(STORE_API);
    url.searchParams.set('zip', zip);
    url.searchParams.set('customerType', 'B2C');

    const response = await this.transport(url.toString(), { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`ica_store_lookup_http_${response.status}`);
    const data: unknown = await response.json();
    if (!record(data)) throw new Error('ica_store_lookup_invalid_response');

    const source = data as IcaStoreResponse;
    if (!Array.isArray(source.forHomeDelivery) || !Array.isArray(source.forPickupDelivery)) {
      throw new Error('ica_store_lookup_invalid_response');
    }
    const stores: RetailStore[] = [];
    for (const item of source.forHomeDelivery) {
      const store = parseStore(item, 'delivery');
      if (store) stores.push(store);
    }
    for (const item of source.forPickupDelivery) {
      const store = parseStore(item, 'pickup');
      if (store) stores.push(store);
    }
    return mergeStores(stores);
  }

  async categories(scope: StoreScope): Promise<RetailCategory[]> {
    validateScope(scope);
    const url = new URL(`${encodeURIComponent(scope.storeId)}/api/webproductpagews/v1/categories`, `${STORE_WEB_API}/`);
    url.searchParams.set('decoration', 'false');
    url.searchParams.set('categoryDepth', '2');
    const response = await this.transport(url.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`ica_categories_http_${response.status}`);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error('ica_categories_invalid_response'); }
    if (!Array.isArray(payload)) throw new Error('ica_categories_invalid_response');
    return payload.map(parseIcaCategory);
  }

  async browse(scope: StoreScope, _categoryId: string, _cursor?: string): Promise<RetailPage> {
    validateScope(scope);
    throw new RetailerUnsupportedError('ica', 'browse');
  }

  async products(scope: StoreScope, _productIds: string[]): Promise<never[]> {
    validateScope(scope);
    throw new RetailerUnsupportedError('ica', 'product_lookup');
  }
}

function parseIcaCategory(value: unknown): RetailCategory {
  if (!record(value)) throw new Error('ica_categories_invalid_category');
  const id = string(value.categoryId);
  const name = string(value.name);
  const children = value.childCategories ?? [];
  if (!id || !name || !Array.isArray(children)) throw new Error('ica_categories_invalid_category');
  return { id, name, children: children.map(parseIcaCategory) };
}

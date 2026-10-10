import { normalize } from './products.ts';
import type { Category, Entry, Page, Scan, Store } from './types.ts';

export interface Source {
  requests: number;
  initialize(storeId: string): Promise<Store>;
  verifyStore(storeId: string): Promise<Store>;
  categories(storeId: string): Promise<Category>;
  category(path: string, page: number): Promise<Page>;
}
const TRANSIENT_PAGINATION_ERRORS = /Unexpected Willys pagination\/product response|changed during pagination|Missing results|Duplicate product|Incomplete category/;
export async function crawl(source: Source, storeId: string, maxProducts = 20000,
  progress: (message: string) => void = console.log): Promise<Scan> {
  const startedAt = new Date().toISOString(), store = await source.initialize(storeId);
  const tree = await source.categories(storeId);
  const roots = tree?.children?.filter(c => c.valid !== false);
  if (!roots?.length || roots.some(c => typeof c.url !== 'string' || !/^[a-z0-9_\/-]+$/i.test(c.url))) {
    throw new Error('No valid root categories returned.');
  }
  const entries = new Map<string, Entry>(), categories: Scan['categories'] = [];
  for (const root of roots) {
    const path = root.url.replace(/^\/c\//, '').replace(/^\/+|\/+$/g, '');
    let categoryEntriesAfterValidation: Entry[] | undefined;
    let expected = 0, pages = 0;
    let lastError: unknown;
    // The source catalogue can change while a category is being paged. Retry
    // that category once from page zero, keeping partial rows private until the
    // complete page set has passed all count and duplicate checks.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const first = await source.category(path, 0);
        expected = first.pagination.totalNumberOfResults;
        pages = first.pagination.numberOfPages;
        const size = first.pagination.pageSize;
        const codes = new Set<string>();
        const categoryEntries = new Map<string, Entry>();
        let newProductCount = 0;
        for (let page = 0; page < Math.max(1, pages); page++) {
          const data = page === 0 ? first : await source.category(path, page);
          if (data.pagination.currentPage !== page) {
            throw new Error(`Unexpected Willys pagination/product response for ${path}, page ${page}.`);
          }
          if (data.pagination.totalNumberOfResults !== expected || data.pagination.numberOfPages !== pages || data.pagination.pageSize !== size) {
            throw new Error(`Category ${path} changed during pagination.`);
          }
          const expectedPageCount = Math.min(size, Math.max(0, expected - page * size));
          if (data.results.length !== expectedPageCount) throw new Error(`Missing results in ${path}, page ${page}.`);
          const observedAt = new Date().toISOString();
          for (const raw of data.results) {
            if (codes.has(raw.code)) throw new Error(`Duplicate product in ${path}; pagination may have moved.`);
            codes.add(raw.code);
            // Keep unavailable online products; omit items explicitly marked offline.
            if (raw.online === false) continue;
            if (!entries.has(raw.code) && !categoryEntries.has(raw.code)) newProductCount++;
            categoryEntries.set(raw.code, normalize(raw, root.title, observedAt));
            if (entries.size + newProductCount > maxProducts) throw new Error('Product budget exceeded. No truncated catalogue will be published.');
          }
        }
        if (codes.size !== expected) throw new Error(`Incomplete category ${path}: ${codes.size}/${expected}.`);
        categoryEntriesAfterValidation = [...categoryEntries.values()];
        break;
      } catch (error) {
        lastError = error;
        if (attempt > 0 || !(error instanceof Error) || !TRANSIENT_PAGINATION_ERRORS.test(error.message)) throw error;
        progress(`${root.title}: source page changed or was malformed; retrying this category once from page 0.`);
      }
    }
    if (!categoryEntriesAfterValidation) throw lastError instanceof Error ? lastError : new Error(`Incomplete category ${path}.`);
    for (const entry of categoryEntriesAfterValidation) {
      const previous = entries.get(entry.code);
      if (previous) entry.categories = [...new Set([...previous.categories, ...entry.categories])].sort();
      entries.set(entry.code, entry);
      if (entries.size > maxProducts) throw new Error('Product budget exceeded. No truncated catalogue will be published.');
    }
    categories.push({ path, expected, collected: expected, pages });
    progress(`${root.title}: ${expected} products, ${pages} pages`);
  }
  await source.verifyStore(storeId);
  const after = await source.categories(storeId);
  const rootIdentity = (root: Category) => (root.children ?? []).filter(c => c.valid !== false).map(c => c.url).sort().join('|');
  if (rootIdentity(after) !== rootIdentity(tree)) throw new Error('Category tree changed during the scan.');
  if (!entries.size) throw new Error('Empty catalogue. The previous catalogue is retained.');
  return { store, entries: [...entries.values()].sort((a, b) => a.code.localeCompare(b.code)), categories,
    requests: source.requests, startedAt, completedAt: new Date().toISOString() };
}

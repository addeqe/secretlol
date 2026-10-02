import { normalize } from './products.ts';
import type { Category, Entry, Page, Scan, Store } from './types.ts';

export interface Source {
  requests: number;
  initialize(storeId: string): Promise<Store>;
  verifyStore(storeId: string): Promise<Store>;
  categories(storeId: string): Promise<Category>;
  category(path: string, page: number): Promise<Page>;
}
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
    const first = await source.category(path, 0), expected = first.pagination.totalNumberOfResults;
    const pages = first.pagination.numberOfPages, size = first.pagination.pageSize;
    const codes = new Set<string>();
    for (let page = 0; page < Math.max(1, pages); page++) {
      const data = page === 0 ? first : await source.category(path, page);
      if (data.pagination.totalNumberOfResults !== expected || data.pagination.numberOfPages !== pages || data.pagination.pageSize !== size) {
        throw new Error(`Category ${path} changed during pagination. Retry a full scan.`);
      }
      const expectedPageCount = Math.min(size, Math.max(0, expected - page * size));
      if (data.results.length !== expectedPageCount) throw new Error(`Missing results in ${path}, page ${page}.`);
      const observedAt = new Date().toISOString();
      for (const raw of data.results) {
        if (codes.has(raw.code)) throw new Error(`Duplicate product in ${path}; pagination may have moved.`);
        codes.add(raw.code);
        // Keep unavailable online products; omit items explicitly marked offline.
        if (raw.online === false) continue;
        const entry = normalize(raw, root.title, observedAt), previous = entries.get(entry.code);
        if (previous) entry.categories = [...new Set([...previous.categories, ...entry.categories])].sort();
        entries.set(entry.code, entry);
        if (entries.size > maxProducts) throw new Error('Product budget exceeded. No truncated catalogue will be published.');
      }
    }
    if (codes.size !== expected) throw new Error(`Incomplete category ${path}: ${codes.size}/${expected}.`);
    categories.push({ path, expected, collected: codes.size, pages });
    progress(`${root.title}: ${codes.size} products, ${pages} pages`);
  }
  await source.verifyStore(storeId);
  const after = await source.categories(storeId);
  const rootIdentity = (root: Category) => (root.children ?? []).filter(c => c.valid !== false).map(c => c.url).sort().join('|');
  if (rootIdentity(after) !== rootIdentity(tree)) throw new Error('Category tree changed during the scan.');
  if (!entries.size) throw new Error('Empty catalogue. The previous catalogue is retained.');
  return { store, entries: [...entries.values()].sort((a, b) => a.code.localeCompare(b.code)), categories,
    requests: source.requests, startedAt, completedAt: new Date().toISOString() };
}

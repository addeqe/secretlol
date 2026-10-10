// Cookie handling and category protocol adapted from ErikHellman/willys-agent (MIT).
// See docs/upstream.md and THIRD_PARTY_LICENSES.md.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Category, Page, SourceProduct, Store } from './types.ts';

export function inVisitWindow(now: Date, start = 240, end = 525) {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
export class WillysClient {
  cookies = new Map<string, string>();
  csrf: string | null = null;
  requests = 0;
  delayMs = 10000;
  windowStart = 240;
  windowEnd = 525;
  private lastRequest = 0;
  private started = Date.now();
  private disallowed: string[] = [];
  private fetcher: typeof fetch;
  private maxRequests: number;
  private maxMinutes: number;
  private now: () => number;
  private wait: (ms: number) => Promise<unknown>;
  constructor(options: { fetcher?: typeof fetch; maxRequests?: number; maxMinutes?: number;
    now?: () => number; wait?: (ms: number) => Promise<unknown> } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.maxRequests = options.maxRequests ?? 300;
    this.maxMinutes = options.maxMinutes ?? 55;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? sleep;
    this.started = this.now();
  }
  async request(path: string, method = 'GET', text = false): Promise<any> {
    const url = new URL(path, 'https://www.willys.se');
    if (url.origin !== 'https://www.willys.se') throw new Error('Untrusted Willys URL');
    if (this.disallowed.some(p => url.pathname.startsWith(p))) throw new Error(`robots.txt disallows ${url.pathname}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.wait(Math.max(0, this.lastRequest + this.delayMs - this.now()));
      if (!inVisitWindow(new Date(this.now()), this.windowStart, this.windowEnd)) {
        throw new Error('Outside Willys crawl window (default 04:00–08:45 UTC). Run the scheduled workflow tomorrow.');
      }
      if (this.requests >= this.maxRequests || this.now() - this.started > this.maxMinutes * 60000) {
        throw new Error('Willys request/runtime budget reached. Incomplete scan will not be published.');
      }
      this.lastRequest = this.now(); this.requests++;
      const headers: Record<string, string> = { Accept: text ? 'text/plain' : 'application/json',
        'User-Agent': 'WillysCatalog/0.1 (daily catalogue sync)' };
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET' && this.csrf) headers['X-CSRF-TOKEN'] = this.csrf;
      let response: Response;
      try { response = await this.fetcher(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
      catch { if (attempt < 2) continue; throw new Error(`Willys network error: ${url.pathname}`); }
      for (const cookie of response.headers.getSetCookie()) {
        const part = cookie.split(';')[0], eq = part.indexOf('=');
        if (eq > 0) this.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = Number(response.headers.get('Retry-After'));
        await this.wait(Math.min(60000, Math.max(this.delayMs, Number.isFinite(retry) ? retry * 1000 : 0)));
        continue;
      }
      if (!response.ok) throw new Error(`Willys HTTP ${response.status}: ${url.pathname}. No catalogue published.`);
      let raw: string;
      try { raw = await response.text(); }
      catch {
        // The timeout signal stays active after fetch resolves its headers.
        // A slow/interrupted response body must retry the same page as well.
        if (attempt < 2) {
          console.warn(`Willys response body interrupted: ${url.pathname}${url.search}; retry ${attempt + 2}/3.`);
          continue;
        }
        throw new Error(`Willys response body failed after 3 attempts: ${url.pathname}${url.search}. No catalogue published.`);
      }
      if (raw.length > 6 * 1024 * 1024) throw new Error('Oversized Willys response');
      if (text) return raw;
      try { return JSON.parse(raw); } catch { throw new Error(`Non-JSON Willys response: ${url.pathname}`); }
    }
    throw new Error('Willys request failed');
  }
  async initialize(storeId: string) {
    const robots = await this.request('/robots.txt', 'GET', true) as string;
    const delay = /Crawl-delay:\s*(\d+(?:\.\d+)?)/i.exec(robots);
    if (delay) this.delayMs = Math.max(10000, Number(delay[1]) * 1000);
    const visit = /Visit-time:\s*(\d{2})(\d{2})-(\d{2})(\d{2})/i.exec(robots);
    if (visit) { this.windowStart = Number(visit[1]) * 60 + Number(visit[2]); this.windowEnd = Number(visit[3]) * 60 + Number(visit[4]); }
    this.disallowed = [...robots.matchAll(/^Disallow:\s*(\/[^\s#]*)/gim)].map(m => m[1]);
    await this.request('/api/config');
    const token = await this.request('/axfood/rest/csrf-token');
    if (typeof token !== 'string' || !token) throw new Error('Unexpected Willys CSRF response');
    this.csrf = token;
    const params = new URLSearchParams({ storeId, activelySelected: 'true', forceAsPickingStore: 'true' });
    await this.request(`/axfood/rest/v2/store/activate?${params}`, 'POST');
    return this.verifyStore(storeId);
  }
  async verifyStore(storeId: string): Promise<Store> {
    const store = await this.request('/axfood/rest/v2/store/active');
    if (String(store.storeId) !== storeId || typeof store.name !== 'string' || store.onlineStore !== true) {
      throw new Error('Willys active store does not match the selected online store.');
    }
    return { storeId, name: store.name, onlineStore: true };
  }
  async categories(storeId: string): Promise<Category> {
    return this.request(`/axfood/rest/v2/leftMenu/categorytree?${new URLSearchParams({ storeId, deviceType: 'OTHER' })}`);
  }
  async category(path: string, page = 0): Promise<Page> {
    const data = await this.request(`/axfood/rest/v2/c?${new URLSearchParams({ p: path, page: String(page), size: '100', sort: 'name-asc' })}`);
    validatePage(data, page, path); return data;
  }
  async stores() { return this.request('/axfood/rest/v2/store?online=true'); }
}
export function validatePage(data: any, page: number, categoryPath?: string): asserts data is Page {
  const p = data?.pagination;
  const resultsAreArray = Array.isArray(data?.results);
  const invalidProducts = resultsAreArray ? data.results.filter((item: SourceProduct) => !item || typeof item.code !== 'string' || !item.code || typeof item.name !== 'string' || !item.name).length : null;
  const problems: string[] = [];
  if (!resultsAreArray) problems.push('results is not an array');
  if (!p) problems.push('pagination is missing');
  else {
    if (![p.currentPage, p.pageSize, p.numberOfPages, p.totalNumberOfResults].every(Number.isSafeInteger)) problems.push('pagination fields are not safe integers');
    if (p.currentPage !== page) problems.push('currentPage differs from request');
    if (p.pageSize < 1 || p.pageSize > 100) problems.push('pageSize is outside 1..100');
    if (p.numberOfPages < 0 || p.totalNumberOfResults < 0) problems.push('negative page or result count');
    if (Number.isSafeInteger(p.pageSize) && p.pageSize > 0 && Number.isSafeInteger(p.numberOfPages) && Number.isSafeInteger(p.totalNumberOfResults)
      && p.numberOfPages !== Math.ceil(p.totalNumberOfResults / p.pageSize)) problems.push('numberOfPages does not match totalNumberOfResults/pageSize');
  }
  if (invalidProducts) problems.push(`${invalidProducts} products lack a non-empty code or name`);
  if (problems.length) {
    const metadata = { currentPage: p?.currentPage ?? null, pageSize: p?.pageSize ?? null,
      numberOfPages: p?.numberOfPages ?? null, totalNumberOfResults: p?.totalNumberOfResults ?? null,
      resultsCount: resultsAreArray ? data.results.length : null };
    throw new Error(`Unexpected Willys pagination/product response for ${categoryPath ?? 'category'} page ${page}: ${problems.join('; ')}; metadata=${JSON.stringify(metadata)}. Incomplete scan will not be published.`);
  }
}

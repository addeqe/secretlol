import { CoopClient } from '../src/retailers/coop.ts';
import { IcaClient } from '../src/retailers/ica.ts';
import { cachedIngredientPolicy, observationUsable, productIdentity, reviewedProductPolicy, type ReviewedConnection } from '../src/retailers/identity.ts';
import { mappedConnections, type LocalMapping } from '../src/retailers/local-mapping.ts';
import { LocalProductResolver, MemoryObservationCache, type ObservationCache } from '../src/retailers/resolver.ts';
import { rankMenuFinalists } from '../src/retailers/basket.ts';
import { postalCode, productId, scopeKey, validateScope } from '../src/retailers/types.ts';
import type { IngredientDemand, MenuFinalist, ProductObservation, RetailClient, RetailerId, StoreScope, QuantityUnit } from '../src/retailers/types.ts';
import { canonicalAmount } from '../src/meal-cost.ts';
import type { IngredientAmount, AmountOverride } from '../src/meal-cost.ts';
import { DIETARY_POLICY_VERSION } from '../src/dietary-policy.ts';

export type RetailEnv = { COOP_DB?: D1Database; ICA_DB?: D1Database;
  RETAILERS_LIVE_ENABLED?: string; COOP_PUBLIC_SUBSCRIPTION_KEY?: string; COMPUTE_QUOTE_CACHE?: QuoteResponseCache };
export type RecipeDocument = { servings: number | null; recipe_yield: string | null; ingredients: IngredientAmount[] };
export type RecipeLoader = (ids: number[]) => Promise<Map<number, RecipeDocument>>;
type Manifest = { datasetId: string; inventoryHash: string };
const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (error: string, status = 400) => json({ error }, status);
const binding = (env: RetailEnv, retailer: RetailerId) => retailer === 'coop' ? env.COOP_DB : env.ICA_DB;
export function retailClient(env: RetailEnv, retailer: RetailerId): RetailClient {
  return retailer === 'coop' ? new CoopClient({ publicSubscriptionKey: env.COOP_PUBLIC_SUBSCRIPTION_KEY }) : new IcaClient();
}
function retailerId(v: unknown): v is RetailerId { return v === 'coop' || v === 'ica'; }
async function metadata(db: D1Database) {
  const result = await db.prepare('SELECT key,value FROM retail_meta').all<{key: string; value: string}>();
  return Object.fromEntries(result.results.map(r => [r.key, r.value]));
}
type ActiveRun = { id: string; checked_at: string; expires_at: string; checked_ids_json: string };
async function activeRun(db: D1Database, key: string): Promise<ActiveRun | null> {
  return await db.prepare(`SELECT r.id,r.checked_at,r.expires_at,r.checked_ids_json FROM retail_scope_state s
    JOIN retail_runs r ON r.id=s.active_run_id WHERE s.scope_key=?`).bind(key).first<ActiveRun>() ?? null;
}
async function observations(db: D1Database, retailer: RetailerId, scope: StoreScope, ids: string[],
  suppliedRun?: ActiveRun | null) {
  if (!ids.length) return [];
  const key = scopeKey(retailer, scope);
  const run = suppliedRun === undefined ? await activeRun(db, key) : suppliedRun;
  if (!run) return [];
  const checked = new Set<string>(JSON.parse(run.checked_ids_json));
  const result = await db.prepare(`SELECT observation_json FROM retail_products WHERE scope_key=?
    AND product_id IN (SELECT value FROM json_each(?))`).bind(key, JSON.stringify(ids)).all<{observation_json: string}>();
  return result.results.map(r => {
    const o = JSON.parse(r.observation_json) as ProductObservation;
    return checked.has(o.product.id) ? { ...o, checkedAt: run.checked_at, expiresAt: run.expires_at } : o;
  });
}

// Cache API is optional in offline tests. Cache failures should affect speed only.
export class WorkerObservationCache implements ObservationCache {
  readonly memory = new MemoryObservationCache();
  async get(key: string): Promise<ProductObservation | null> {
    return (await this.getMany([key])).get(key)??null;
  }
  async set(key: string, value: ProductObservation): Promise<void> {
    await this.setMany(new Map([[key,value]]));
  }
  async getMany(keys:string[]):Promise<Map<string,ProductObservation>> {
    const found=new Map<string,ProductObservation>();
    for(const key of keys){const value=await this.memory.get(key);if(value)found.set(key,value);}
    if(found.size===keys.length||typeof caches==='undefined')return found;
    try{
      const response=await (caches as CacheStorage & {default:Cache}).default.match(await this.request(keys));
      const values=response?await response.json() as Array<[string,ProductObservation]>:[];
      if(!Array.isArray(values)||values.length>keys.length)return found;
      const requestedKeys=new Set(keys);
      for(const value of values)if(Array.isArray(value)&&requestedKeys.has(value[0])&&value[1]){
        await this.memory.set(value[0],value[1]);found.set(value[0],value[1]);
      }
    }catch{/* Ignore a malformed or missing optional cache bundle. */}
    return found;
  }
  async setMany(values:Map<string,ProductObservation>):Promise<void> {
    for(const [key,value] of values)await this.memory.set(key,value);
    if (typeof caches === 'undefined') return;
    const seconds = Math.floor((Math.min(...[...values.values()].map(v=>Date.parse(v.expiresAt))) - Date.now()) / 1000);
    if (seconds < 1) return;
    try { await (caches as CacheStorage & {default:Cache}).default.put(await this.request([...values.keys()]), Response.json([...values], {headers: {'Cache-Control': `public, max-age=${seconds}`}})); }
    catch { /* A missed cache write must not prevent a correct quote. */ }
  }
  private async request(keys:string[]) {
    const bytes=new TextEncoder().encode(JSON.stringify([...keys].sort()));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const key=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
    return new Request(`https://retailer-cache.invalid/price-bundle/${key}`);
  }
}
const cache = new WorkerObservationCache();
const resolvers = new Map<string, LocalProductResolver>();
function resolver(env: RetailEnv, retailer: RetailerId) {
  // Separate resolver instances if configuration changes within an isolate.
  const key = JSON.stringify([retailer, env.COOP_PUBLIC_SUBSCRIPTION_KEY ?? null]);
  let found = resolvers.get(key);
  if (!found) { found = new LocalProductResolver(retailClient(env, retailer), cache); if (resolvers.size >= 4) resolvers.clear(); resolvers.set(key, found); }
  return found;
}

export type QuoteResponseCache = {
  readonly available: boolean;
  match(key: string, now: number): Promise<Response | null>;
  put(key: string, response: Response, expiresAt: number): Promise<void>;
};
const QUOTE_MEMORY_MAX_ENTRIES = 64;
const QUOTE_MEMORY_MAX_BYTES = 4 * 1024 * 1024;
const QUOTE_CACHE_MAX_BODY_BYTES = 256 * 1024;
const QUOTE_CACHE_MAX_KEY_BYTES = 64 * 1024;
type MemoryQuoteEntry = { body: string; expiresAt: number; bodyBytes: number; keyBytes: number; contentType: string };

async function readBoundedBody(response: Response, maximumBytes: number): Promise<{body: string; bytes: number} | null> {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return null;
  if (!response.body) return {body:'',bytes:0};
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      // A cloned Response body is a tee. Awaiting cancel on this branch may
      // wait for the untouched original branch, while quote handling awaits
      // this cache write before returning that original response.
      if (bytes > maximumBytes) { void reader.cancel().catch(()=>{}); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  const bodyBytes = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { bodyBytes.set(chunk,offset); offset += chunk.byteLength; }
  return {body:new TextDecoder().decode(bodyBytes),bytes};
}

export class WorkerQuoteResponseCache implements QuoteResponseCache {
  private readonly memoryEnabled: boolean;
  private readonly memory = new Map<string,MemoryQuoteEntry>();
  private memoryBytes = 0;
  constructor(options: {memoryEnabled?: boolean} = {}) { this.memoryEnabled = options.memoryEnabled ?? false; }
  get available() { return this.memoryEnabled || typeof caches !== 'undefined'; }
  private async request(key: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const hex = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
    return new Request(`https://retailer-cache.invalid/complete-quote/${hex}`);
  }
  async match(key: string, now: number): Promise<Response | null> {
    if (!this.available || new TextEncoder().encode(key).byteLength > QUOTE_CACHE_MAX_KEY_BYTES) return null;
    if (this.memoryEnabled) {
      const entry = this.memory.get(key);
      if (entry) {
        if (entry.expiresAt > now) {
          this.memory.delete(key); this.memory.set(key,entry);
          return new Response(entry.body,{status:200,headers:{'Content-Type':entry.contentType,
            'X-Quote-Cache-Expires':String(entry.expiresAt)}});
        }
        this.removeMemoryEntry(key,entry);
      }
    }
    if (typeof caches === 'undefined') return null;
    try {
      const response = await (caches as CacheStorage & {default: Cache}).default.match(await this.request(key));
      if (!response || response.status !== 200) return null;
      const expiresAt = Number(response.headers.get('X-Quote-Cache-Expires'));
      return Number.isFinite(expiresAt) && expiresAt > now ? response : null;
    } catch { return null; }
  }
  async put(key: string, response: Response, expiresAt: number): Promise<void> {
    if (!this.available || response.status !== 200 || new TextEncoder().encode(key).byteLength > QUOTE_CACHE_MAX_KEY_BYTES) return;
    const now = Date.now(), maxAge = Math.floor((expiresAt - now) / 1000);
    if (expiresAt <= now || maxAge < 1) return;
    try {
      const result = await readBoundedBody(response,QUOTE_CACHE_MAX_BODY_BYTES);
      if (!result) return;
      const keyBytes = new TextEncoder().encode(key).byteLength;
      if (this.memoryEnabled) this.remember(key,{body:result.body,expiresAt,bodyBytes:result.bytes,keyBytes,
        contentType:response.headers.get('Content-Type') ?? 'application/json'});
      if (typeof caches === 'undefined') return;
      await (caches as CacheStorage & {default: Cache}).default.put(await this.request(key), new Response(result.body, {
        status: 200, headers: {'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
          'Cache-Control': `public, max-age=${maxAge}`, 'X-Quote-Cache-Expires': String(expiresAt)},
      }));
    } catch { /* Cache failures must never change quote correctness; memory is retained. */ }
  }
  private remember(key:string,entry:MemoryQuoteEntry):void {
    const size=entry.keyBytes+entry.bodyBytes;
    if (size>QUOTE_MEMORY_MAX_BYTES) return;
    const previous=this.memory.get(key);
    if(previous)this.removeMemoryEntry(key,previous);
    while(this.memory.size>=QUOTE_MEMORY_MAX_ENTRIES||this.memoryBytes+size>QUOTE_MEMORY_MAX_BYTES){
      const oldest=this.memory.entries().next().value as [string,MemoryQuoteEntry]|undefined;
      if(!oldest)break;
      this.removeMemoryEntry(oldest[0],oldest[1]);
    }
    this.memory.set(key,entry);this.memoryBytes+=size;
  }
  private removeMemoryEntry(key:string,entry:MemoryQuoteEntry):void {
    if(this.memory.delete(key))this.memoryBytes-=entry.keyBytes+entry.bodyBytes;
  }
}
const quoteResponseCache = new WorkerQuoteResponseCache();

function quoteCacheRequestKey(body: unknown, meta: Record<string,string>, retailer: RetailerId,
  requestedScopeKey: string, scopeKeys: string[], runs: Map<string,ActiveRun | null>,
  mappings: Array<{reference_product_id:string;identity_json:string}>): string | null {
  if (!meta.connections_version) return null;
  const runIds = scopeKeys.map(key => [key, runs.get(key)?.id ?? null] as const);
  if (runIds.some(([,id]) => id === null)) return null;
  return JSON.stringify([body, retailer, meta.dataset_id, meta.inventory_hash, meta.policy_version,
    meta.connections_version, requestedScopeKey, runIds, mappings, 'complete-quote-cache-v1']);
}
function runCurrentForQuote(run: ActiveRun | null, now: number): boolean {
  if (!run) return false;
  const checked = Date.parse(run.checked_at), expires = Date.parse(run.expires_at);
  return Number.isFinite(checked) && checked <= now + 60_000 && now - checked < 86_400_000
    && Number.isFinite(expires) && expires > now;
}
function quoteCacheExpiry(now: number, local: boolean, runs: ActiveRun[], observations: ProductObservation[]): number {
  let expiry = now + (local ? 30 * 60_000 : 86_400_000);
  const include = (value: string | null | undefined) => {
    if (value == null || value === '') return true;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) { expiry = now; return false; }
    if (time > now) expiry = Math.min(expiry, time);
    return true;
  };
  for (const run of runs) {
    include(run.expires_at);
    const checked = Date.parse(run.checked_at);
    if (!Number.isFinite(checked)) return now;
    expiry = Math.min(expiry, checked + 86_400_000);
  }
  for (const observation of observations) {
    if (!include(observation.expiresAt)) return now;
    const checked = Date.parse(observation.checkedAt);
    if (!Number.isFinite(checked)) return now;
    expiry = Math.min(expiry, checked + 86_400_000);
    if (!include(observation.price?.validFrom) || !include(observation.price?.validUntil)) return now;
  }
  return expiry;
}

export async function retailerRoutes(request: Request, env: RetailEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return fail('method_not_allowed', 405);
  if (url.pathname === '/retailers/openapi.json') return json(retailerOpenApi(url.origin));
  const productRoute = /^\/retailers\/(coop|ica)\/products$/.exec(url.pathname);
  if (productRoute) {
    const retailer = productRoute[1] as RetailerId;
    const ids = (url.searchParams.get('ids') ?? '').split(',');
    if (!ids.length || ids.length > 100 || ids.some(id => !productId(id))) return fail('supply_1_to_100_product_ids');
    const db = binding(env, retailer);
    if (!db) return fail('retailer_database_not_connected', 503);
    const meta = await metadata(db);
    if (meta.retailer !== retailer || !meta.reference_scope) return fail('retailer_reference_not_configured', 503);
    let scope: StoreScope;
    try {
      const value = JSON.parse(meta.reference_scope);
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== retailer) throw new Error('invalid_scope');
      scope = { storeId:value[1], channel:value[2], ...(value[3] === null ? {} : {slotId:value[3]}) };
      validateScope(scope);
      if (scopeKey(retailer, scope) !== meta.reference_scope) throw new Error('invalid_scope');
    } catch { return fail('retailer_reference_not_configured', 503); }
    const unique = [...new Set(ids)], found = await observations(db, retailer, scope, unique), now = Date.now();
    const byId = new Map(found.map(o => [o.product.id, o]));
    return json({retailer, scope, datasetId:meta.dataset_id, inventoryHash:meta.inventory_hash,
      priceSource:'reference-webshop', products:unique.flatMap(id => {
        const o = byId.get(id); if (!o) return [];
        return [{...o, fresh:Date.parse(o.expiresAt) > now && Date.parse(o.checkedAt) <= now + 60000
          && now - Date.parse(o.checkedAt) < 86400000, publicPriceUsable:observationUsable(o, retailer, scope, now)}];
      }), missingProductIds:unique.filter(id => !byId.has(id))});
  }
  if (url.pathname === '/retailers') {
    const retailers = [];
    for (const retailer of ['coop','ica'] as const) {
      const db = binding(env, retailer), client = retailClient(env, retailer);
      const meta = db ? await metadata(db) : {};
      const scope = meta.reference_scope ? JSON.parse(meta.reference_scope) as unknown[] : null;
      const run = db && scope ? await db.prepare(`SELECT r.report_json FROM retail_scope_state s
        JOIN retail_runs r ON r.id=s.active_run_id WHERE s.scope_key=?`).bind(meta.reference_scope).first<{report_json:string}>() : null;
      retailers.push({retailer, connected: !!db, configured: meta.retailer === retailer,
        referenceScope: scope ? {storeId: scope[1], channel: scope[2], ...(scope[3] ? {slotId:scope[3]} : {})} : null,
        datasetId:meta.dataset_id ?? null, inventoryHash:meta.inventory_hash ?? null,
        lastRefresh:run ? JSON.parse(run.report_json) : null, capabilities:client.capabilities,
        liveLookupsEnabled:env.RETAILERS_LIVE_ENABLED === 'true'});
    }
    return json({retailers, defaultRetailer:'willys', version:'1'});
  }
  if (url.pathname === '/stores') {
    const retailer = url.searchParams.get('retailer'); if (!retailerId(retailer)) return fail('retailer_must_be_coop_or_ica');
    let code: string; try { code = postalCode(url.searchParams.get('postalCode') ?? ''); } catch { return fail('invalid_postal_code'); }
    if (env.RETAILERS_LIVE_ENABLED !== 'true') return fail('retailer_live_lookups_disabled', 503);
    const client = retailClient(env, retailer);
    if (!client.capabilities.stores) return fail('store_resolver_not_verified', 503);
    try { return json({retailer, postalCode:code, stores:await client.stores(code), pricingCapabilities:client.capabilities,
      note:retailer === 'coop' ? 'Pickup suggestions from first result page; delivery is not verified.' : null}); }
    catch { return fail('retailer_store_lookup_unavailable', 503); }
  }
  return fail('route_not_found', 404);
}

type Selection = { recipeId: number; servings?: number; amountOverrides?: Record<string, AmountOverride> };
type ObservationsById = Map<string, ProductObservation[]>;
function indexObservations(found:ProductObservation[]):ObservationsById {
  const byId:ObservationsById=new Map();
  for(const observation of found){const entries=byId.get(observation.product.id);if(entries)entries.push(observation);else byId.set(observation.product.id,[observation]);}
  return byId;
}
type ReferenceCandidatesByUnit = Map<string, ProductObservation[]>;
function indexReferenceCandidates(foundById:ObservationsById,retailer:RetailerId,scope:StoreScope,now:number):ReferenceCandidatesByUnit {
  const byUnit:ReferenceCandidatesByUnit=new Map();
  const add=(unit:QuantityUnit,id:string,observation:ProductObservation)=>{
    const key=JSON.stringify([unit,id]),entries=byUnit.get(key);
    if(entries)entries.push(observation);else byUnit.set(key,[observation]);
  };
  for(const [id,observations] of foundById)for(const observation of observations){
    if(!observationUsable(observation,retailer,scope,now)||observation.price!.depositOre===null)continue;
    const price=observation.price!;
    if(price.basis==='pack'){
      const pack=observation.product.pack;
      if(pack&&!pack.approximate&&!(pack.unit==='g'&&pack.drainedGrams!=null))add(pack.unit,id,observation);
    }else if(price.depositOre===0){
      if(price.basis==='kg')add('g',id,observation);
      else if(price.basis==='l')add('ml',id,observation);
    }
  }
  return byUnit;
}
// A local request needs only a cheap reference estimate. Exact package searches
// run once per menu, with the requested store's prices and a shared work budget.
function referenceEstimate(menu:MenuFinalist,candidatesByUnit:ReferenceCandidatesByUnit):number|null {
  const groups=new Map<string,IngredientDemand>();
  for(const d of menu.demands){
    if(d.nonPurchased)continue;
    if(d.quantity===null||d.unit===null)return null;
    const key=JSON.stringify([d.ingredientId,d.unit]),prior=groups.get(key);
    if(prior)prior.quantity!+=d.quantity;else groups.set(key,{...d});
  }
  const needs=new Map<string,{o:ProductObservation;quantity:number}>();
  const priceFor=(o:ProductObservation,q:number)=>o.price!.basis==='pack'
    ? Math.ceil(q/o.product.pack!.quantity)*(o.price!.amountOre+o.price!.depositOre!):Math.round(q*o.price!.amountOre/1000);
  for(const d of groups.values()){
    let o:ProductObservation|undefined,bestCost=Number.POSITIVE_INFINITY;
    for(const id of d.approvedProductIds)for(const candidate of candidatesByUnit.get(JSON.stringify([d.unit,id]))??[]){
      const cost=priceFor(candidate,d.quantity!);
      if(!o||cost<bestCost||cost===bestCost&&candidate.product.id.localeCompare(o.product.id)<0){o=candidate;bestCost=cost;}
    }
    if(!o)return null;
    const prior=needs.get(o.product.id);if(prior)prior.quantity+=d.quantity!;else needs.set(o.product.id,{o,quantity:d.quantity!});
  }
  return [...needs.values()].reduce((n,v)=>n+priceFor(v.o,v.quantity),0);
}
function selections(value: any): value is Selection[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32 && value.every(r => r
    && Number.isSafeInteger(r.recipeId) && r.recipeId > 0
    && (r.servings === undefined || typeof r.servings === 'number' && Number.isFinite(r.servings) && r.servings > 0 && r.servings <= 1000)
    && (r.amountOverrides === undefined || r.amountOverrides && typeof r.amountOverrides === 'object' && !Array.isArray(r.amountOverrides)));
}
export async function retailMealQuote(env: RetailEnv, manifest: Manifest, body: any, load: RecipeLoader,
  dependencies?: {client?: RetailClient; cache?: ObservationCache; quoteCache?: QuoteResponseCache}): Promise<Response> {
  if (!retailerId(body?.retailer)) return fail('retailer_must_be_coop_or_ica');
  const retailer = body.retailer, db = binding(env, retailer);
  if (!db) return fail('retailer_database_not_connected', 503);
  if (!['reference','local'].includes(body.priceMode ?? 'reference')) return fail('invalid_price_mode');
  if (body.budgetOre !== undefined && (!Number.isSafeInteger(body.budgetOre) || body.budgetOre < 0 || body.budgetOre > 100000000)) return fail('invalid_budget');
  const candidates: Array<{id:string; recipes:Selection[]}> = body.finalists ?? [{id:'selection', recipes:body.recipes}];
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3
    || candidates.some(c => !c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) || !selections(c.recipes))
    || new Set(candidates.map(c=>c.id)).size !== candidates.length) return fail('supply_1_to_3_valid_menu_finalists');
  const meta = await metadata(db);
  if (meta.retailer !== retailer || meta.dataset_id !== manifest.datasetId || meta.inventory_hash !== manifest.inventoryHash
    || meta.policy_version !== DIETARY_POLICY_VERSION) return fail('retailer_connections_refresh_pending', 503);
  const parsedScope = JSON.parse(meta.reference_scope ?? 'null') as unknown[] | null;
  if (!Array.isArray(parsedScope) || parsedScope[0] !== retailer) return fail('retailer_reference_not_configured', 503);
  const reference: StoreScope = {storeId:String(parsedScope[1]), channel:parsedScope[2] as StoreScope['channel'], ...(parsedScope[3] ? {slotId:String(parsedScope[3])} : {})};
  let scope = reference;
  if (body.priceMode === 'local') {
    scope = {storeId:body.storeId, channel:body.channel, ...(body.slotId !== undefined ? {slotId:body.slotId} : {})};
    try { validateScope(scope); } catch { return fail('invalid_store_scope'); }
  }
  let localClient: RetailClient | null = null;
  if (body.priceMode === 'local') {
    if (env.RETAILERS_LIVE_ENABLED !== 'true' && !dependencies?.client) return fail('retailer_live_lookups_disabled',503);
    localClient = dependencies?.client ?? retailClient(env,retailer);
    if (localClient.retailer !== retailer || !localClient.capabilities.verifiedStorePricing || !localClient.capabilities.productLookup)
      return fail('retailer_local_prices_not_verified',503);
  }
  const now = Date.now();
  const responseCache = dependencies?.quoteCache ?? env.COMPUTE_QUOTE_CACHE ?? quoteResponseCache;
  const referenceScopeKey = scopeKey(retailer,reference), requestedScopeKey = scopeKey(retailer,scope);
  const cacheScopeKeys = [referenceScopeKey];
  const quoteRuns = new Map<string,ActiveRun | null>();
  let currentMappings: Array<{reference_product_id:string;identity_json:string}> = [];
  let mappingsCacheable = true;
  let responseCacheKey: string | null = null;
  if (responseCache.available) {
    if (body.priceMode === 'local') {
      currentMappings = (await db.prepare(`SELECT reference_product_id,identity_json FROM retail_local_mappings
        WHERE scope_key=? ORDER BY reference_product_id LIMIT 401`).bind(requestedScopeKey).all<{reference_product_id:string;identity_json:string}>()).results;
      mappingsCacheable = currentMappings.length <= 400;
    }
    for (const key of cacheScopeKeys) quoteRuns.set(key, await activeRun(db,key));
    if (mappingsCacheable && cacheScopeKeys.every(key => runCurrentForQuote(quoteRuns.get(key) ?? null,now))) {
      responseCacheKey = quoteCacheRequestKey(body,meta,retailer,requestedScopeKey,cacheScopeKeys,quoteRuns,currentMappings);
      if (responseCacheKey) {
        const cached = await responseCache.match(responseCacheKey,now);
        if (cached) return new Response(cached.body,{status:200,headers:{'Content-Type':'application/json',
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
    }
  }
  const ids = [...new Set(candidates.flatMap(c=>c.recipes.map(r=>r.recipeId)))];
  const documents = await load(ids);
  if (documents.size !== ids.length) return fail('recipe_not_found', 404);
  const names = [...new Set([...documents.values()].flatMap(d=>d.ingredients.map(i=>i.ingredient_original)))];
  if (names.length > 200 || candidates.some(c=>c.recipes.reduce((n,r)=>n+documents.get(r.recipeId)!.ingredients.length,0) > 500)) return fail('meal_plan_too_large');
  const rows = await db.prepare('SELECT document_json FROM retail_connections WHERE ingredient_name IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(names)).all<{document_json:string}>();
  const connections = rows.results.map(r=>JSON.parse(r.document_json) as ReviewedConnection);
  const byName = new Map(connections.map(c=>[c.name,c]));
  const finalists: MenuFinalist[] = [];
  for (const candidate of candidates) {
    const demands: IngredientDemand[] = [];
    for (const selected of candidate.recipes) {
      const d = documents.get(selected.recipeId)!;
      if (selected.servings !== undefined && (!d.servings || d.servings <= 0)) return fail('source_servings_unknown', 422);
      const scale = selected.servings === undefined ? 1 : selected.servings / d.servings!;
      const overrides = selected.amountOverrides ?? {};
      if (Object.entries(overrides).some(([i,v])=>!/^\d+$/.test(i) || Number(i) >= d.ingredients.length || !v
        || !['g','ml','piece'].includes(v.unit) || typeof v.quantity !== 'number' || !Number.isFinite(v.quantity) || v.quantity <= 0 || v.quantity > 10000000)) return fail('invalid_amount_override');
      for (const [index, ingredient] of d.ingredients.entries()) {
        const c = byName.get(ingredient.ingredient_original);
        const amount = canonicalAmount(ingredient, scale, overrides[String(index)]).amount;
        const knownUnit = amount?.unit ?? canonicalAmount({...ingredient,measured_quantity:1,quantity_conflict:0}).amount?.unit ?? null;
        demands.push({ingredientId:c?.ingredientId ?? `missing:${ingredient.ingredient_original}`, name:ingredient.ingredient_original,
          quantity:amount?.quantity ?? null, unit:knownUnit as QuantityUnit | null, approvedProductIds:[], nonPurchased:c?.status === 'non_purchased'});
      }
    }
    finalists.push({id:candidate.id, demands, referenceCostOre:null});
  }
  const tracked = [...new Set(connections.flatMap(c=>c.approvedProducts.map(p=>p.productId)))];
  if (tracked.length > 400) return fail('local_lookup_product_budget');
  const referenceObservations = await observations(db,retailer,reference,tracked,
    quoteRuns.has(referenceScopeKey) ? quoteRuns.get(referenceScopeKey) : undefined);
  const referenceById=indexObservations(referenceObservations);
  const referenceCandidates=body.priceMode==='local'?indexReferenceCandidates(referenceById,retailer,reference,now):null;
  const withApproved = (items: MenuFinalist[], reviewed: ReviewedConnection[], found: ProductObservation[], store: StoreScope) => {
    const foundById = new Map<string, ProductObservation[]>();
    for (const observation of found) {
      const sameId = foundById.get(observation.product.id) ?? [];
      sameId.push(observation);
      foundById.set(observation.product.id, sameId);
    }
    const eligible = new Map(reviewed.map(c=>[c.ingredientId,
      c.status!=='matched'||c.policyVersion!==DIETARY_POLICY_VERSION||cachedIngredientPolicy(c.name).blockedReason ? []
        : c.approvedProducts.filter(p=>{
          const matches=foundById.get(p.productId);
          return !matches || matches.length === 0 || matches.every(observation =>
            productIdentity(observation.product)===p.identity && !reviewedProductPolicy(observation.product,c.name));
        }).map(p=>p.productId)]));
    return items.map(f=>({...f,demands:f.demands.map(d=>({...d,approvedProductIds:eligible.get(d.ingredientId) ?? []}))}));
  };
  const referenceFinalists = withApproved(finalists,connections,referenceObservations,reference);
  if(body.priceMode==='local'){
    // Finalists can be duplicate recipe selections under different menu IDs.
    // Cache only an exact serialization of the demand rows, preserving input
    // order and every field referenceEstimate consumes.
    const estimates=new Map<string,number|null>();
    for(const f of referenceFinalists){
      const key=JSON.stringify(f.demands);
      if(!estimates.has(key))estimates.set(key,referenceEstimate(f,referenceCandidates!));
      finalists.find(c=>c.id===f.id)!.referenceCostOre=estimates.get(key)!;
    }
  }
  let priced = referenceObservations, reviewed = connections;
  if (body.priceMode === 'local') {
    const mappedRows = responseCache.available && mappingsCacheable ? currentMappings.filter(row=>tracked.includes(row.reference_product_id))
      : (await db.prepare(`SELECT reference_product_id,identity_json FROM retail_local_mappings WHERE scope_key=?
        AND reference_product_id IN (SELECT value FROM json_each(?))`).bind(scopeKey(retailer,scope),JSON.stringify(tracked))
        .all<{reference_product_id:string;identity_json:string}>()).results;
    try { reviewed = mappedConnections(connections,mappedRows.map(r=>JSON.parse(r.identity_json) as LocalMapping)); }
    catch { return fail('retailer_local_mapping_needs_review',503); }
    const localResolver = dependencies?.client ? new LocalProductResolver(localClient!,dependencies.cache ?? cache) : resolver(env,retailer);
    if (localResolver.client.retailer !== retailer || !localResolver.client.capabilities.verifiedStorePricing || !localResolver.client.capabilities.productLookup) return fail('retailer_local_prices_not_verified',503);
    try { priced = (await localResolver.resolve(scope,reviewed,now)).observations; }
    catch { return fail('retailer_local_prices_unavailable',503); }
  }
  const finalCandidates = body.priceMode === 'local' ? withApproved(finalists,reviewed,priced,scope) : referenceFinalists;
  const ranked = rankMenuFinalists(finalCandidates,{retailer,scope,observations:priced,now,
    maxStates:Math.floor(1000/candidates.length),maxWork:Math.floor(20000/candidates.length),budgetOre:body.budgetOre});
  if(body.priceMode!=='local')for(const f of ranked)f.referenceCostOre=f.basket.purchaseCostOre;
  const winner = ranked.find(f=>f.basket.complete && f.basket.withinBudget !== false);
  const response = json({retailer,storeId:scope.storeId,channel:scope.channel,slotId:scope.slotId ?? null,
    priceMode:body.priceMode ?? 'reference', priceSource:body.priceMode === 'local' ? 'local-webshop' : 'reference-webshop',
    datasetId:manifest.datasetId,inventoryHash:manifest.inventoryHash,policyVersion:DIETARY_POLICY_VERSION,
    currency:'SEK',priceScale:'öre',pricedAt:new Date(now).toISOString(),
    earliestPriceExpiry:priced.length ? priced.map(o=>o.expiresAt).sort()[0] : null,
    finalists:ranked,selectedMenuId:winner?.id ?? null,referenceCostIsEstimate:body.priceMode==='local',
    cheapestVerified:!!winner && ranked.every(f=>f.basket.complete && f.basket.optimizationComplete),
    ...(candidates.length===1 ? {basket:ranked[0].basket} : {}),
    limitations:['Public non-member prices only.','Unknown amounts remain unresolved.','Package cost includes deposit; consumption cost excludes it.','Webshop prices exclude delivery/service fees.']});
  // Unknown quantities and incompatible units are immutable request facts too.
  // Preserve those explicit unresolved results; a different override, run or
  // mapping changes the key. Never reuse a search that exhausted its budget.
  if (responseCacheKey && ranked.every(f=>f.basket.optimizationComplete)) {
    const runs = cacheScopeKeys.map(key=>quoteRuns.get(key)).filter((run):run is ActiveRun=>!!run);
    const pricedById = new Map([...referenceObservations,...priced].map(observation=>[`${scopeKey(observation.retailer,observation.scope)}:${observation.product.id}`,observation]));
    const expiresAt = quoteCacheExpiry(now,body.priceMode==='local',runs,[...pricedById.values()]);
    if (expiresAt > now) await responseCache.put(responseCacheKey,response.clone(),expiresAt);
  }
  return response;
}

function retailerOpenApi(origin: string) {
  return {openapi:'3.1.0',info:{title:'Meal planner retailer extension',version:'1.0.0'},servers:[{url:origin}],
    security:[{bearerAuth:[]}],components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'}}},
    paths:{'/retailers':{get:{summary:'Retailer configuration and verified source capabilities',responses:{'200':{description:'Retailers'}}}},
      '/retailers/{retailer}/products':{get:{summary:'Stored tracked product details, packages, source prices and freshness',parameters:[{name:'retailer',in:'path',required:true,schema:{enum:['coop','ica']}},{name:'ids',in:'query',required:true,schema:{type:'string'},description:'Comma-separated product IDs; maximum 100'}],responses:{'200':{description:'Reference-store observations and missing IDs; stale prices are marked unusable'},'503':{description:'Retailer not configured'}}}},
      '/stores':{get:{summary:'Available store suggestions',parameters:[{name:'retailer',in:'query',required:true,schema:{enum:['coop','ica']}},{name:'postalCode',in:'query',required:true,schema:{type:'string',pattern:'^\\d{5}$'}}],responses:{'200':{description:'Store suggestions'},'503':{description:'Not enabled or unverified'}}}},
      '/meal/quote':{post:{summary:'Whole-package quote and up to three locally priced menu finalists',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['retailer'],properties:{retailer:{enum:['coop','ica']},priceMode:{enum:['reference','local']},storeId:{type:'string'},channel:{enum:['pickup','delivery']},slotId:{type:'string'},budgetOre:{type:'integer',minimum:0},recipes:{type:'array',minItems:1,maxItems:32,items:{type:'object',required:['recipeId'],properties:{recipeId:{type:'integer',minimum:1},servings:{type:'number',exclusiveMinimum:0},amountOverrides:{type:'object'}}}},finalists:{type:'array',minItems:1,maxItems:3,items:{type:'object',required:['id','recipes'],properties:{id:{type:'string'},recipes:{type:'array'}}}}}}}}},responses:{'200':{description:'Known and unresolved costs, ranked finalists, package quantities and freshness'},'400':{description:'Invalid request'},'503':{description:'Not enabled, incomplete setup or source verification pending'}}}}}};
}

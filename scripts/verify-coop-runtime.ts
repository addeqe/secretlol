import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CoopClient } from '../src/retailers/coop.ts';
import { createRetailTransport } from '../src/retailers/transport.ts';
import { scopeKey, type ProductObservation, type RetailClient, type StoreScope } from '../src/retailers/types.ts';

export type CoopSourceProof = {
  scope: StoreScope;
  categoriesFound: number;
  categoryProductsReported: number | null;
  productsChecked: number;
  pricesOre: number[];
  requests: number;
  retries: number;
};

/** Make one category request, one browse-page request, and one 1–3 ID batch. */
export async function verifyCoopSource(client: RetailClient, scope: StoreScope,
  metrics: () => { requests: number; retries: number }): Promise<CoopSourceProof> {
  if (client.retailer !== 'coop' || !client.capabilities.categories || !client.capabilities.browse
    || !client.capabilities.batchLookup || !client.capabilities.verifiedStorePricing) {
    throw new Error('Coop source capabilities are not enabled');
  }
  const categories = await client.categories(scope);
  const category = categories.flatMap(function leaves(item): typeof categories {
    return item.children.length ? item.children.flatMap(leaves) : [item];
  })[0];
  if (!category) throw new Error('Coop source check found no categories');
  const page = await client.browse(scope, category.id);
  if (!page.products.length) throw new Error('Coop source check found no products on the first browse page');
  const sample = page.products.slice(0, 3).map(item => item.product.id);
  if (sample.length < 1 || sample.length > 3 || new Set(sample).size !== sample.length) {
    throw new Error('Coop source check returned an invalid sample');
  }
  const observations = await client.products(scope, sample);
  validateSourceSample(observations, sample, scope);
  const usage = metrics();
  return {
    scope,
    categoriesFound: categories.length,
    categoryProductsReported: page.total,
    productsChecked: observations.length,
    pricesOre: observations.map(item => item.price!.amountOre),
    requests: usage.requests,
    retries: usage.retries,
  };
}

function validateSourceSample(observations: ProductObservation[], ids: string[], scope: StoreScope) {
  if (observations.length !== ids.length || new Set(observations.map(item => item.product.id)).size !== ids.length
    || ids.some(id => !observations.some(item => item.product.id === id))) {
    throw new Error('Coop source check returned an incomplete product batch');
  }
  if (observations.some(item => item.retailer !== 'coop' || scopeKey(item.retailer, item.scope) !== scopeKey('coop', scope)
    || !item.storeScopeVerified || !item.price || !Number.isSafeInteger(item.price.amountOre) || item.price.amountOre < 1)) {
    throw new Error('Coop source check did not verify pickup-scoped prices');
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: { 'allow-live': { type: 'boolean', default: false } }, allowPositionals: true });
  if (positionals.length || values['allow-live'] !== true) {
    throw new Error('This bounded live source check requires the explicit --allow-live flag');
  }
  const key = process.env.COOP_PUBLIC_SUBSCRIPTION_KEY?.trim();
  const storeId = process.env.COOP_REFERENCE_STORE_ID?.trim();
  if (!key || !storeId) throw new Error('Missing Coop source-check settings');
  const channel = process.env.COOP_REFERENCE_CHANNEL?.trim() || 'pickup';
  if (channel !== 'pickup') throw new Error('Only verified Coop pickup pricing is supported by this source check');
  const scope: StoreScope = { storeId, channel };
  const transport = createRetailTransport({ retailer: 'coop', minIntervalMs: 250, maxRequests: 5, maxRunMs: 60_000 });
  const client = new CoopClient({ publicSubscriptionKey: key, transport });
  const proof = await verifyCoopSource(client, scope, () => transport.metrics);
  const output = { source: 'Coop public API', ...proof };
  console.log(JSON.stringify(output, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Coop Actions source check passed: pickup store ${scope.storeId}; ${proof.categoriesFound} categories; first page reports ${proof.categoryProductsReported ?? 'unknown'} products; ${proof.productsChecked} store-scoped prices checked; ${proof.requests} requests, ${proof.retries} retries.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Coop source check failed');
    process.exitCode = 1;
  });
}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAssessments } from '../src/ingredient-assessments.ts';
import { coopReviewCategoryMap, validateReviewedInventory, type CloudIngredientInventory,
  mergeManualReviewNominations, manualNominationsHash, reviewCatalogueHash,
  type ManualReviewNominations, type ReviewDecisionSet } from '../src/retailers/review.ts';
import type { ProductObservation, RetailerId, StoreScope } from '../src/retailers/types.ts';

const { values } = parseArgs({ options: {
  retailer: { type: 'string' }, inventory: { type: 'string' }, scan: { type: 'string' }, categories: { type: 'string' },
  decisions: { type: 'string', multiple: true }, nominations: { type: 'string', multiple: true }, output: { type: 'string' },
} });

function read<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as T;
}

function main() {
  if (values.retailer !== 'coop' || !values.inventory || !values.scan || !values.output
    || !values.decisions?.length) {
    throw new Error('Supply --retailer coop --inventory inventory.json --scan scan.json --decisions part.json (repeatable) --output reviewed.json');
  }
  const retailer: RetailerId = values.retailer;
  const inventory = read<CloudIngredientInventory>(values.inventory);
  const scan = read<{ retailer: RetailerId; scope: StoreScope; products: ProductObservation[] }>(values.scan);
  if (scan.retailer !== retailer || !Array.isArray(scan.products)) throw new Error('review_scan_retailer_mismatch');
  const categoryTree = read<{ retailer: RetailerId; scope: StoreScope; byId: Record<string, string[]> }>(
    values.categories ?? 'data/coop-category-tree-20261009.json');
  if (categoryTree.retailer !== retailer || JSON.stringify(categoryTree.scope) !== JSON.stringify(scan.scope)) {
    throw new Error('review_category_tree_scope_mismatch');
  }
  const nominations = mergeManualReviewNominations((values.nominations ?? []).map(path => read<ManualReviewNominations>(path)));
  const fragments = values.decisions.map(path => read<ReviewDecisionSet>(path));
  const first = fragments[0];
  if (fragments.some(fragment => fragment.retailer !== first.retailer
    || fragment.datasetId !== first.datasetId || fragment.inventoryHash !== first.inventoryHash
    || fragment.policyVersion !== first.policyVersion
    || fragment.catalogueHash !== first.catalogueHash || fragment.nominationsHash !== first.nominationsHash
    || manualNominationsHash(fragment.nominations ?? null) !== manualNominationsHash(nominations)
    || JSON.stringify(fragment.scope) !== JSON.stringify(first.scope))) {
    throw new Error('review_fragment_snapshot_mismatch');
  }
  if (first.retailer !== retailer || JSON.stringify(first.scope) !== JSON.stringify(scan.scope)) {
    throw new Error('review_fragment_scan_scope_mismatch');
  }
  const seen = new Set<string>();
  const connections = fragments.flatMap(fragment => fragment.connections);
  for (const connection of connections) {
    if (seen.has(connection.name)) throw new Error(`review_name_repeated: ${connection.name}`);
    seen.add(connection.name);
  }
  const decisionSet: ReviewDecisionSet = { ...first, connections };
  validateReviewedInventory(inventory, scan.products, decisionSet, retailer, scan.scope, Date.now(),
    coopReviewCategoryMap(Object.entries(categoryTree.byId).map(([categoryId, paths]) => ({ categoryId,
      name: paths.join(' > ') }))), loadAssessments().records, nominations);
  if (first.catalogueHash !== reviewCatalogueHash(scan.products)
    || first.nominationsHash !== manualNominationsHash(nominations)) throw new Error('review_fragment_provenance_mismatch');
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ retailer, scope: scan.scope, datasetId: inventory.datasetId,
    inventoryHash: inventory.hash, catalogueHash: reviewCatalogueHash(scan.products), nominationsHash: manualNominationsHash(nominations),
    nominations, observations: scan.products, connections }, null, 2) + '\n');
  console.log(JSON.stringify({ output, retailer, ingredients: connections.length,
    matched: connections.filter(c => c.status === 'matched').length,
    unresolved: connections.filter(c => c.status === 'needs_review').length,
    unavailable: connections.filter(c => c.status === 'unavailable').length,
    nonPurchased: connections.filter(c => c.status === 'non_purchased').length }, null, 2));
}

main();

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAssessments } from '../src/ingredient-assessments.ts';
import { compactReviewBatches, expandCompactReviewDecisions, mergeManualReviewNominations,
  manualNominationsHash, reviewCatalogueHash, type CloudIngredientInventory,
  coopReviewCategoryMap, type CompactReviewDecisionSet, type ManualReviewNominations, type RetailCategoryLabel } from '../src/retailers/review.ts';
import type { ProductObservation, RetailerId, StoreScope } from '../src/retailers/types.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  inventory: { type: 'string' }, scan: { type: 'string' }, categories: { type: 'string' }, output: { type: 'string' },
  results: { type: 'string', multiple: true }, nominations: { type: 'string', multiple: true },
} });
const read = <T>(path: string) => JSON.parse(readFileSync(resolve(path), 'utf8')) as T;
const save = (path: string, value: unknown) => {
  const target = resolve(path); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
};

function main() {
  const command = positionals[0];
  if (!values.inventory || !values.scan || !values.output || !['prepare', 'expand'].includes(command ?? '')) {
    throw new Error('Commands: prepare|expand --inventory inventory.json --scan scan.json --output output-directory; optional --categories tree.json and repeatable --nominations nominations.json; expand also repeats --results result-part.json');
  }
  const inventory = read<CloudIngredientInventory>(values.inventory);
  const scan = read<{ retailer: RetailerId; scope: StoreScope; products: ProductObservation[]; categories: RetailCategoryLabel[] }>(values.scan);
  if (scan.retailer !== 'coop' || !Array.isArray(scan.products)) throw new Error('review_scan_must_be_verified_coop');
  const categoryTree = read<{ retailer: RetailerId; scope: StoreScope; byId: Record<string, string[]> }>(
    values.categories ?? 'data/coop-category-tree-20261009.json');
  if (categoryTree.retailer !== 'coop' || JSON.stringify(categoryTree.scope) !== JSON.stringify(scan.scope)) {
    throw new Error('review_category_tree_scope_mismatch');
  }
  const categoryMap = coopReviewCategoryMap(Object.entries(categoryTree.byId).map(([categoryId, paths]) => ({
    categoryId, name: paths.join(' > '),
  })));
  const assessments = loadAssessments().records;
  const nominationSets = (values.nominations ?? []).map(path => read<ManualReviewNominations>(path));
  const nominations = mergeManualReviewNominations(nominationSets);
  const batches = compactReviewBatches(inventory, scan.products, 'coop', scan.scope, 3, Date.now(), categoryMap,
    assessments, nominations);
  if (command === 'prepare') {
    const output = resolve(values.output);
    mkdirSync(output, { recursive: true });
    for (const batch of batches) save(join(output, `part-${batch.part}.json`), batch);
    console.log(JSON.stringify({ output, retailer: 'coop', parts: batches.length,
      ingredients: batches.reduce((sum, part) => sum + part.items.length, 0),
      sizes: batches.map(part => part.items.length) }, null, 2));
    return;
  }
  if (!values.results?.length) throw new Error('Supply at least one --results compact-decisions.json');
  const decisions = values.results.map(path => read<CompactReviewDecisionSet>(path));
  const connections = expandCompactReviewDecisions(inventory, scan.products, batches, decisions, 'coop', scan.scope,
    Date.now(), categoryMap, assessments, nominations);
  const output = resolve(values.output);
  mkdirSync(output, { recursive: true });
  for (const batch of batches) {
    const names = new Set(batch.items.map(item => item.name));
    save(join(output, `part-${batch.part}.json`), { retailer: 'coop', scope: scan.scope,
      datasetId: inventory.datasetId, inventoryHash: inventory.hash, policyVersion: inventory.dietaryPolicy.version,
      catalogueHash: reviewCatalogueHash(scan.products), nominationsHash: manualNominationsHash(nominations), nominations,
      connections: connections.filter(connection => names.has(connection.name)) });
  }
  console.log(JSON.stringify({ output, retailer: 'coop', parts: batches.length,
    connections: connections.length, matched: connections.filter(connection => connection.status === 'matched').length,
    unresolved: connections.filter(connection => connection.status === 'needs_review').length,
    unavailable: connections.filter(connection => connection.status === 'unavailable').length }, null, 2));
}

main();

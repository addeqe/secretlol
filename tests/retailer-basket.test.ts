import test from 'node:test';
import assert from 'node:assert/strict';
import { finalistProductIds, optimizeBasket, rankMenuFinalists } from '../src/retailers/basket.ts';
import type { BasketRequest, IngredientDemand, ProductObservation, RetailProduct } from '../src/retailers/types.ts';

const now = Date.parse('2026-10-08T10:00:00Z');
const scope = { storeId: 'store-1', channel: 'pickup' as const };
function product(id: string, quantity: number, unit: 'g' | 'ml' | 'piece' = 'g', approximate = false, name = 'Plain flour'): RetailProduct {
  return { id, ean: null, name, brand: null, categories: [], pack: { quantity, unit, approximate }, ingredientsText: null };
}
function observed(id: string, packQty: number, priceOre: number, options: {
  unit?: 'g' | 'ml' | 'piece'; depositOre?: number | null; basis?: 'pack' | 'kg' | 'l';
  available?: ProductObservation['availability']; storeId?: string; channel?: 'pickup' | 'delivery';
  verified?: boolean; checkedAt?: string; expiresAt?: string; memberOnly?: boolean; minimumQuantity?: number | null;
  validFrom?: string | null; validUntil?: string | null; approximate?: boolean; name?: string; brand?: string | null;
} = {}): ProductObservation {
  const unit = options.unit ?? 'g';
  return { retailer: 'coop', scope: { storeId: options.storeId ?? scope.storeId, channel: options.channel ?? scope.channel },
    product: { ...product(id, packQty, unit, options.approximate, options.name), brand: options.brand ?? null },
    price: { amountOre: priceOre, basis: options.basis ?? 'pack', depositOre: options.depositOre === undefined ? 0 : options.depositOre,
      memberOnly: options.memberOnly ?? false, minimumQuantity: options.minimumQuantity ?? null,
      validFrom: options.validFrom ?? null, validUntil: options.validUntil ?? null },
    availability: options.available ?? 'available', checkedAt: options.checkedAt ?? '2026-10-08T09:00:00Z',
    expiresAt: options.expiresAt ?? '2026-10-09T09:00:00Z', storeScopeVerified: options.verified ?? true };
}
function demand(ingredientId: string, quantity: number | null, approvedProductIds: string[], options: Partial<IngredientDemand> = {}): IngredientDemand {
  return { ingredientId, name: 'flour', quantity, unit: 'g', approvedProductIds, ...options };
}
function request(demands: IngredientDemand[], observations: ProductObservation[], extra: Partial<BasketRequest> = {}): BasketRequest {
  return { retailer: 'coop', scope, demands, observations, now, ...extra };
}

test('minimizes whole checkout cost instead of choosing the lowest unit price', () => {
  const result = optimizeBasket(request([demand('flour', 100, ['small', 'bulk'])], [
    observed('small', 100, 100), observed('bulk', 1000, 400),
  ]));
  assert.equal(result.complete, true);
  assert.equal(result.purchaseCostOre, 100);
  assert.equal(result.lines[0].productId, 'small');
  assert.equal(result.lines[0].leftoverQuantity, 0);
  assert.equal(result.consumedCostOre, 100);
});

test('does not equate canned net weight with drained recipe weight',()=>{
  const can=observed('can',380,1500);can.product.pack!.drainedGrams=230;
  const result=optimizeBasket(request([demand('beans',100,['can'],{name:'beans'})],[can]));
  assert.equal(result.complete,false);assert.equal(result.purchaseCostOre,null);
  assert.equal(result.unresolved[0].reason,'drained_weight_basis_requires_review');
});

test('sums repeated needs and shares one pack only when every ingredient approves it', () => {
  const result = optimizeBasket(request([
    demand('flour-a', 200, ['shared']), demand('flour-b', 200, ['shared']),
  ], [observed('shared', 500, 250)]));
  assert.equal(result.complete, true);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].packs, 1);
  assert.equal(result.lines[0].quantity, 400);
  assert.equal(result.lines[0].leftoverQuantity, 100);
  assert.equal(result.purchaseCostOre, 250);

  const incompatible = optimizeBasket(request([
    demand('flour-a', 200, ['shared']), demand('rice', 200, ['other'], { name: 'rice' }),
  ], [observed('shared', 500, 250), observed('other', 500, 300, { name: 'Rice' })]));
  assert.equal(incompatible.lines.length, 2);
  assert.equal(incompatible.purchaseCostOre, 550);
});

test('uses exact pack sizes and counts package deposits in checkout cost', () => {
  const result = optimizeBasket(request([demand('flour', 550, ['two-small', 'large'])], [
    observed('two-small', 300, 120, { depositOre: 10 }), observed('large', 600, 270, { depositOre: 0 }),
  ]));
  assert.equal(result.purchaseCostOre, 260);
  assert.equal(result.lines[0].packs, 2);
  assert.equal(result.lines[0].depositOre, 20);
  assert.equal(result.lines[0].leftoverQuantity, 50);
  assert.equal(result.consumedCostOre, 220);
});

test('mixes pack sizes when that produces the cheapest complete basket', () => {
  const result = optimizeBasket(request([demand('flour', 750, ['large', 'small'])], [
    observed('large', 500, 2000), observed('small', 250, 1100),
  ]));
  assert.equal(result.optimizationComplete, true);
  assert.equal(result.purchaseCostOre, 3100);
  assert.deepEqual(result.lines.map(line => [line.productId, line.packs]), [['large', 1], ['small', 1]]);
  assert.equal(result.lines.reduce((sum, line) => sum + line.quantity, 0), 750);
});

test('sums same-ingredient needs before buying packs', () => {
  const result = optimizeBasket(request([
    demand('flour', 125, ['shared', 'exclusive']), demand('flour', 175, ['shared', 'other']),
  ], [observed('shared', 500, 200), observed('exclusive', 100, 100), observed('other', 100, 100)]));
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].productId, 'shared');
  assert.equal(result.lines[0].quantity, 300);
  assert.equal(result.purchaseCostOre, 200);
});

test('excludes stale, unavailable, cross-store, unverified, member-only, and quantity-conditional observations', () => {
  const result = optimizeBasket(request([demand('flour', 100, ['stale', 'gone', 'elsewhere', 'unverified', 'member', 'multi'])], [
    observed('stale', 100, 10, { expiresAt: '2026-10-08T09:59:00Z' }),
    observed('gone', 100, 10, { available: 'unavailable' }),
    observed('elsewhere', 100, 1, { storeId: 'store-2' }),
    observed('unverified', 100, 1, { verified: false }),
    observed('member', 100, 1, { memberOnly: true }),
    observed('multi', 100, 1, { minimumQuantity: 2 }),
  ]));
  assert.equal(result.complete, false);
  assert.equal(result.purchaseCostOre, null);
  assert.equal(result.unresolved[0].reason, 'conditional_price_excluded');
});

test('indexes duplicate-ID observations without losing the first current usable entry', () => {
  const stale = observed('duplicate', 100, 1, { expiresAt: '2026-10-08T09:59:00Z' });
  const current = observed('duplicate', 100, 120);
  const result = optimizeBasket(request([demand('flour', 100, ['duplicate'])], [current, stale]));
  assert.equal(result.complete, true);
  assert.equal(result.purchaseCostOre, 120);
  assert.equal(result.lines[0].productId, 'duplicate');
});

test('excludes future observations and prices outside their public validity window', () => {
  const result = optimizeBasket(request([demand('flour', 100, ['future-check', 'future-price', 'expired-price'])], [
    observed('future-check', 100, 1, { checkedAt: '2026-10-08T10:02:00Z' }),
    observed('future-price', 100, 1, { validFrom: '2026-10-08T10:01:00Z' }),
    observed('expired-price', 100, 1, { validUntil: '2026-10-08T10:00:00Z' }),
  ]));
  assert.equal(result.complete, false);
  assert.equal(result.purchaseCostOre, null);
  assert.ok(result.unresolved[0].reason === 'price_outside_validity_window' || result.unresolved[0].reason === 'product_unavailable_stale_or_wrong_store');
});

test('never treats unknown quantity, package, or deposit as zero-cost', () => {
  const unknownAmount = optimizeBasket(request([demand('flour', null, ['p'])], [observed('p', 500, 100)]));
  assert.equal(unknownAmount.complete, false);
  assert.equal(unknownAmount.purchaseCostOre, null);
  assert.equal(unknownAmount.unresolved[0].reason, 'quantity_unknown_or_invalid');

  const unknownDeposit = optimizeBasket(request([demand('flour', 100, ['p'])], [observed('p', 500, 100, { depositOre: null })]));
  assert.equal(unknownDeposit.purchaseCostOre, null);
  assert.equal(unknownDeposit.unresolved[0].reason, 'price_or_deposit_unknown');

  const noPackQuantity = optimizeBasket(request([demand('flour', 100, ['p'])], [{ ...observed('p', 500, 100), product: { ...product('p', 500), pack: null } }]));
  assert.equal(noPackQuantity.complete, false);
  assert.equal(noPackQuantity.unresolved[0].reason, 'package_quantity_or_unit_unknown');
});

test('a positive sub-epsilon demand still requires a whole package', () => {
  const result = optimizeBasket(request([demand('flour', 1e-9, ['p'])], [observed('p', 500, 200)]));
  assert.equal(result.complete, true);
  assert.equal(result.purchaseCostOre, 200);
  assert.equal(result.lines[0].packs, 1);
  assert.equal(result.lines[0].quantity, 1e-9);
});

test('rejects a demand below the supported canonical quantity precision', () => {
  const result = optimizeBasket(request([demand('flour', 1e-12, ['p'])], [observed('p', 500, 200)]));
  assert.equal(result.complete, false);
  assert.equal(result.purchaseCostOre, null);
  assert.equal(result.unresolved[0].reason, 'quantity_below_supported_precision');
});

test('rejects same-ingredient sums that erase either positive term in either order', () => {
  for (const quantities of [[1e-9, 1e16], [1e16, 1e-9]]) {
    const result = optimizeBasket(request(quantities.map(quantity => demand('flour', quantity, ['p'])),
      [observed('p', 1e16, 200)]));
    assert.equal(result.complete, false);
    assert.equal(result.purchaseCostOre, null);
    assert.equal(result.unresolved[0].reason, 'quantity_below_supported_precision');
  }
});

test('does not drop a tiny ingredient beside a much larger connected demand', () => {
  const result = optimizeBasket(request([
    demand('a-large', 1_000_000, ['a-large', 'z-shared']),
    demand('z-tiny', 1e-9, ['m-tiny', 'z-shared']),
  ], [
    observed('a-large', 2_000_000, 100), observed('m-tiny', 2_000_000, 100),
    observed('z-shared', 2_000_000, 1000),
  ]));
  assert.equal(result.complete, true);
  assert.ok(result.lines.some(line => line.productId === 'm-tiny' && line.quantity === 1e-9));
  assert.equal(result.purchaseCostOre, 200);
});

test('rounds consumed cost after summing unrounded costs across components', () => {
  const first = observed('weighted-a', 1, 300, { basis: 'kg', depositOre: 0 });
  const second = observed('weighted-b', 1, 300, { basis: 'kg', depositOre: 0 });
  const result = optimizeBasket(request([
    demand('a', 2, ['weighted-a']), demand('b', 2, ['weighted-b']),
  ], [first, second]));
  assert.equal(result.complete, true);
  assert.deepEqual(result.lines.map(line => line.consumedCostOre), [1, 1]);
  assert.equal(result.consumedCostOre, 1);
});

test('honors reviewed approved-ID intersections and strict dietary compatibility', () => {
  const split = optimizeBasket(request([
    demand('flour', 100, ['allowed', 'not-shared']), demand('flour', 100, ['allowed', 'other']),
  ], [observed('not-shared', 100, 1), observed('other', 100, 1), observed('allowed', 500, 150)]));
  assert.equal(split.lines.length, 1);
  assert.equal(split.lines[0].productId, 'allowed');

  const meat = optimizeBasket(request([demand('chicken', 100, ['bad-brand'], { name: 'chicken' })], [
    observed('bad-brand', 100, 100, { name: 'Chicken breast', brand: 'Unknown' }),
  ]));
  assert.equal(meat.complete, false);
  assert.equal(meat.unresolved[0].reason, 'dietary_policy_excluded');
});

test('signals when the exact-search bound prevents proving the optimum', () => {
  const result = optimizeBasket(request([demand('flour', 100, ['a', 'b'])], [
    observed('a', 100, 100), observed('b', 100, 50),
  ], { maxStates: 1 }));
  assert.equal(result.optimizationComplete, false);
  assert.equal(result.complete, false);
  assert.equal(result.purchaseCostOre, null);
  assert.ok(result.unresolved.some(x => x.reason === 'optimization_state_bound_exceeded'));
  assert.ok(result.statesExplored <= 1);
});

test('optimizes many disconnected ingredients as small exact components', () => {
  const demands = Array.from({ length: 30 }, (_, i) => demand(`ingredient-${i}`, 100, [`sku-${i}`]));
  const observations = Array.from({ length: 30 }, (_, i) => observed(`sku-${i}`, 100, 100 + i));
  const result = optimizeBasket(request(demands, observations, { maxStates: 100 }));
  assert.equal(result.complete, true);
  assert.equal(result.optimizationComplete, true);
  assert.equal(result.purchaseCostOre, Array.from({ length: 30 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0));
  assert.ok(result.statesExplored <= 100);
});

test('reports a feasible but unproven result for a genuinely coupled stress component', () => {
  const ids = Array.from({ length: 5 }, (_, i) => `shared-${i}`);
  const demands = Array.from({ length: 8 }, (_, i) => demand(`ingredient-${i}`, 100, ids));
  const observations = ids.map((id, i) => observed(id, 100, 100 + i * 25));
  const result = optimizeBasket(request(demands, observations, { maxStates: 25 }));
  assert.equal(result.complete, true);
  assert.equal(result.optimizationComplete, false);
  assert.ok(result.purchaseCostOre !== null);
  assert.equal(result.statesExplored, 25);
  assert.ok(result.unresolved.some(item => item.reason === 'optimization_state_bound_exceeded'));
});

test('keeps an incumbent basket complete when the work budget prevents proving optimality', () => {
  const result = optimizeBasket(request([demand('flour', 100, ['a', 'b'])], [
    observed('a', 100, 100), observed('b', 100, 90),
  ], { maxWork: 41 }));
  assert.equal(result.complete, true);
  assert.equal(result.optimizationComplete, false);
  assert.equal(result.purchaseCostOre, result.knownPurchaseCostOre);
  assert.equal(result.knownPurchaseCostOre, 100);
  assert.equal(result.workExplored, 41);
  assert.ok(result.unresolved.some(item => item.reason === 'optimization_work_bound_exceeded'));
});

test('ranks menu finalists by actual basket cost and leaves incomplete menus out of the priced ordering', () => {
  const finalists = [
    { id: 'reference-cheap', referenceCostOre: 1, demands: [demand('a', 100, ['expensive'])] },
    { id: 'checkout-cheap', referenceCostOre: 9999, demands: [demand('b', 100, ['cheap'])] },
    { id: 'unpriced', referenceCostOre: 0, demands: [demand('c', null, ['cheap'])] },
  ];
  assert.deepEqual(finalistProductIds(finalists), ['cheap', 'expensive']);
  const ranked = rankMenuFinalists(finalists, { retailer: 'coop', scope, observations: [
    observed('expensive', 100, 500), observed('cheap', 100, 100),
  ], now, budgetOre: 200 });
  assert.deepEqual(ranked.map(x => x.id), ['checkout-cheap', 'reference-cheap', 'unpriced']);
  assert.equal(ranked[0].basket.withinBudget, true);
  assert.equal(ranked[1].basket.withinBudget, false);
  assert.equal(ranked[2].basket.purchaseCostOre, null);
});

test('supports public variable-weight pricing and rejects approximate weights as guaranteed checkout quantities', () => {
  const weighted = optimizeBasket(request([demand('flour', 250, ['by-weight'])], [observed('by-weight', 0, 300, { basis: 'kg', depositOre: 0 })]));
  assert.equal(weighted.complete, true);
  assert.equal(weighted.purchaseCostOre, 75);
  assert.equal(weighted.lines[0].packs, null);
  const approximate = optimizeBasket(request([demand('flour', 250, ['approx'])], [observed('approx', 300, 300, { basis: 'kg', approximate: true })]));
  assert.equal(approximate.complete, false);
  assert.equal(approximate.purchaseCostOre, null);
});

test('never treats a kg or litre price as a fixed package price for an incompatible unit', () => {
  const kgPieces = optimizeBasket(request([demand('flour', 2, ['kg-piece'], { unit: 'piece' })], [
    observed('kg-piece', 1, 100, { unit: 'piece', basis: 'kg' }),
  ]));
  assert.equal(kgPieces.complete, false);
  assert.equal(kgPieces.purchaseCostOre, null);
  const litreGrams = optimizeBasket(request([demand('flour', 250, ['litre-grams'])], [
    observed('litre-grams', 500, 100, { basis: 'l' }),
  ]));
  assert.equal(litreGrams.complete, false);
  assert.equal(litreGrams.purchaseCostOre, null);
});

test('rejects stale or implausibly long observation windows even when expiry is still in the future', () => {
  const tooOld = observed('old', 100, 100, { checkedAt: '2026-10-07T08:00:00Z', expiresAt: '2026-10-09T12:00:00Z' });
  const tooLong = observed('long', 100, 100, { checkedAt: '2026-10-08T09:00:00Z', expiresAt: '2026-10-09T12:00:00Z' });
  const result = optimizeBasket(request([demand('flour', 100, ['old', 'long'])], [tooOld, tooLong]));
  assert.equal(result.complete, false);
  assert.equal(result.purchaseCostOre, null);
});

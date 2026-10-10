import test from "node:test";
import assert from "node:assert/strict";
import { aggregateShopping, calculateLine, sourcedAmount } from "../src/meal-cost.ts";

const product = (overrides: Record<string, unknown> = {}) => ({
  code: "SUGAR-500",
  name: "Granulated sugar",
  brand: null,
  priceOre: 2000,
  priceUnit: "kr/st",
  depositOre: 0,
  available: true,
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  pack: { quantity: 500, unit: "g", approximate: false, drainedGrams: null },
  ...overrides,
});

const sugarCup = { ingredient_original: "granulated sugar", unit: "cup", measured_quantity: "1" };

test("curated source volume converts to grams for an exactly weighed package and keeps estimate provenance", () => {
  const line = calculateLine(sugarCup, product(), "matched", 1);
  assert.equal(line.status, "priced");
  assert.deepEqual(line.amount, { unit: "g", quantity: 200 });
  assert.equal(line.consumedCostOre, 800);
  assert.equal("conversionEvidence" in line, true);
  assert.equal(line.conversionEvidence?.source, "USDA FoodData Central SR Legacy");
  assert.equal(line.conversionEvidence?.approximate, true);

  const [shopping] = aggregateShopping([line]);
  assert.equal(shopping.packs, 1);
  assert.equal(shopping.approximate, false, "the retailer package metadata remains exact");
  assert.equal(shopping.amountApproximate, true, "the sourced ingredient amount remains visibly estimated");
});

test("serving scale is applied linearly to reference amounts and costs", () => {
  const half = calculateLine(sugarCup, product(), "matched", 0.5);
  const oneAndHalf = calculateLine(sugarCup, product(), "matched", 1.5);
  assert.deepEqual(half.amount, { unit: "g", quantity: 100 });
  assert.deepEqual(oneAndHalf.amount, { unit: "g", quantity: 300 });
  assert.equal(half.consumedCostOre, 400);
  assert.equal(oneAndHalf.consumedCostOre, 1200);
});

test("missing and conflicting quantities stay unresolved, while an explicit override takes precedence", () => {
  assert.equal(sourcedAmount({ ...sugarCup, measured_quantity: null }), null);
  assert.equal(sourcedAmount({ ...sugarCup, quantity_conflict: 1 }), null);

  const missing = calculateLine({ ...sugarCup, measured_quantity: null }, product(), "matched", 1);
  const conflict = calculateLine({ ...sugarCup, quantity_conflict: 1 }, product(), "matched", 1);
  assert.equal(missing.status, "unresolved");
  assert.equal(missing.reason, "quantity_unknown_or_qualitative");
  assert.equal(conflict.status, "unresolved");
  assert.equal(conflict.reason, "conflicting_source_quantity");

  const overridden = calculateLine(sugarCup, product(), "matched", 1, { unit: "g", quantity: 75 });
  assert.equal(overridden.status, "priced");
  assert.deepEqual(overridden.amount, { unit: "g", quantity: 75 });
  assert.equal(overridden.consumedCostOre, 300);
  assert.equal("conversionEvidence" in overridden, false, "a user-supplied amount is not labeled as a USDA estimate");
});

test("millilitres never become grams without a supported density, and unknown units are not guessed", () => {
  const liquid = { ingredient_original: "liquid honey", unit: "ml", measured_quantity: "100" };
  const densityRequired = calculateLine(liquid, product(), "matched", 1);
  assert.equal(densityRequired.status, "unresolved");
  assert.deepEqual(densityRequired.amount, { unit: "ml", quantity: 100 });
  assert.equal(densityRequired.reason, "density_required");

  const unknown = { ingredient_original: "granulated sugar", unit: "handful", measured_quantity: "1" };
  assert.equal(sourcedAmount(unknown), null);
  const unknownLine = calculateLine(unknown, product(), "matched", 1);
  assert.equal(unknownLine.status, "unresolved");
  assert.equal(unknownLine.reason, "unit_conversion_unknown");
});

test("approximate or drained package weights cannot support a fixed-price gram quote", () => {
  const approximatePack = calculateLine(sugarCup, product({
    pack: { quantity: 500, unit: "g", approximate: true, drainedGrams: null },
  }), "matched", 1);
  assert.equal(approximatePack.status, "unresolved");
  assert.equal(approximatePack.amount?.unit, "g");

  const drainedPack = calculateLine(sugarCup, product({
    pack: { quantity: 500, unit: "g", approximate: false, drainedGrams: 400 },
  }), "matched", 1);
  assert.equal(drainedPack.status, "unresolved");
  assert.equal(drainedPack.reason, "drained_weight_basis_requires_review");
});

test("a zero fraction does not become a free purchased ingredient", () => {
  const line=calculateLine({...sugarCup,measured_quantity:"0/2"},product(),"matched",1);
  assert.equal(line.status,"unresolved");
  assert.equal(line.reason,"quantity_unknown_or_qualitative");
});

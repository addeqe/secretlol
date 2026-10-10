import test from "node:test";
import assert from "node:assert/strict";
import { referenceAmount } from "../src/meal-conversions.ts";

test("curated USDA volume references include source evidence and conservative uncertainty", () => {
  const sugar = referenceAmount("  Granulated Sugar ", "tsp", 2);
  assert.ok(sugar);
  assert.deepEqual(sugar.amount, { unit: "g", quantity: 8.4 });
  assert.equal(sugar.evidence.source, "USDA FoodData Central SR Legacy");
  assert.equal(sugar.evidence.release, "April 2018");
  assert.equal(sugar.evidence.fdcId, 169655);
  assert.equal(sugar.evidence.description, "Sugars, granulated");
  assert.equal(sugar.evidence.measure, "tsp");
  assert.equal(sugar.evidence.gramsPerUnit, 4.2);
  assert.equal(sugar.evidence.mappingMethod, "curated-exact-food-equivalence");
  assert.equal(sugar.evidence.approximate, true);
  assert.equal(sugar.evidence.uncertaintyPercent, 20);
  assert.equal(sugar.evidence.sourceMeasures[0].gramWeight, 4.2);

  const honey = referenceAmount("liquid honey", "tablespoons", 1.5, 2);
  assert.ok(honey);
  assert.deepEqual(honey.amount, { unit: "g", quantity: 63 });
  assert.equal(honey.evidence.measure, "tbsp");
});

test("count weights require an exact explicit size; ambiguous prep-specific densities remain unresolved", () => {
  const smallOnion = referenceAmount("small onion", "piece", 2);
  assert.ok(smallOnion);
  assert.deepEqual(smallOnion.amount, { unit: "g", quantity: 140 });
  assert.equal(smallOnion.evidence.measure, "small");

  assert.equal(referenceAmount("onion", "count", 2), null);
  assert.equal(referenceAmount("carrots", "cup", 1), null, "multiple chopped/grated/sliced source measures cannot be selected without prep context");
  assert.equal(referenceAmount("egg", "count", 2), null, "an unspecified egg size has no safe count weight");
});

test("unsupported, qualitative, malformed and prototype-like inputs do not gain a guessed amount", () => {
  assert.equal(referenceAmount("mystery ingredient", "cup", 1), null);
  assert.equal(referenceAmount("salt", "pinch", 1), null);
  assert.equal(referenceAmount("salt", "cup", Number.NaN), null);
  assert.equal(referenceAmount("salt", "cup", 1, 0), null);
  assert.equal(referenceAmount("constructor", "cup", 1), null);
  assert.equal(referenceAmount("__proto__", "cup", 1), null);

  assert.equal(referenceAmount("salt", "T", 1)?.amount.quantity, 18);
  assert.equal(referenceAmount("salt", "t", 1)?.amount.quantity, 6, "uppercase T is tablespoon and lowercase t is teaspoon");

  const fractional = referenceAmount("paprika", "tsp", 1 / 3, 0.15);
  assert.ok(fractional);
  assert.ok(Math.abs(fractional.amount.quantity - 0.115) < 1e-12, "source-unit conversion keeps full precision until quote aggregation");
});

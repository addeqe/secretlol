import conversionData from "./meal-conversions-data.json" with { type: "json" };

type UnitConversion = {
  gramsPerUnit: number;
  measure: string;
  sourceMeasures: Array<{
    measure: string;
    portionDescription: string;
    sourceModifier: string;
    amountBasis: number;
    gramWeight: number;
    gramsPerUnit: number;
  }>;
  approximate: true;
  uncertaintyPercent: number;
};

type SourceFood = {
  description: string;
  mappingMethod: string;
  mappingRationale: string;
  conversions: {
    cup?: UnitConversion;
    tablespoon?: UnitConversion;
    teaspoon?: UnitConversion;
    count?: Record<string, UnitConversion>;
  };
};

type ConversionAsset = {
  schemaVersion: number;
  source: {
    name: string;
    release: string;
    archiveSha256: string;
    license: string;
    citation: string;
    uncertaintyPolicy: string;
  };
  foods: Record<string, SourceFood>;
  ingredients: Record<string, number>;
};

const asset = conversionData as ConversionAsset;

export type ReferenceAmountResult = {
    amount: { unit: "g"; quantity: number };
  evidence: {
    source: string;
    release: string;
    fdcId: number;
    description: string;
    mappingMethod: string;
    mappingRationale: string;
    measure: string;
    gramsPerUnit: number;
    approximate: true;
    uncertaintyPercent: number;
    sourceMeasures: UnitConversion["sourceMeasures"];
  };
};

function normalizeIngredientName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US").replace(/&/g, "and").replace(/\s+/g, " ").trim().replace(/^[ ,.;:]+|[ ,.;:]+$/g, "");
}

type CanonicalSourceUnit = "cup" | "tablespoon" | "teaspoon" | "count";

function normalizeSourceUnit(unit: string): CanonicalSourceUnit | null {
  const raw = unit.normalize("NFKC").trim();
  if (raw === "T") return "tablespoon";
  if (raw === "t") return "teaspoon";
  const key = raw.toLocaleLowerCase("en-US").replace(/[.]/g, "").replace(/\s+/g, " ").trim();
  if (["cup", "cups", "c"].includes(key)) return "cup";
  if (["tablespoon", "tablespoons", "tbsp", "tbs", "tbl", "tblsp"].includes(key)) return "tablespoon";
  if (["teaspoon", "teaspoons", "tsp", "ts", "tspn"].includes(key)) return "teaspoon";
  if (["count", "piece", "pieces", "pc", "pcs", "each", "item", "items"].includes(key)) return "count";
  return null;
}

/**
 * Return a conservative USDA-backed source-unit-to-gram estimate.
 *
 * Only aliases explicitly present in the generated asset are considered.
 * Unknown/qualitative amounts should remain unresolved at the caller and must
 * not be turned into an artificial quantity before calling this function.
 */
export function referenceAmount(name: string, unit: string, quantity: number, scale = 1): ReferenceAmountResult | null {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(scale) || scale <= 0) return null;
  const ingredient = normalizeIngredientName(name);
  if (!Object.hasOwn(asset.ingredients, ingredient)) return null;
  const fdcId = asset.ingredients[ingredient];
  const sourceUnit = normalizeSourceUnit(unit);
  if (!sourceUnit) return null;
  if (!Object.hasOwn(asset.foods, String(fdcId))) return null;
  const food = asset.foods[String(fdcId)];
  if (!food) return null;
  let reference: UnitConversion | undefined;

  // The one emitted count mapping is only for an explicitly size-qualified
  // ingredient name (`small onion`). It cannot make a generic `onion` safe.
  if (sourceUnit === "count") {
    const explicitSize = /\b(small|medium|large)\b/.exec(normalizeIngredientName(name))?.[1];
    if (!explicitSize) return null;
    reference = food.conversions.count?.[explicitSize];
  } else reference = food.conversions[sourceUnit];
  if (!reference) return null;

  const amount = quantity * scale * reference.gramsPerUnit;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount: { unit: "g", quantity: amount },
    evidence: {
      source: asset.source.name,
      release: asset.source.release,
      fdcId,
      description: food.description,
      mappingMethod: food.mappingMethod,
      mappingRationale: food.mappingRationale,
      measure: reference.measure,
      gramsPerUnit: reference.gramsPerUnit,
      approximate: true,
      uncertaintyPercent: reference.uncertaintyPercent,
      sourceMeasures: reference.sourceMeasures,
    },
  };
}

/**
 * Narrow, manually reviewed slot exclusions for known source-corpus defects.
 * These are exact recipe IDs, not title or ingredient heuristics.
 */
export const planningQualityPolicyVersion = 'curated-slot-quality-v1';

export const planningSlots = ['breakfast', 'lunch', 'dinner', 'snack', 'dessert'] as const;
export type PlanningSlot = typeof planningSlots[number];

export type CuratedPlanningRule = {
  recipeId: number;
  excludedSlots: readonly PlanningSlot[] | 'all';
  evidence: string;
};

export const curatedPlanningRules: readonly CuratedPlanningRule[] = [
  {
    recipeId: 520104,
    excludedSlots: 'all',
    evidence: "Source title 'Test Title', instructions 'drink testing new.' and 'MIX TESTING.', ingredients only milk/water; test content is not a recipe.",
  },
  {
    recipeId: 366954,
    excludedSlots: ['lunch', 'dinner'],
    evidence: "Spinach Pasta ingredients are flour, salt, eggs and spinach; source steps say to dry the pasta or use fresh pasta, with no sauce or filling ingredients.",
  },
  {
    recipeId: 423015,
    excludedSlots: ['lunch', 'dinner'],
    evidence: "Honey Wheat Tortillas are a tortilla component; source says they are ready to use for snack wraps and contains no filling.",
  },
  {
    recipeId: 436447,
    excludedSlots: ['lunch', 'dinner'],
    evidence: "Homemade Udon ingredients are salt, water and flour; vegetables/meat are serving suggestions rather than ingredients.",
  },
  {
    recipeId: 196476,
    excludedSlots: ['lunch', 'dinner'],
    evidence: "Basic Pancake Wrap source says the wraps can be filled, but the recipe contains no filling ingredients.",
  },
  {
    recipeId: 312879,
    excludedSlots: ['lunch', 'dinner'],
    evidence: "Strawberry Leather is berries and sugar dried and rolled; it is a snack/confection, not a lunch or dinner main.",
  },
];

export function parsePlanningSlot(value: string | null): PlanningSlot | null {
  if (value === null) return null;
  return (planningSlots as readonly string[]).includes(value) ? value as PlanningSlot : null;
}

export function isPlanningRecipeEligible(recipeId: number, slot?: PlanningSlot): boolean {
  const rule = curatedPlanningRules.find(item => item.recipeId === recipeId);
  if (!rule) return true;
  if (rule.excludedSlots === 'all') return false;
  return slot === undefined || !rule.excludedSlots.includes(slot);
}

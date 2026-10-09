import { parseCoopProduct } from './coop.ts';
import type { StoreScope } from './types.ts';

const RUNTIME_SCOPE: StoreScope = { storeId: 'runtime-only', channel: 'pickup' };
const RUNTIME_CHECKED_AT = new Date('2026-01-01T00:00:00.000Z');
const RUNTIME_PRODUCT = Object.freeze({
  id: 'runtime-only',
  name: 'Runtime parser warmup',
  ean: '0000000000000',
  packageSize: '1 kg',
  packageSizeUnit: 'kg',
  listOfIngredients: 'water',
  navCategories: [{ code: 'runtime-category', superCategories: [{ code: 'runtime-parent' }] }],
  salesUnit: 'vikt',
  salesPriceData: { b2cPrice: '10.00' },
  availableOnline: true,
});

let initialized = false;

/** Compile the pure Coop product parser's common mass-price path before first use. */
export function initializeCoopParserRuntime(): void {
  if (initialized) return;
  // This synthetic observation is deliberately discarded; it never reaches a cache or response.
  parseCoopProduct(RUNTIME_PRODUCT, RUNTIME_SCOPE, RUNTIME_CHECKED_AT, true);
  initialized = true;
}

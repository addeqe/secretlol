import { createHash } from 'node:crypto';
import { productId as isProductId } from './types.ts';
import type { NutritionSourceJson, ProductNutritionSource, RetailerId } from './types.ts';

const FIELDS = ['nutrientLinks', 'nutrientInformation', 'nutrientBasis'] as const;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_ARRAY_ITEMS = 400;
const MAX_DEPTH = 32;

function canonical(value: NutritionSourceJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, NutritionSourceJson>)[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Retain the declared labels and basis without interpreting their nutritional meaning.
 * Nulls, empty fields and unexpected JSON-compatible shapes stay available to the
 * normalizer. Non-JSON values, cycles, excessive nesting/arrays or oversized evidence
 * are omitted as unknown, so malformed nutrition never prevents a price refresh.
 */
export function captureNutritionSource(retailer: RetailerId, productId: string,
  raw: Record<string, unknown>): ProductNutritionSource | undefined {
  try {
    if (!['coop', 'ica'].includes(retailer) || !isProductId(productId)) return undefined;
    let remaining = MAX_SOURCE_BYTES;
    const active = new WeakSet<object>();
    const consume = (bytes: number) => {
      remaining -= bytes;
      if (remaining < 0) throw new Error('nutrition_source_too_large');
    };
    const textBytes = (value: string) => {
      if (Buffer.byteLength(value, 'utf8') > MAX_SOURCE_BYTES) throw new Error('nutrition_source_too_large');
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    };
    const clone = (value: unknown, depth = 0): NutritionSourceJson => {
      if (depth > MAX_DEPTH) throw new Error('nutrition_source_too_deep');
      if (value === null || typeof value === 'boolean' || typeof value === 'string'
        || typeof value === 'number' && Number.isFinite(value)) {
        consume(typeof value === 'string' ? textBytes(value) : Buffer.byteLength(JSON.stringify(value), 'utf8'));
        return value;
      }
      if (typeof value !== 'object' || active.has(value)) throw new Error('nutrition_source_not_json');
      active.add(value);
      try {
        if (Array.isArray(value)) {
          if (value.length > MAX_ARRAY_ITEMS) throw new Error('nutrition_source_array_too_large');
          consume(2 + value.length);
          return Object.freeze(Array.from(value, item => clone(item, depth + 1)));
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw new Error('nutrition_source_not_json');
        const result: Record<string, NutritionSourceJson> = {};
        consume(2);
        for (const key of Object.keys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !('value' in descriptor)) throw new Error('nutrition_source_not_json');
          consume(textBytes(key) + 2);
          Object.defineProperty(result, key, { value: clone(descriptor.value, depth + 1), enumerable: true });
        }
        return Object.freeze(result);
      } finally {
        active.delete(value);
      }
    };
    const payload: Record<string, NutritionSourceJson> = {};
    for (const field of FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, field);
      if (!descriptor) continue;
      if (!('value' in descriptor)) return undefined;
      consume(textBytes(field) + 2);
      payload[field] = clone(descriptor.value);
    }
    if (Object.keys(payload).length === 0) return undefined;
    const sourcePayload = Object.freeze(payload);
    const contentHash = createHash('sha256').update(canonical(sourcePayload), 'utf8').digest('hex');
    const source: ProductNutritionSource = { schemaVersion: 1, retailer, productId, contentHash, sourcePayload };
    if (Buffer.byteLength(JSON.stringify(source), 'utf8') > MAX_SOURCE_BYTES) return undefined;
    return Object.freeze(source);
  } catch {
    return undefined;
  }
}

/** Rebuild bounded, immutable evidence after reading an optional legacy checkpoint field. */
export function copyNutritionSource(source: unknown, retailer: RetailerId,
  productId: string): ProductNutritionSource | undefined {
  try {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
    const record = source as Record<string, unknown>;
    if (record.schemaVersion !== 1 || record.retailer !== retailer || record.productId !== productId
      || typeof record.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.contentHash)
      || !record.sourcePayload || typeof record.sourcePayload !== 'object'
      || Array.isArray(record.sourcePayload)) return undefined;
    const copied = captureNutritionSource(retailer, productId, record.sourcePayload as Record<string, unknown>);
    return copied?.contentHash === record.contentHash ? copied : undefined;
  } catch {
    return undefined;
  }
}

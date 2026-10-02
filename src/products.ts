import { createHash } from 'node:crypto';
import type { Entry, SourceProduct } from './types.ts';

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function moneyOre(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/[\s\u00a0]/g, '').replace(/kr(?:\/(?:st|kg|l))?$/i, '').replace(',', '.');
  return /^\d+(?:\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
}
export function normalize(raw: SourceProduct, category: string, observedAt: string): Entry {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(raw.code) || !raw.name?.trim()) throw new Error('Invalid product identity');
  if (JSON.stringify(raw).length > 50000) throw new Error(`Oversized product ${raw.code}`);
  const priceOre = moneyOre(raw.priceValue);
  const depositOre = raw.depositPrice === '' || raw.depositPrice === undefined || raw.depositPrice === null
    ? 0 : moneyOre(raw.depositPrice);
  const priceUnit = typeof raw.priceUnit === 'string' ? raw.priceUnit : '';
  const comparePriceOre = moneyOre(raw.comparePrice);
  const comparePriceUnit = typeof raw.comparePriceUnit === 'string' ? raw.comparePriceUnit : '';
  const offers = Array.isArray(raw.potentialPromotions) ? [...raw.potentialPromotions]
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b))) : [];
  const sourcePricing = Object.fromEntries(Object.entries(raw).filter(([key]) => /price|promotion|savings|discount|deposit/i.test(key)));
  sourcePricing.potentialPromotions = offers;
  // Stock observations are kept in the catalogue, not treated as price changes.
  const priceHash = createHash('sha256').update(stableJson({ priceOre, priceUnit, comparePriceOre,
    comparePriceUnit, depositOre, offers, sourcePricing })).digest('hex');
  return { code: raw.code, name: raw.name, brand: typeof raw.manufacturer === 'string' ? raw.manufacturer : null,
    categories: [category], priceOre, priceUnit, comparePriceOre, comparePriceUnit, depositOre,
    available: raw.online === true && raw.outOfStock === false && raw.addToCartDisabled === false && priceOre !== null,
    offers, sourcePricing, priceHash, raw, observedAt };
}

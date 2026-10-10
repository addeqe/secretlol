import { calendarWeekEnd } from '../price-freshness.ts';
import type { ProductObservation } from './types.ts';

/** Reinterpret reference snapshots under the current age policy without rewriting
 * unchanged product rows. Campaign end dates still constrain the source price.
 * Local customer observations retain the resolver's separate 30-minute expiry. */
export function referenceObservation(observation: ProductObservation, checkedAt = observation.checkedAt): ProductObservation {
  const expiry = Math.min(calendarWeekEnd(Date.parse(checkedAt)),
    observation.price?.validUntil ? Date.parse(observation.price.validUntil) : Infinity);
  return {...observation, checkedAt, expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : ''};
}

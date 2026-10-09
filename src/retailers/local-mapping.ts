import { productIdentity, type ReviewedConnection } from './identity.ts';
import { productId } from './types.ts';
import type { RetailProduct } from './types.ts';

export type LocalMapping = { referenceProductId: string; referenceIdentity: string;
  localProduct: RetailProduct; checkedAt: string };

// A changed ID is allowed only for the very same packaged product. New substitutes
// require another review; a shared name alone does not prove ingredient safety.
export function mappedConnections(connections: ReviewedConnection[], mappings: LocalMapping[]): ReviewedConnection[] {
  const byId = new Map(mappings.map(m => [m.referenceProductId, m]));
  if (byId.size !== mappings.length) throw new Error('duplicate_local_mapping');
  // Validate a reference mapping once even when many ingredient rows share it.
  // Keep this lazy so unused mappings retain the prior behavior.
  const resolved = new Map<string, { productId: string; identity: string }>();
  return connections.map(c => ({ ...c, approvedProducts: c.approvedProducts.map(p => {
    const m = byId.get(p.productId);
    if (!m) return p; // Same-ID lookups are still checked against the full reviewed identity.
    const cached = resolved.get(p.productId);
    if (cached) {
      if (m.referenceIdentity !== p.identity) throw new Error('unverified_local_mapping');
      return { ...cached };
    }
    if (!productId(m.localProduct.id) || !m.localProduct.ean || m.referenceIdentity !== p.identity
      || !Number.isFinite(Date.parse(m.checkedAt))
      || productIdentity({ ...m.localProduct, id: p.productId }) !== p.identity) {
      throw new Error('unverified_local_mapping');
    }
    const mapping = { productId: m.localProduct.id, identity: productIdentity(m.localProduct) };
    resolved.set(p.productId, mapping);
    return mapping;
  }), mainProductId: c.mainProductId ? byId.get(c.mainProductId)?.localProduct.id ?? c.mainProductId : null }));
}

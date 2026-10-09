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
  return connections.map(c => ({ ...c, approvedProducts: c.approvedProducts.map(p => {
    const m = byId.get(p.productId);
    if (!m) return p; // Same-ID lookups are still checked against the full reviewed identity.
    if (!productId(m.localProduct.id) || !m.localProduct.ean || m.referenceIdentity !== p.identity
      || !Number.isFinite(Date.parse(m.checkedAt))
      || productIdentity({ ...m.localProduct, id: p.productId }) !== p.identity) {
      throw new Error('unverified_local_mapping');
    }
    return { productId: m.localProduct.id, identity: productIdentity(m.localProduct) };
  }), mainProductId: c.mainProductId ? byId.get(c.mainProductId)?.localProduct.id ?? c.mainProductId : null }));
}

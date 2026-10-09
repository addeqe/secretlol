import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productIdentity, type ReviewedConnection } from '../src/retailers/identity.ts';
import { LocalProductResolver, MemoryObservationCache } from '../src/retailers/resolver.ts';
import { mappedConnections } from '../src/retailers/local-mapping.ts';
import { scopeKey, type ProductObservation, type RetailClient, type StoreScope } from '../src/retailers/types.ts';

const scope: StoreScope = { storeId: 'selected-local-store', channel: 'pickup' };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/retailers/demo-coop.json', import.meta.url), 'utf8')) as {
  observations: ProductObservation[]; connections: ReviewedConnection[];
};

function currentFixture(now: number) {
  const observations = structuredClone(fixture.observations);
  for (const observation of observations) {
    observation.checkedAt = new Date(now - 60_000).toISOString();
    observation.expiresAt = new Date(now + 60 * 60_000).toISOString();
  }
  const connections = structuredClone(fixture.connections);
  for (const connection of connections) {
    for (const approved of connection.approvedProducts) {
      approved.identity = productIdentity(observations.find(o => o.product.id === approved.productId)!.product);
    }
  }
  return { observations, connections };
}

test('local resolver returns the same approved observations in source order with indexed lookup', async () => {
  const now = Date.now();
  const { observations, connections } = currentFixture(now);
  const cache = new MemoryObservationCache();
  const encodedScope = scopeKey('coop', scope);
  for (const observation of observations) {
    observation.scope = scope;
    observation.storeScopeVerified = true;
    await cache.set(JSON.stringify([encodedScope, observation.product.id]), observation);
  }
  const client = {
    retailer: 'coop', capabilities: { verifiedStorePricing: false },
    products: async () => { throw new Error('unexpected_network_lookup'); },
  } as unknown as RetailClient;
  const actual = await new LocalProductResolver(client, cache).resolve(scope, connections, now);
  assert.deepEqual(actual.observations.map(o => o.product.id), [...observations].map(o => o.product.id).sort());
  for (const connection of connections) {
    const expected = actual.observations.filter(o => connection.approvedProducts.some(p => p.productId === o.product.id)
      && connection.status === 'matched' && pIdentity(connection, o));
    assert.deepEqual(actual.eligible.get(connection.ingredientId)?.map(o => o.product.id), expected.map(o => o.product.id));
  }
});

test('local resolver deduplicates repeated approved IDs like the previous full scan', async () => {
  const now = Date.now();
  const { observations, connections } = currentFixture(now);
  const connection = structuredClone(connections.find(c => c.status === 'matched')!);
  connection.approvedProducts.push({ ...connection.approvedProducts[0]! });
  const cache = new MemoryObservationCache();
  const encodedScope = scopeKey('coop', scope);
  for (const observation of observations) {
    observation.scope = scope;
    observation.storeScopeVerified = true;
    await cache.set(JSON.stringify([encodedScope, observation.product.id]), observation);
  }
  const client = { retailer: 'coop', capabilities: { verifiedStorePricing: false },
    products: async () => { throw new Error('unexpected_network_lookup'); } } as unknown as RetailClient;
  const result = await new LocalProductResolver(client, cache).resolve(scope, [connection], now);
  assert.equal(result.eligible.get(connection.ingredientId)?.length, 1);
  assert.equal(result.eligible.get(connection.ingredientId)?.[0]?.product.id, connection.approvedProducts[0]?.productId);
});

function pIdentity(connection: ReviewedConnection, observation: ProductObservation) {
  return connection.approvedProducts.some(p => p.productId === observation.product.id
    && p.identity === productIdentity(observation.product));
}

test('local mapping validates a shared changed-ID mapping and returns independent records', () => {
  const { observations, connections } = currentFixture(Date.now());
  const source = observations[0]!;
  const approvals = connections.filter(c => c.approvedProducts.some(p => p.productId === source.product.id));
  if (approvals.length < 2) return;
  const localProduct = { ...structuredClone(source.product), id: 'mapped-local-product' };
  const mapping = { referenceProductId: source.product.id, referenceIdentity: productIdentity(source.product),
    localProduct, checkedAt: '2026-10-09T08:00:00.000Z' };
  const mapped = mappedConnections(approvals, [mapping]);
  assert.equal(mapped.length, approvals.length);
  assert.notEqual(mapped[0]!.approvedProducts[0], mapped[1]!.approvedProducts[0]);
  assert.equal(mapped[0]!.approvedProducts[0]!.productId, localProduct.id);
});

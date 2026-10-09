import { reviewedProductPolicy } from './identity.ts';
import { scopeKey } from './types.ts';
import type { BasketLine, BasketRequest, BasketResult, IngredientDemand, MenuFinalist, ProductObservation, RankedMenu } from './types.ts';

type Group = { ingredientId: string; names: string[]; quantity: number; unit: 'g' | 'ml' | 'piece'; approved: string[] };
type PricedOption = { observation: ProductObservation; group: Group; packs: number | null; consumedCost: number; purchaseCost: number; deposit: number; capacity: number; leftover: number };
type ProductLine = { productId: string; name: string; packs: number | null; quantity: number; unit: 'g' | 'ml' | 'piece'; consumedQuantity: number; leftoverQuantity: number; consumedCostOre: number; purchaseCostOre: number; depositOre: number };
type PreparedObservations = { byId: Map<string, ProductObservation[]> };
type OptionValidationCache = WeakMap<ProductObservation, Map<string, string | null>>;

const DEFAULT_MAX_STATES = 50_000;
const MAX_STATES = 500_000;
const DEFAULT_MAX_WORK = 2_000_000;
const MAX_WORK = 10_000_000;
// Canonical demands are g/ml/pieces. Below this scale their useful recipe
// precision and weighted-price arithmetic cannot be represented reliably.
const MIN_SUPPORTED_QUANTITY = 1e-9;
type WorkMeter = { limit: number; used: number; exceeded: boolean; spend(): boolean };
function workMeter(limit: number): WorkMeter {
  return { limit, used: 0, exceeded: false, spend() {
    if (this.used >= this.limit) { this.exceeded = true; return false; }
    this.used++; return true;
  } };
}

function finitePositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}
function finiteOre(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}
function timeValue(s: string | null): number | null {
  if (s === null) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}
function sortedUnique(xs: string[]): string[] { return [...new Set(xs)].sort(); }

function makeGroups(demands: IngredientDemand[]) {
  const byId = new Map<string, IngredientDemand[]>();
  for (const d of demands) {
    const old = byId.get(d.ingredientId) ?? [];
    old.push(d);
    byId.set(d.ingredientId, old);
  }
  const groups: Group[] = [];
  const unresolved: BasketResult['unresolved'] = [];
  for (const ingredientId of [...byId.keys()].sort()) {
    const entries = byId.get(ingredientId)!;
    if (entries.every(d => d.nonPurchased)) continue;
    const names = sortedUnique(entries.map(d => d.name));
    const units = sortedUnique(entries.filter(d => !d.nonPurchased).map(d => d.unit ?? ''));
    const quantities = entries.filter(d => !d.nonPurchased).map(d => d.quantity);
    if (units.length !== 1 || !['g', 'ml', 'piece'].includes(units[0])) {
      unresolved.push({ ingredientId, reason: 'incompatible_or_unknown_quantity_unit' });
      continue;
    }
    if (quantities.some(q => !finitePositive(q))) {
      unresolved.push({ ingredientId, reason: 'quantity_unknown_or_invalid' });
      continue;
    }
    if (quantities.some(q => q! < MIN_SUPPORTED_QUANTITY)) {
      unresolved.push({ ingredientId, reason: 'quantity_below_supported_precision' });
      continue;
    }
    const approvedSets = entries.filter(d => !d.nonPurchased).map(d => new Set(d.approvedProductIds));
    const approved = approvedSets.length ? [...approvedSets[0]].filter(id => approvedSets.every(s => s.has(id))).sort() : [];
    let total = 0, precisionLost = false;
    for (const quantity of quantities) {
      const next = total + Number(quantity);
      if (Number(quantity) > 0 && (total > 0 && next === Number(quantity) || next === total)) precisionLost = true;
      total = next;
    }
    if (precisionLost) {
      unresolved.push({ ingredientId, reason: 'quantity_below_supported_precision' });
      continue;
    }
    if (!finitePositive(total)) { unresolved.push({ ingredientId, reason: 'quantity_unknown_or_invalid' }); continue; }
    groups.push({ ingredientId, names, quantity: total, unit: units[0] as Group['unit'], approved });
  }
  return { groups, unresolved };
}

function observationCurrent(o: ProductObservation, request: BasketRequest, now: number): boolean {
  const checked = timeValue(o.checkedAt), expiry = timeValue(o.expiresAt);
  return o.retailer === request.retailer && scopeKey(o.retailer, o.scope) === scopeKey(request.retailer, request.scope)
    && o.storeScopeVerified && o.availability === 'available' && checked !== null && expiry !== null
    && checked <= now + 60_000 && expiry > now && now - checked < 86_400_000
    && expiry > checked && expiry - checked <= 86_400_000;
}

function optionFailure(o: ProductObservation, group: Group, request: BasketRequest, now: number): string | null {
  if (!observationCurrent(o, request, now)) return 'product_unavailable_stale_or_wrong_store';
  if (!o.price) return 'price_unknown';
  const price = o.price;
  if (price.memberOnly || (price.minimumQuantity !== null && price.minimumQuantity > 1)) return 'conditional_price_excluded';
  if (!finiteOre(price.amountOre) || price.depositOre === null || !finiteOre(price.depositOre)) return 'price_or_deposit_unknown';
  const from = timeValue(price.validFrom), until = timeValue(price.validUntil);
  if (price.validFrom !== null && (from === null || from > now) || price.validUntil !== null && (until === null || until <= now)) return 'price_outside_validity_window';
  for (const name of group.names) {
    if (reviewedProductPolicy(o.product, name) !== null) return 'dietary_policy_excluded';
  }
  if (price.basis === 'kg' || price.basis === 'l') {
    const unitPrice = price.basis === 'kg' ? group.unit === 'g' : group.unit === 'ml';
    if (!unitPrice) return 'price_basis_unit_mismatch';
    if (o.product.pack?.approximate) return 'approximate_variable_weight';
    if (price.depositOre !== 0) return 'variable_weight_deposit_basis_unknown';
    return null;
  }
  const pack = o.product.pack;
  if(pack?.drainedGrams!=null&&group.unit==='g')return 'drained_weight_basis_requires_review';
  if (!pack || pack.approximate || pack.unit !== group.unit || !finitePositive(pack.quantity)) return 'package_quantity_or_unit_unknown';
  return null;
}

function optionFor(o: ProductObservation, group: Group, request: BasketRequest, now: number,
  cache?: OptionValidationCache): { option?: PricedOption; reason?: string } {
  const key = JSON.stringify([group.unit, group.names]);
  let reason: string | null | undefined;
  const cached = cache?.get(o);
  if (cached?.has(key)) reason = cached.get(key);
  else {
    reason = optionFailure(o, group, request, now);
    if (cache) {
      const results = cached ?? new Map<string, string | null>();
      results.set(key, reason);
      cache.set(o, results);
    }
  }
  if (reason) return { reason };
  const price = o.price!;
  const depositOre = price.depositOre!;
  if (price.basis === 'kg' || price.basis === 'l') {
    const consumedCost = price.amountOre * group.quantity / 1000;
    const purchaseCost = consumedCost + depositOre;
    return { option: { observation: o, group, packs: null, consumedCost, purchaseCost, deposit: depositOre, capacity: group.quantity, leftover: 0 } };
  }
  const pack = o.product.pack!;
  const packs = Math.ceil(group.quantity / pack.quantity);
  const capacity = packs * pack.quantity;
  const consumedCost = price.amountOre * group.quantity / pack.quantity;
  const deposit = packs * depositOre;
  const purchaseCost = packs * (price.amountOre + depositOre);
  return { option: { observation: o, group, packs, consumedCost, purchaseCost, deposit, capacity, leftover: capacity - group.quantity } };
}

type FlowEdge = { to: number; reverse: number; capacity: number; initialCapacity: number; cost: number };
type Allocation = { assigned: Map<string, Map<string, number>>; variableCost: number };
type AllocationResult = { allocation: Allocation | null; workExceeded: boolean };
function addEdge(graph: FlowEdge[][], from: number, to: number, capacity: number, cost: number): FlowEdge {
  const forward: FlowEdge = { to, reverse: graph[to].length, capacity, initialCapacity: capacity, cost };
  const reverse: FlowEdge = { to: from, reverse: graph[from].length, capacity: 0, initialCapacity: 0, cost: -cost };
  graph[from].push(forward); graph[to].push(reverse); return forward;
}

/** Continuous min-cost flow allocates compatible needs over the products bought in whole packs. */
function allocate(groups: Group[], choices: Map<string, number>, candidates: Map<string, ProductObservation>, eligible: Map<string, Set<string>>, work: WorkMeter) {
  const ids = [...candidates.keys()].sort();
  const productIndexes = new Map(ids.map((id, index) => [id, index]));
  const source = 0, groupBase = 1, productBase = groupBase + groups.length, sink = productBase + ids.length;
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const groupEdges = new Map<string, Array<{ id: string; edge: FlowEdge }>>();
  for (const [index, group] of groups.entries()) {
    if (!work.spend()) return { allocation: null, workExceeded: true };
    addEdge(graph, source, groupBase + index, group.quantity, 0);
    const edges: Array<{ id: string; edge: FlowEdge }> = [];
    for (const id of eligible.get(group.ingredientId) ?? []) {
      if (!work.spend()) return { allocation: null, workExceeded: true };
      const observation = candidates.get(id);
      if (!observation) continue;
      const price = observation.price!;
      const weighted = price.basis === 'kg' || price.basis === 'l';
      const unitMatches = price.basis === 'kg' ? group.unit === 'g' : price.basis === 'l' ? group.unit === 'ml' : observation.product.pack?.unit === group.unit;
      if (!unitMatches) continue;
      const productIndex = productIndexes.get(id);
      if (productIndex === undefined) continue;
      const cost = weighted ? price.amountOre / 1000 : 0;
      edges.push({ id, edge: addEdge(graph, groupBase + index, productBase + productIndex, group.quantity, cost) });
    }
    groupEdges.set(group.ingredientId, edges);
  }
  for (const [index, id] of ids.entries()) {
    if (!work.spend()) return { allocation: null, workExceeded: true };
    const observation = candidates.get(id)!;
    const cap = observation.price!.basis === 'pack' ? observation.product.pack!.quantity * (choices.get(id) ?? 0) : Number.POSITIVE_INFINITY;
    addEdge(graph, productBase + index, sink, cap, 0);
  }

  let variableCost = 0;
  // A global flow epsilon can hide a small ingredient beside much larger
  // demand. Finish based on the individual source edges instead.
  const sourceEdges = graph[source];
  while (sourceEdges.some(edge => edge.capacity > 0)) {
    const dist = Array(graph.length).fill(Number.POSITIVE_INFINITY) as number[];
    const prevNode = Array(graph.length).fill(-1) as number[];
    const prevEdge = Array(graph.length).fill(-1) as number[];
    dist[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass++) {
      let changed = false;
      for (let node = 0; node < graph.length; node++) {
        if (!Number.isFinite(dist[node])) continue;
        for (let ei = 0; ei < graph[node].length; ei++) {
          if (!work.spend()) return { allocation: null, workExceeded: true };
          const edge = graph[node][ei];
          if (edge.capacity > 0 && dist[edge.to] > dist[node] + edge.cost + 1e-12) {
            dist[edge.to] = dist[node] + edge.cost; prevNode[edge.to] = node; prevEdge[edge.to] = ei; changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (!Number.isFinite(dist[sink])) return { allocation: null, workExceeded: false };
    let amount = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source; node = prevNode[node]) {
      if (!work.spend()) return { allocation: null, workExceeded: true };
      amount = Math.min(amount, graph[prevNode[node]][prevEdge[node]].capacity);
    }
    for (let node = sink; node !== source; node = prevNode[node]) {
      if (!work.spend()) return { allocation: null, workExceeded: true };
      const edge = graph[prevNode[node]][prevEdge[node]];
      edge.capacity -= amount; graph[node][edge.reverse].capacity += amount;
    }
    variableCost += amount * dist[sink];
  }
  const assigned = new Map<string, Map<string, number>>();
  const assignedTotals = new Map<string, number>(), assignedCompensations = new Map<string, number>();
  const demandById = new Map(groups.map(group => [group.ingredientId, group.quantity]));
  for (const [ingredientId, edges] of groupEdges) for (const { id, edge } of edges) {
    if (!work.spend()) return { allocation: null, workExceeded: true };
    // The reverse edge is the net forward flow. Subtracting two large forward
    // capacities can round a legitimate small allocation down to zero.
    const amount = graph[edge.to][edge.reverse].capacity;
    if (amount > 0) {
      const group = assigned.get(ingredientId) ?? new Map<string, number>();
      group.set(id, amount); assigned.set(ingredientId, group);
      const sum = assignedTotals.get(ingredientId) ?? 0, compensation = assignedCompensations.get(ingredientId) ?? 0;
      const adjusted = amount - compensation, next = sum + adjusted;
      assignedCompensations.set(ingredientId, (next - sum) - adjusted); assignedTotals.set(ingredientId, next);
    }
  }
  for (const [ingredientId, demand] of demandById) {
    if (!work.spend()) return { allocation: null, workExceeded: true };
    const sum = assignedTotals.get(ingredientId) ?? 0;
    const tolerance = Math.max(Number.MIN_VALUE, Math.max(demand, sum) * Number.EPSILON * 16);
    if (Math.abs(sum - demand) > tolerance) return { allocation: null, workExceeded: false };
  }
  return { allocation: { assigned, variableCost }, workExceeded: false };
}

function buildLines(groups: Group[], allocation: Allocation, choices: Map<string, number>, candidates: Map<string, ProductObservation>) {
  const byProduct = new Map<string, { quantity: number; consumed: number; unit: Group['unit'] }>();
  for (const group of groups) for (const [id, quantity] of allocation.assigned.get(group.ingredientId) ?? []) {
    const observation = candidates.get(id)!, old = byProduct.get(id) ?? { quantity: 0, consumed: 0, unit: group.unit };
    const price = observation.price!;
    old.quantity += quantity;
    old.consumed += price.basis === 'kg' || price.basis === 'l' ? price.amountOre * quantity / 1000
      : price.amountOre * quantity / observation.product.pack!.quantity;
    byProduct.set(id, old);
  }
  const lines: ProductLine[] = [...byProduct.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => {
    const observation = candidates.get(id)!, price = observation.price!;
    const packs = price.basis === 'pack' ? (choices.get(id) ?? 0) : null;
    const capacity = packs === null ? value.quantity : packs * observation.product.pack!.quantity;
    const deposit = packs === null ? 0 : packs * price.depositOre!;
    const purchase = packs === null ? value.quantity * price.amountOre / 1000 : packs * (price.amountOre + price.depositOre!);
    return { productId: id, name: observation.product.name, packs, quantity: value.quantity, unit: value.unit,
      consumedQuantity: value.quantity, leftoverQuantity: Math.max(0, capacity - value.quantity), consumedCostOre: Math.round(value.consumed),
      purchaseCostOre: Math.round(purchase), depositOre: deposit };
  });
  // Preserve raw consumption until all product and component costs have been
  // summed; display lines remain integer öre values.
  return { lines, consumed: [...byProduct.values()].reduce((sum, value) => sum + value.consumed, 0),
    purchase: lines.reduce((sum, line) => sum + line.purchaseCostOre, 0) };
}

/** Exact closed-form cases avoid building a flow graph and enumerating pack counts. */
function solveTrivialComponent(groups: Group[], eligible: Map<string, Set<string>>,
  candidates: Map<string, ProductObservation>, maxStates: number, work: WorkMeter): ReturnType<typeof solveComponent> | null {
  if (groups.length !== 1) return null;
  const group = groups[0], ids = [...(eligible.get(group.ingredientId) ?? [])].filter(id => candidates.has(id));
  if (!ids.length) return null;
  let selected: ProductObservation | undefined;
  if (ids.length === 1) selected = candidates.get(ids[0]);
  else {
    const products = ids.map(id => candidates.get(id)!);
    const packQuantity = products[0].product.pack?.quantity;
    if (products.every(o => o.price!.basis === 'pack' && o.product.pack && o.product.pack.quantity === packQuantity)) {
      const costs = products.map(o => o.price!.amountOre + o.price!.depositOre!);
      const lowest = Math.min(...costs);
      const winner = costs.indexOf(lowest);
      // Tied and zero-cost alternatives use the original exact-search tie behavior.
      if (Number.isSafeInteger(lowest) && lowest > 0 && costs.lastIndexOf(lowest) === winner) selected = products[winner];
    }
  }
  if (!selected) return null;
  const price = selected.price!;
  const packs = price.basis === 'pack' ? Math.ceil(group.quantity / selected.product.pack!.quantity) : null;
  const capacity = packs === null ? group.quantity : packs * selected.product.pack!.quantity;
  const consumed = price.basis === 'pack'
    ? price.amountOre * group.quantity / selected.product.pack!.quantity
    : price.amountOre * group.quantity / 1000;
  const purchase = packs === null ? price.amountOre * group.quantity / 1000
    : packs * (price.amountOre + price.depositOre!);
  // The search path bounds pack-count enumeration and signals when arithmetic
  // exceeds representable checkout values. Do not turn such cases into a
  // complete direct result; let that established bounded behavior handle them.
  if (!Number.isFinite(capacity) || capacity < group.quantity || !Number.isFinite(consumed) || !Number.isSafeInteger(Math.round(consumed))
    || (packs === null ? !Number.isSafeInteger(Math.round(purchase))
      : !Number.isSafeInteger(packs) || packs < 1 || !Number.isSafeInteger(price.amountOre + price.depositOre!)
        || !Number.isSafeInteger(purchase))) return null;
  if (maxStates < 1) return { solution: null, totals: { lines: [], consumed: 0, purchase: 0 },
    statesExplored: 0, optimizationComplete: false, workExceeded: false };
  if (!work.spend()) return { solution: null, totals: { lines: [], consumed: 0, purchase: 0 },
    statesExplored: 0, optimizationComplete: false, workExceeded: true };
  for (const _id of ids) if (!work.spend()) return { solution: null, totals: { lines: [], consumed: 0, purchase: 0 },
    statesExplored: 1, optimizationComplete: false, workExceeded: true };

  const allocation: Allocation = { assigned: new Map([[group.ingredientId, new Map([[selected.product.id, group.quantity]])]]),
    variableCost: price.basis === 'kg' || price.basis === 'l' ? price.amountOre * group.quantity / 1000 : 0 };
  const choices = packs === null ? new Map<string, number>() : new Map([[selected.product.id, packs]]);
  return { solution: { allocation, choices }, totals: buildLines(groups, allocation, choices, candidates),
    statesExplored: 1, optimizationComplete: true, workExceeded: false };
}

function solveComponent(groups: Group[], eligible: Map<string, Set<string>>, candidates: Map<string, ProductObservation>, maxStates: number, work: WorkMeter) {
  const fixedIds = [...candidates.entries()].filter(([, o]) => o.price!.basis === 'pack').map(([id]) => id)
    .sort((a, b) => {
      const pa = candidates.get(a)!, pb = candidates.get(b)!;
      const ca = (pa.price!.amountOre + pa.price!.depositOre!) / pa.product.pack!.quantity;
      const cb = (pb.price!.amountOre + pb.price!.depositOre!) / pb.product.pack!.quantity;
      return ca - cb || a.localeCompare(b);
    });
  const maxPacks = new Map<string, number>();
  for (const id of fixedIds) {
    let quantity = 0;
    for (const group of groups) {
      if (!work.spend()) break;
      if (eligible.get(group.ingredientId)?.has(id)) quantity += group.quantity;
    }
    const required = Math.ceil(quantity / candidates.get(id)!.product.pack!.quantity);
    maxPacks.set(id, Math.min(Number.isFinite(required) ? required : work.limit, work.limit));
    if (work.exceeded) break;
  }
  let statesExplored = 0, boundHit = false;
  let best: { allocation: Allocation; choices: Map<string, number> } | null = null;
  let bestCost = Number.POSITIVE_INFINITY, bestKey = '';
  const choices = new Map<string, number>();
  const totalDemand = groups.reduce((sum, group) => sum + group.quantity, 0);
  const minUnitCost = Math.min(...[...candidates.values()].map(o => o.price!.basis === 'pack'
    ? (o.price!.amountOre + o.price!.depositOre!) / o.product.pack!.quantity : o.price!.amountOre / 1000));
  function visit(index: number, costSoFar: number, capacitySoFar: number): void {
    if (statesExplored >= maxStates) { boundHit = true; return; }
    if (!work.spend()) return;
    statesExplored++;
    if (best && costSoFar + Math.max(0, totalDemand - capacitySoFar) * minUnitCost >= bestCost - 1e-9) return;
    if (index === fixedIds.length) {
      const result = allocate(groups, choices, candidates, eligible, work);
      if (result.workExceeded) return;
      const allocation = result.allocation;
      if (!allocation) return;
      const fixedCost = fixedIds.reduce((sum, id) => sum + (choices.get(id) ?? 0) * (candidates.get(id)!.price!.amountOre + candidates.get(id)!.price!.depositOre!), 0);
      const cost = fixedCost + allocation.variableCost;
      const key = fixedIds.map(id => `${id}:${choices.get(id) ?? 0}`).join('|');
      if (cost < bestCost - 1e-9 || Math.abs(cost - bestCost) < 1e-9 && (best === null || key < bestKey)) {
        bestCost = cost; best = { allocation, choices: new Map(choices) }; bestKey = key;
      }
      return;
    }
    const id = fixedIds[index];
    const observation = candidates.get(id)!, maximum = maxPacks.get(id)!;
    for (let packs = maximum; packs >= 0; packs--) {
      if (boundHit || work.exceeded) return;
      if (!work.spend()) return;
      choices.set(id, packs);
      const price = observation.price!, pack = observation.product.pack!;
      visit(index + 1, costSoFar + packs * (price.amountOre + price.depositOre!), capacitySoFar + packs * pack.quantity);
    }
    choices.delete(id);
  }
  if (!work.exceeded) visit(0, 0, 0);
  const solution = best as { allocation: Allocation; choices: Map<string, number> } | null;
  return { solution, totals: solution ? buildLines(groups, solution.allocation, solution.choices, candidates) : { lines: [] as ProductLine[], consumed: 0, purchase: 0 },
    statesExplored, optimizationComplete: !boundHit && !work.exceeded, workExceeded: work.exceeded };
}

/**
 * For one need with two or three positive-priced pack choices, enumerate all
 * counts for all but the last product and derive the minimum remaining count
 * needed from the last product. This removes a full flow solve at every leaf.
 * The traversal, lower-bound pruning, and incumbent tie handling mirror the
 * general solver; extra last-product packs can never improve a positive-cost
 * checkout for the same prefix.
 */
function solveSingleGroupPackCover(groups: Group[], eligible: Map<string, Set<string>>,
  candidates: Map<string, ProductObservation>, maxStates: number, work: WorkMeter): ReturnType<typeof solveComponent> | null {
  if (groups.length !== 1) return null;
  const group = groups[0];
  const ids = [...(eligible.get(group.ingredientId) ?? [])].filter(id => candidates.has(id)).sort((a, b) => {
    const pa = candidates.get(a)!, pb = candidates.get(b)!;
    const ca = (pa.price!.amountOre + pa.price!.depositOre!) / pa.product.pack!.quantity;
    const cb = (pb.price!.amountOre + pb.price!.depositOre!) / pb.product.pack!.quantity;
    return ca - cb || a.localeCompare(b);
  });
  if (ids.length < 2 || ids.length > 3) return null;
  const observations = ids.map(id => candidates.get(id)!);
  if (observations.some(o => o.price!.basis !== 'pack' || !o.product.pack
    || o.product.pack.unit !== group.unit || !finitePositive(o.product.pack.quantity)
    || !Number.isSafeInteger(o.price!.amountOre + o.price!.depositOre!)
    || o.price!.amountOre + o.price!.depositOre! <= 0)) return null;

  const maxPacks = new Map<string, number>();
  let maxCheckout = 0;
  for (const o of observations) {
    const quantity = o.product.pack!.quantity;
    const required = Math.ceil(group.quantity / quantity);
    const checkout = o.price!.amountOre + o.price!.depositOre!;
    if (!Number.isSafeInteger(required) || required < 1 || required > work.limit
      || !Number.isFinite(required * quantity) || required * quantity < group.quantity
      || !Number.isSafeInteger(required * checkout)) return null;
    maxPacks.set(o.product.id, required);
    maxCheckout += required * checkout;
    const consumed = o.price!.amountOre * group.quantity / quantity;
    if (!Number.isFinite(consumed) || !Number.isSafeInteger(Math.round(consumed))) return null;
  }
  if (!Number.isSafeInteger(maxCheckout)) return null;
  // The direct cover arithmetic must keep every partial capacity meaningful.
  for (let index = 0; index < observations.length - 1; index++) {
    const o = observations[index], cap = maxPacks.get(o.product.id)! * o.product.pack!.quantity;
    if (!Number.isFinite(cap) || cap <= 0) return null;
  }

  let statesExplored = 0, boundHit = false, arithmeticUnsafe = false;
  let best: { allocation: Allocation; choices: Map<string, number> } | null = null;
  let bestCost = Number.POSITIVE_INFINITY, bestKey = '';
  const choices = new Map<string, number>();
  const minUnitCost = Math.min(...observations.map(o => (o.price!.amountOre + o.price!.depositOre!) / o.product.pack!.quantity));

  function considerLast(costSoFar: number, capacitySoFar: number): void {
    const last = observations[observations.length - 1], id = last.product.id;
    const missing = Math.max(0, group.quantity - capacitySoFar);
    const packs = missing === 0 ? 0 : Math.ceil(missing / last.product.pack!.quantity);
    const capacity = packs * last.product.pack!.quantity;
    const totalCapacity = capacitySoFar + capacity;
    if (!Number.isSafeInteger(packs) || packs < 0 || packs > maxPacks.get(id)!
      || !Number.isFinite(capacity) || capacity < missing || !Number.isFinite(totalCapacity) || totalCapacity < group.quantity) {
      arithmeticUnsafe = true; boundHit = true; return;
    }
    choices.set(id, packs);
    const fixedCost = costSoFar + packs * (last.price!.amountOre + last.price!.depositOre!);
    if (!Number.isSafeInteger(fixedCost)) { arithmeticUnsafe = true; boundHit = true; return; }
    // The old leaf solver applies the same lower bound after adding the final
    // product. Preserve its incumbent behavior for equal-cost alternatives.
    if (best && fixedCost + Math.max(0, group.quantity - totalCapacity) * minUnitCost >= bestCost - 1e-9) return;
    const key = ids.map(productId => `${productId}:${choices.get(productId) ?? 0}`).join('|');
    if (fixedCost < bestCost - 1e-9 || Math.abs(fixedCost - bestCost) < 1e-9 && (best === null || key < bestKey)) {
      const assignedIds = [...(eligible.get(group.ingredientId) ?? [])].filter(productId => choices.has(productId));
      let remaining = group.quantity;
      const assigned = new Map<string, number>();
      for (const productId of assignedIds) {
        const observation = candidates.get(productId)!;
        const available = (choices.get(productId) ?? 0) * observation.product.pack!.quantity;
        const amount = Math.min(remaining, available);
        if (amount > 0) assigned.set(productId, amount);
        remaining -= amount;
      }
      if (remaining > 0) { arithmeticUnsafe = true; boundHit = true; return; }
      const allocation: Allocation = { assigned: new Map([[group.ingredientId, assigned]]), variableCost: 0 };
      bestCost = fixedCost; best = { allocation, choices: new Map(choices) }; bestKey = key;
    }
    choices.delete(id);
  }

  function visit(index: number, costSoFar: number, capacitySoFar: number): void {
    if (statesExplored >= maxStates) { boundHit = true; return; }
    if (!work.spend()) return;
    statesExplored++;
    if (best && costSoFar + Math.max(0, group.quantity - capacitySoFar) * minUnitCost >= bestCost - 1e-9) return;
    if (index === ids.length - 1) { considerLast(costSoFar, capacitySoFar); return; }
    const id = ids[index], observation = candidates.get(id)!, maximum = maxPacks.get(id)!;
    for (let packs = maximum; packs >= 0; packs--) {
      if (boundHit || work.exceeded) return;
      if (!work.spend()) return;
      choices.set(id, packs);
      const quantity = packs * observation.product.pack!.quantity;
      const nextCapacity = capacitySoFar + quantity;
      if (!Number.isFinite(quantity) || !Number.isFinite(nextCapacity)
        || quantity > 0 && nextCapacity === capacitySoFar) { arithmeticUnsafe = true; boundHit = true; return; }
      visit(index + 1, costSoFar + packs * (observation.price!.amountOre + observation.price!.depositOre!), nextCapacity);
    }
    choices.delete(id);
  }
  visit(0, 0, 0);
  const solution = best as { allocation: Allocation; choices: Map<string, number> } | null;
  return { solution, totals: solution ? buildLines(groups, solution.allocation, solution.choices, candidates) : { lines: [], consumed: 0, purchase: 0 },
    statesExplored, optimizationComplete: !boundHit && !work.exceeded && !arithmeticUnsafe, workExceeded: work.exceeded };
}

/** Every group in this component has exactly one shared option, so assignment is forced. */
function solveSingleProductComponent(groups: Group[], eligible: Map<string, Set<string>>,
  candidates: Map<string, ProductObservation>, maxStates: number, work: WorkMeter): ReturnType<typeof solveComponent> | null {
  if (groups.length < 2) return null;
  let productId: string | undefined;
  for (const group of groups) {
    const ids = eligible.get(group.ingredientId);
    if (!ids || ids.size !== 1) return null;
    const only = ids.values().next().value as string | undefined;
    if (!only || productId !== undefined && productId !== only) return null;
    productId = only;
  }
  const observation = candidates.get(productId!);
  if (!observation) return null;
  const price = observation.price!;
  let quantity = 0;
  for (const group of groups) quantity += group.quantity;
  let packs: number | null = null;
  if (price.basis === 'pack') {
    const pack = observation.product.pack;
    if (!pack || !finitePositive(pack.quantity) || groups.some(group => group.unit !== pack.unit)) return null;
    packs = Math.ceil(quantity / pack.quantity);
    const capacity = packs * pack.quantity;
    // A rounded aggregate can conceal a small later group; require enough
    // capacity after each ordered group before assigning them directly.
    if (!Number.isSafeInteger(packs) || packs < 1 || !Number.isFinite(capacity) || capacity < quantity) return null;
    let remaining = capacity;
    for (const group of groups) {
      if (remaining < group.quantity) return null;
      remaining -= group.quantity;
    }
    const unitCheckout = price.amountOre + price.depositOre!;
    if (!Number.isSafeInteger(unitCheckout) || !Number.isSafeInteger(packs * unitCheckout)) return null;
  } else {
    const expectedUnit = price.basis === 'kg' ? 'g' : 'ml';
    if (groups.some(group => group.unit !== expectedUnit)) return null;
  }
  const assigned = new Map(groups.map(group => [group.ingredientId, new Map([[productId!,group.quantity]])]));
  let variableCost = 0;
  if (price.basis === 'kg' || price.basis === 'l') {
    const unitCost = price.amountOre / 1000;
    for (const group of groups) variableCost += group.quantity * unitCost;
    if (!Number.isFinite(variableCost) || !Number.isSafeInteger(Math.round(variableCost))) return null;
  }
  const choices = packs === null ? new Map<string,number>() : new Map([[productId!,packs]]);
  const allocation: Allocation = {assigned,variableCost};
  const totals = buildLines(groups,allocation,choices,candidates);
  if (!Number.isSafeInteger(Math.round(totals.consumed)) || !Number.isSafeInteger(Math.round(totals.purchase))) return null;
  if (maxStates < 1) return {solution:null,totals:{lines:[],consumed:0,purchase:0},statesExplored:0,
    optimizationComplete:false,workExceeded:false};
  if (!work.spend()) return {solution:null,totals:{lines:[],consumed:0,purchase:0},statesExplored:0,
    optimizationComplete:false,workExceeded:true};
  for (let index=0;index<groups.length+1;index++) if (!work.spend()) return {solution:null,
    totals:{lines:[],consumed:0,purchase:0},statesExplored:1,optimizationComplete:false,workExceeded:true};
  return {solution:{allocation,choices},totals,statesExplored:1,optimizationComplete:true,workExceeded:false};
}

function compressGroups(groups: Group[], eligible: Map<string, Set<string>>) {
  const compressed = new Map<string, Group>();
  for (const group of groups) {
    const ids = [...(eligible.get(group.ingredientId) ?? [])].sort();
    const key = JSON.stringify([group.unit, ids]);
    const previous = compressed.get(key);
    if (previous) {
      const combined = previous.quantity + group.quantity;
      // Keep a separately representable demand as its own flow group if
      // adding it to this aggregate would erase it at IEEE-754 precision.
      if (combined === previous.quantity || combined === group.quantity) {
        compressed.set(`${key}:precision:${group.ingredientId}`, { ...group, names: [...group.names], approved: [...ids] });
      } else {
        previous.quantity = combined;
        previous.names = sortedUnique([...previous.names, ...group.names]);
      }
    } else compressed.set(key, { ...group, names: [...group.names], approved: [...ids] });
  }
  return [...compressed.values()];
}

function independentComponents(groups: Group[], eligible: Map<string, Set<string>>, candidates: Map<string, ProductObservation>) {
  const byProduct = new Map<string, string[]>();
  for (const group of groups) for (const id of eligible.get(group.ingredientId) ?? []) {
    const linked = byProduct.get(id) ?? []; linked.push(group.ingredientId); byProduct.set(id, linked);
  }
  const byIngredient = new Map(groups.map(group => [group.ingredientId, group]));
  const visited = new Set<string>(), components: Array<{ groups: Group[]; eligible: Map<string, Set<string>>; candidates: Map<string, ProductObservation> }> = [];
  for (const first of [...byIngredient.keys()].sort()) {
    if (visited.has(first)) continue;
    const queue = [first], componentGroups: Group[] = [], productIds = new Set<string>();
    visited.add(first);
    while (queue.length) {
      const id = queue.shift()!, group = byIngredient.get(id)!;
      componentGroups.push(group);
      for (const productId of eligible.get(id) ?? []) {
        productIds.add(productId);
        for (const next of byProduct.get(productId) ?? []) if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
    const componentEligible = new Map(componentGroups.map(group => [group.ingredientId, eligible.get(group.ingredientId)!]));
    const componentCandidates = new Map([...productIds].sort().flatMap(id => candidates.has(id) ? [[id, candidates.get(id)!] as const] : []));
    components.push({ groups: componentGroups.sort((a, b) => a.ingredientId.localeCompare(b.ingredientId)), eligible: componentEligible, candidates: componentCandidates });
  }
  return components.sort((a, b) => a.groups.length - b.groups.length || a.candidates.size - b.candidates.size
    || a.groups[0].ingredientId.localeCompare(b.groups[0].ingredientId));
}

/** Finds the cheapest exact assignment of whole products to all compatible ingredient needs. */
function prepareObservations(observations: ProductObservation[]): PreparedObservations {
  const sorted = [...observations].sort((a, b) => a.product.id.localeCompare(b.product.id)
    || (a.price?.amountOre ?? Number.MAX_SAFE_INTEGER) - (b.price?.amountOre ?? Number.MAX_SAFE_INTEGER)
    || a.checkedAt.localeCompare(b.checkedAt));
  const byId = new Map<string, ProductObservation[]>();
  for (const observation of sorted) {
    const matching = byId.get(observation.product.id);
    if (matching) matching.push(observation);
    else byId.set(observation.product.id, [observation]);
  }
  return { byId };
}

function optimizeBasketPrepared(request: BasketRequest, prepared: PreparedObservations,
  optionCache?: OptionValidationCache, preparedGroups?: ReturnType<typeof makeGroups>): BasketResult {
  const now = request.now ?? Date.now();
  const maxStates = Number.isSafeInteger(request.maxStates) ? Math.max(1, Math.min(MAX_STATES, request.maxStates!)) : DEFAULT_MAX_STATES;
  const maxWork = Number.isSafeInteger(request.maxWork) ? Math.max(1, Math.min(MAX_WORK, request.maxWork!)) : DEFAULT_MAX_WORK;
  optionCache ??= new WeakMap<ProductObservation, Map<string, string | null>>();
  const work = workMeter(maxWork);
  const { groups, unresolved } = preparedGroups ?? makeGroups(request.demands);
  const viable: Group[] = [];
  const eligible = new Map<string, Set<string>>();
  const candidates = new Map<string, ProductObservation>();
  for (const group of groups) {
    const options: PricedOption[] = [];
    const reasons = new Set<string>();
    for (const id of group.approved) {
      const matching = prepared.byId.get(id) ?? [];
      if (!matching.length) { reasons.add('approved_product_not_observed'); continue; }
      for (const observation of matching) {
        const result = optionFor(observation, group, request, now, optionCache);
        if (result.option) { options.push(result.option); break; }
        if (result.reason) reasons.add(result.reason);
      }
    }
    const dedup = new Map<string, PricedOption>();
    for (const o of options) if (!dedup.has(o.observation.product.id)) dedup.set(o.observation.product.id, o);
    const list = [...dedup.values()];
    if (!list.length) {
      const priority = ['dietary_policy_excluded', 'conditional_price_excluded', 'price_or_deposit_unknown', 'price_unknown', 'drained_weight_basis_requires_review', 'package_quantity_or_unit_unknown', 'price_outside_validity_window', 'product_unavailable_stale_or_wrong_store', 'approved_product_not_observed'];
      unresolved.push({ ingredientId: group.ingredientId, reason: priority.find(r => reasons.has(r)) ?? 'no_approved_compatible_product' });
    } else {
      viable.push(group);
      eligible.set(group.ingredientId, new Set(list.map(x => x.observation.product.id)));
      for (const option of list) if (!candidates.has(option.observation.product.id)) candidates.set(option.observation.product.id, option.observation);
    }
  }

  const components = independentComponents(compressGroups(viable, eligible), eligible, candidates);
  let statesExplored = 0, optimizationComplete = true, allComponentsFeasible = true, consumedRaw = 0;
  const lines: ProductLine[] = [];
  for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
    const component = components[componentIndex];
    const remainingStates = Math.max(0, maxStates - statesExplored);
    const result = solveTrivialComponent(component.groups, component.eligible, component.candidates, remainingStates, work)
      ?? solveSingleGroupPackCover(component.groups, component.eligible, component.candidates, remainingStates, work)
      ?? solveSingleProductComponent(component.groups, component.eligible, component.candidates, remainingStates, work)
      ?? solveComponent(component.groups, component.eligible, component.candidates, remainingStates, work);
    statesExplored += result.statesExplored;
    optimizationComplete &&= result.optimizationComplete;
    if (result.solution) { lines.push(...result.totals.lines); consumedRaw += result.totals.consumed; }
    else allComponentsFeasible = false;
    if (!result.optimizationComplete) {
      if (componentIndex + 1 < components.length) allComponentsFeasible = false;
      break;
    }
  }
  if (!optimizationComplete) unresolved.push({ ingredientId: '__basket__', reason: work.exceeded ? 'optimization_work_bound_exceeded' : 'optimization_state_bound_exceeded' });
  const totals = { lines, consumed: consumedRaw, purchase: lines.reduce((sum, line) => sum + line.purchaseCostOre, 0) };
  const knownPurchaseCostOre = Math.round(totals.purchase);
  const complete = unresolved.every(item => item.reason === 'optimization_state_bound_exceeded'
    || item.reason === 'optimization_work_bound_exceeded') && allComponentsFeasible;
  const purchaseCostOre = complete ? knownPurchaseCostOre : null;
  const consumedCostOre = complete ? Math.round(totals.consumed) : null;
  const withinBudget = purchaseCostOre === null || request.budgetOre === undefined ? null : purchaseCostOre <= request.budgetOre;
  return { complete, optimizationComplete, consumedCostOre, purchaseCostOre, knownPurchaseCostOre, withinBudget,
    lines: totals.lines, unresolved, statesExplored, workExplored: work.used };
}

export function optimizeBasket(request: BasketRequest): BasketResult {
  return optimizeBasketPrepared(request, prepareObservations(request.observations));
}

/** Returns the deduplicated explicit candidate lookup set for a small finalist menu list. */
export function finalistProductIds(finalists: MenuFinalist[]): string[] {
  return sortedUnique(finalists.flatMap(finalist => finalist.demands.filter(d => !d.nonPurchased).flatMap(d => d.approvedProductIds)));
}

/** Ranks only complete, budget-feasible menus by their actual local purchase cost. */
export function rankMenuFinalists(finalists: MenuFinalist[], context: Omit<BasketRequest, 'demands'>): RankedMenu[] {
  const prepared = prepareObservations(context.observations);
  // All finalists in a quote share observation timestamps, scope, and eligibility context.
  // If callers omit `now`, retain the old per-finalist clock read and isolate caches.
  const optionCache = context.now === undefined ? null : new WeakMap<ProductObservation, Map<string, string | null>>();
  const exactResults = context.now === undefined ? null : new Map<string, BasketResult>();
  const ranked = finalists.map(finalist => {
    const grouped = exactResults ? makeGroups(finalist.demands) : undefined;
    // These are the exact grouped inputs the solver consumes. Grouping preserves
    // within-ingredient summation order while normalizing immaterial recipe order.
    const key = grouped ? JSON.stringify(grouped) : null;
    const cachedBasket = key === null ? undefined : exactResults!.get(key);
    let basket: BasketResult;
    if (cachedBasket) basket = structuredClone(cachedBasket);
    else {
      basket = optimizeBasketPrepared({ ...context, demands: finalist.demands }, prepared, optionCache ?? undefined, grouped);
      if (key !== null) exactResults!.set(key, basket);
    }
    return { id: finalist.id, referenceCostOre: finalist.referenceCostOre, basket };
  });
  return ranked.sort((a, b) => {
    const aFeasible = a.basket.complete && a.basket.withinBudget !== false;
    const bFeasible = b.basket.complete && b.basket.withinBudget !== false;
    if (aFeasible !== bFeasible) return aFeasible ? -1 : 1;
    if (aFeasible && bFeasible && a.basket.purchaseCostOre !== b.basket.purchaseCostOre) return a.basket.purchaseCostOre! - b.basket.purchaseCostOre!;
    return a.id.localeCompare(b.id);
  });
}

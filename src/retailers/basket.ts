import { reviewedProductPolicy } from './identity.ts';
import { scopeKey } from './types.ts';
import type { BasketLine, BasketRequest, BasketResult, IngredientDemand, MenuFinalist, ProductObservation, RankedMenu } from './types.ts';

type Group = { ingredientId: string; names: string[]; quantity: number; unit: 'g' | 'ml' | 'piece'; approved: string[] };
type PricedOption = { observation: ProductObservation; group: Group; packs: number | null; consumedCost: number; purchaseCost: number; deposit: number; capacity: number; leftover: number };
type ProductLine = { productId: string; name: string; packs: number | null; quantity: number; unit: 'g' | 'ml' | 'piece'; consumedQuantity: number; leftoverQuantity: number; consumedCostOre: number; purchaseCostOre: number; depositOre: number };

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

function optionFor(o: ProductObservation, group: Group, request: BasketRequest, now: number): { option?: PricedOption; reason?: string } {
  if (!observationCurrent(o, request, now)) return { reason: 'product_unavailable_stale_or_wrong_store' };
  if (!o.price) return { reason: 'price_unknown' };
  const price = o.price;
  if (price.memberOnly || (price.minimumQuantity !== null && price.minimumQuantity > 1)) return { reason: 'conditional_price_excluded' };
  if (!finiteOre(price.amountOre) || price.depositOre === null || !finiteOre(price.depositOre)) return { reason: 'price_or_deposit_unknown' };
  const from = timeValue(price.validFrom), until = timeValue(price.validUntil);
  if (price.validFrom !== null && (from === null || from > now) || price.validUntil !== null && (until === null || until <= now)) return { reason: 'price_outside_validity_window' };
  for (const name of group.names) {
    if (reviewedProductPolicy(o.product, name) !== null) return { reason: 'dietary_policy_excluded' };
  }
  if (price.basis === 'kg' || price.basis === 'l') {
    const unitPrice = price.basis === 'kg' ? group.unit === 'g' : group.unit === 'ml';
    if (!unitPrice) return { reason: 'price_basis_unit_mismatch' };
    if (o.product.pack?.approximate) return { reason: 'approximate_variable_weight' };
    if (price.depositOre !== 0) return { reason: 'variable_weight_deposit_basis_unknown' };
    const consumedCost = price.amountOre * group.quantity / 1000;
    const purchaseCost = consumedCost + price.depositOre;
    return { option: { observation: o, group, packs: null, consumedCost, purchaseCost, deposit: price.depositOre, capacity: group.quantity, leftover: 0 } };
  }
  const pack = o.product.pack;
  if(pack?.drainedGrams!=null&&group.unit==='g')return {reason:'drained_weight_basis_requires_review'};
  if (!pack || pack.approximate || pack.unit !== group.unit || !finitePositive(pack.quantity)) return { reason: 'package_quantity_or_unit_unknown' };
  const packs = Math.ceil(group.quantity / pack.quantity);
  const capacity = packs * pack.quantity;
  const consumedCost = price.amountOre * group.quantity / pack.quantity;
  const deposit = packs * price.depositOre;
  const purchaseCost = packs * (price.amountOre + price.depositOre);
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
export function optimizeBasket(request: BasketRequest): BasketResult {
  const now = request.now ?? Date.now();
  const maxStates = Number.isSafeInteger(request.maxStates) ? Math.max(1, Math.min(MAX_STATES, request.maxStates!)) : DEFAULT_MAX_STATES;
  const maxWork = Number.isSafeInteger(request.maxWork) ? Math.max(1, Math.min(MAX_WORK, request.maxWork!)) : DEFAULT_MAX_WORK;
  const work = workMeter(maxWork);
  const { groups, unresolved } = makeGroups(request.demands);
  const viable: Group[] = [];
  const eligible = new Map<string, Set<string>>();
  const candidates = new Map<string, ProductObservation>();
  const observations = [...request.observations].sort((a, b) => a.product.id.localeCompare(b.product.id)
    || (a.price?.amountOre ?? Number.MAX_SAFE_INTEGER) - (b.price?.amountOre ?? Number.MAX_SAFE_INTEGER)
    || a.checkedAt.localeCompare(b.checkedAt));

  for (const group of groups) {
    const options: PricedOption[] = [];
    const reasons = new Set<string>();
    for (const id of group.approved) {
      const matching = observations.filter(o => o.product.id === id);
      if (!matching.length) { reasons.add('approved_product_not_observed'); continue; }
      for (const observation of matching) {
        const result = optionFor(observation, group, request, now);
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
    const result = solveComponent(component.groups, component.eligible, component.candidates, remainingStates, work);
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

/** Returns the deduplicated explicit candidate lookup set for a small finalist menu list. */
export function finalistProductIds(finalists: MenuFinalist[]): string[] {
  return sortedUnique(finalists.flatMap(finalist => finalist.demands.filter(d => !d.nonPurchased).flatMap(d => d.approvedProductIds)));
}

/** Ranks only complete, budget-feasible menus by their actual local purchase cost. */
export function rankMenuFinalists(finalists: MenuFinalist[], context: Omit<BasketRequest, 'demands'>): RankedMenu[] {
  const ranked = finalists.map(finalist => ({ id: finalist.id, referenceCostOre: finalist.referenceCostOre,
    basket: optimizeBasket({ ...context, demands: finalist.demands }) }));
  return ranked.sort((a, b) => {
    const aFeasible = a.basket.complete && a.basket.withinBudget !== false;
    const bFeasible = b.basket.complete && b.basket.withinBudget !== false;
    if (aFeasible !== bFeasible) return aFeasible ? -1 : 1;
    if (aFeasible && bFeasible && a.basket.purchaseCostOre !== b.basket.purchaseCostOre) return a.basket.purchaseCostOre! - b.basket.purchaseCostOre!;
    return a.id.localeCompare(b.id);
  });
}

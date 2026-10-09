import assert from 'node:assert/strict';
import test from 'node:test';
import { ingredientPolicy, policyText } from '../src/dietary-policy.ts';

test('dietary text and classification results are memoized for bounded inputs', () => {
  const original = String.prototype.normalize;
  const probes = new Set(['memo-probe-café-policy-text', 'memo-probe-café-ingredient-policy']);
  const counts = new Map<string, number>();
  String.prototype.normalize = function(form) {
    const value = String(this);
    if (probes.has(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
    return original.call(this, form);
  };
  try {
    const text = 'memo-probe-café-policy-text';
    assert.equal(policyText(text), 'memo probe cafe policy text');
    assert.equal(policyText(text), 'memo probe cafe policy text');
    assert.equal(counts.get(text), 1);

    const ingredient = 'memo-probe-café-ingredient-policy';
    assert.deepEqual(ingredientPolicy(ingredient), { blockedReason: null, meat: null });
    assert.deepEqual(ingredientPolicy(ingredient), { blockedReason: null, meat: null });
    assert.equal(counts.get(ingredient), 1);
  } finally {
    String.prototype.normalize = original;
  }
});

test('cached classifications are returned as fresh objects and preserve all policy outcomes', () => {
  const original: { blockedReason: string|null; meat: 'chicken'|'red_meat'|'other_meat'|null } = ingredientPolicy('kycklingbröst');
  assert.deepEqual(original, { blockedReason: null, meat: 'chicken' });
  const mutable = original as { blockedReason: string|null; meat: 'chicken'|'red_meat'|'other_meat'|null };
  mutable.blockedReason = 'caller_mutation';
  mutable.meat = 'red_meat';
  assert.deepEqual(ingredientPolicy('kycklingbröst'), { blockedReason: null, meat: 'chicken' });
  assert.deepEqual(ingredientPolicy('mirin'), { blockedReason: 'alcohol', meat: null });
  assert.deepEqual(ingredientPolicy('non alcoholic beer'), { blockedReason: null, meat: null });
  assert.deepEqual(ingredientPolicy('gelatin'), { blockedReason: 'uncertain_animal_source', meat: null });
});

test('inputs above the cache size bound are evaluated without being retained or truncated', () => {
  const original = String.prototype.normalize;
  const value = `${'x'.repeat(4100)} chicken`;
  let calls = 0;
  String.prototype.normalize = function(form) {
    if (String(this) === value) calls++;
    return original.call(this, form);
  };
  try {
    assert.equal(policyText(value), value);
    assert.equal(policyText(value), value);
    assert.equal(calls, 2);
  } finally {
    String.prototype.normalize = original;
  }
  assert.deepEqual(ingredientPolicy(value), { blockedReason: null, meat: 'chicken' });
});

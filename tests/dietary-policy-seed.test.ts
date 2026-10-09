import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DIETARY_POLICY_VERSION,
  evaluateIngredientPolicyUncached,
  ingredientPolicy,
  normalizePolicyTextUncached,
  policyText,
} from '../src/dietary-policy.ts';
import {
  INGREDIENT_POLICY_SEED,
  POLICY_SEED_DATA_SHA256,
  POLICY_SEED_IDENTITY_SHA256,
  POLICY_SEED_INPUT_COUNT,
  POLICY_SEED_SOURCE_SHA256,
  POLICY_SEED_VERSION,
  POLICY_TEXT_SEED,
} from '../src/dietary-policy-seed.ts';
import { buildPolicySeedData, renderPolicySeedModule } from '../scripts/generate-policy-seed.ts';

const policySource = readFileSync(new URL('../src/dietary-policy.ts', import.meta.url), 'utf8');
const identitySource = readFileSync(new URL('../src/retailers/identity.ts', import.meta.url), 'utf8');
const datasetUrl = new URL('../data/coop-reviewed-dataset-20261009.json', import.meta.url);

test('generated policy seed fingerprints current policy sources', () => {
  const sourceHash = createHash('sha256').update(policySource).digest('hex');
  const identityHash = createHash('sha256').update(identitySource).digest('hex');
  assert.equal(POLICY_SEED_VERSION, DIETARY_POLICY_VERSION);
  assert.equal(POLICY_SEED_SOURCE_SHA256, sourceHash, 'policy changed; regenerate with node scripts/generate-policy-seed.ts');
  assert.equal(POLICY_SEED_IDENTITY_SHA256, identityHash, 'identity policy changed; regenerate the policy seed');
  assert.ok(POLICY_SEED_INPUT_COUNT <= 4096);
});

test('synthetic seed generation covers tracked products and egg-only hen wording', () => {
  const dataset = {
    connections: [
      { name: 'eggs', approvedProducts: [{ productId: 'egg-product' }] },
      { name: 'salt', approvedProducts: [{ productId: 'salt-product' }] },
    ],
    observations: [
      { product: { id: 'egg-product', name: 'Coop Eggs', brand: 'Coop', categories: ['eggs'], ingredientsText: 'Eggs, hen, salt' } },
      { product: { id: 'salt-product', name: 'Salt', brand: null, categories: [], ingredientsText: null } },
      { product: { id: 'untracked', name: 'Pork Sausage', brand: 'Example', categories: ['meat'], ingredientsText: 'Pork' } },
    ],
  };
  const datasetSource = JSON.stringify(dataset);
  const seed = buildPolicySeedData(dataset, policySource, identitySource, datasetSource);
  assert.ok(seed.inputCount <= 4096);
  assert.ok(seed.textRows.some(([input]) => input === 'Coop Eggs'));
  assert.ok(seed.classificationRows.some(([input]) => input === 'eggs,  , salt'));
  assert.ok(!seed.textRows.some(([input]) => input === 'Pork Sausage' || input === 'Pork'));
  assert.equal(seed.datasetSha256, createHash('sha256').update(datasetSource).digest('hex'));
});

if (existsSync(fileURLToPath(datasetUrl))) {
  test('local full Coop seed exactly reproduces checked-in tuples and fingerprints', () => {
    const datasetSource = readFileSync(datasetUrl, 'utf8');
    const datasetHash = createHash('sha256').update(datasetSource).digest('hex');
    assert.equal(POLICY_SEED_DATA_SHA256, datasetHash, 'source dataset changed; regenerate the policy seed');
    const generated = buildPolicySeedData(JSON.parse(datasetSource), policySource, identitySource, datasetSource);
    assert.equal(renderPolicySeedModule(generated), readFileSync(new URL('../src/dietary-policy-seed.ts', import.meta.url), 'utf8'));
  });
}

test('every exact seeded input matches current uncached policy evaluation', () => {
  for (const [input, normalized] of POLICY_TEXT_SEED) {
    assert.equal(normalized, normalizePolicyTextUncached(input), `normalized seed differs for ${JSON.stringify(input)}`);
    assert.equal(policyText(input), normalized, `runtime normalized seed differs for ${JSON.stringify(input)}`);
  }
  for (const [input, blockedReason, meat] of INGREDIENT_POLICY_SEED) {
    assert.deepEqual(evaluateIngredientPolicyUncached(input), { blockedReason, meat }, `classification seed differs for ${JSON.stringify(input)}`);
    assert.deepEqual(ingredientPolicy(input), { blockedReason, meat }, `runtime classification seed differs for ${JSON.stringify(input)}`);
  }
});

test('seeded classifications return fresh objects and do not expose seed tuples', () => {
  const seededName = INGREDIENT_POLICY_SEED.find(([input]) => input === 'Basmatiris')?.[0];
  assert.ok(seededName);
  const first = ingredientPolicy(seededName);
  first.blockedReason = 'pork';
  assert.notStrictEqual(ingredientPolicy(seededName), first);
  assert.equal(ingredientPolicy(seededName).blockedReason, null);
});

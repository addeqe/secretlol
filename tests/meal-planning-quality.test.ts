import test from 'node:test';
import assert from 'node:assert/strict';
import {curatedPlanningRules,isPlanningRecipeEligible,parsePlanningSlot,planningQualityPolicyVersion,planningSlots} from '../src/meal-planning-quality.ts';
import {publicProfileRevision} from '../worker/meal-enrichment.ts';

test('curated planning policy blocks the test record everywhere and components only from lunch/dinner',()=>{
  assert.equal(planningQualityPolicyVersion,'curated-slot-quality-v1');
  assert.deepEqual(planningSlots,['breakfast','lunch','dinner','snack','dessert']);
  assert.equal(curatedPlanningRules.length,6);
  for(const slot of planningSlots)assert.equal(isPlanningRecipeEligible(520104,slot),false,`test record must be excluded from ${slot}`);
  assert.equal(isPlanningRecipeEligible(520104),false,'candidate-profile search without a slot also excludes the test record');
  for(const id of [366954,423015,436447,196476,312879]){
    assert.equal(isPlanningRecipeEligible(id,'lunch'),false,`${id} must not be used as lunch main`);
    assert.equal(isPlanningRecipeEligible(id,'dinner'),false,`${id} must not be used as dinner main`);
    for(const slot of ['breakfast','snack','dessert'] as const)assert.equal(isPlanningRecipeEligible(id,slot),true,`${id} remains allowed for ${slot}`);
  }
  assert.equal(isPlanningRecipeEligible(1,'lunch'),true,'unreviewed recipe IDs remain eligible');
});

test('planning slot parser accepts only the documented API values and profile revision pins the policy',()=>{
  for(const slot of planningSlots)assert.equal(parsePlanningSlot(slot),slot);
  assert.equal(parsePlanningSlot(null),null);
  assert.equal(parsePlanningSlot('main'),null);
  assert.match(publicProfileRevision({revision:'fixture'} )!,/curated-slot-quality-v1\+stockholm-calendar-week-v1$/);
});

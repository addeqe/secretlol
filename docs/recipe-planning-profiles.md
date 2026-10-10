# Recipe planning profiles

The recipe archive remains immutable. A reviewed enrichment release adds classification changes, explicit serving-count recoveries, and complete source nutrition, including cholesterol. It retains exactly the same recipe IDs, ingredients, reviews and approved shopping inventory. Original documents remain available through the archive routes.

An enrichment is uploaded into bounded JSON chunks in `meal_enrichment_chunks`. Uploads verify source and chunk checksums, unchanged inventory, expected records, shared daily write headroom and database size. Only the final metadata transaction activates a complete revision. Failed or partial uploads leave the previous revision serving requests. No classification work or enrichment writes run on daily catalogue refreshes.

Every enriched response reports `profileRevision`, combining the immutable classification revision, deterministic USDA conversion-asset revision and curated planning-quality policy version. The stored enrichment revision still identifies its chunks. A correction to reference amounts or planning exclusions invalidates client and quote caches without duplicating the recipe dataset. Clients must pin that value with `datasetId`, connection run and catalogue version throughout candidate selection and final pricing. Cursor criteria include the revision; a cursor from another revision returns 409. Retail quote caches include the revision. A rollback changes the enrichment metadata pointer to a previously verified revision; recipe archives and retailer connections remain intact.

## Candidate search

`GET /meal/recipes` retains its strict diet, allergen, cuisine, region, taste, meal-type and availability filters. Unknown allergen results never satisfy an exclusion. Within-domain cuisine/region/meal/taste choices are OR; different domains and all diet/allergen constraints are AND.

The optional `candidateProfile` query parameter is JSON:

```json
{
  "version": 1,
  "calories": 2100,
  "targets": { "protein": { "min": 70 }, "fiber": { "min": 22 } },
  "trackedNutrients": ["calories", "protein", "fiber"]
}
```

Targets use daily grams, except sodium and cholesterol, which use milligrams, and calories, which use kcal. They rank candidates; they do not certify a complete day's feasibility. The server first applies hard filters and current connection availability, then evaluates compact nutrient vectors across all matching recipes. A source-snapshot conversion-readiness hint ranks recipes with fewer unresolved quantities first, followed by nutrient density; it never removes recipes or substitutes for a fresh quote. The hint is bound to the enrichment revision. The server then reads only the requested summary page. This avoids reading every recipe document for every plan. Search responses include the strategy, eligible count, returned count and ranking axes. Candidate nutrition must be known for selected nutrient axes and the effective serving count must be positive.

Source nutrition is already per serving. Recovering an explicitly stated yield does not divide nutrient values again. A source such as `4 cups (16 small servings)` can support a count; `4 cups`, `12 cookies` or `4–6 servings` alone does not establish the source nutrition's serving count.

Household ranking normalizes each member's target by that member's energy requirement. The app's portion optimizer still checks each member's actual targets separately. A ranking score cannot prove infeasibility, and exhausting a bounded candidate search must not be presented as such.

## Planner contract

The app considers nutrient fit before simple ingredient count. New ranked responses need only one bounded summary page per meal slot; legacy API responses retain bounded pagination. Quotes remain bounded to 32 recipes and 400 distinct ingredient names per request. The candidate window and final weekly selection retain explicit resource limits, with diagnostics when the search window is exhausted.

Daily portions are optimized across meals for each member, and always stay between 0.15 and 5 base servings. Final daily nutrition, ingredient quantities, package costs, freshness and profile versions are validated again before a plan is marked ready. A plan with unresolved targets remains explicitly incomplete.

Candidate requests include `planningSlot`. A narrow policy excludes one confirmed test record from planning and five reviewed component/snack recipes from lunch and dinner mains. Other source tags and raw archive searches remain available. `/meal/dataset` exposes the exact IDs, excluded slots and source evidence in `planningQualityPolicy`. These six reviewed records do not constitute a quality audit of the entire corpus.

## Reference amount estimates

The bundled, reproducible conversion asset uses curated exact ingredient aliases and original USDA SR Legacy April 2018 portion records. It retains preparation qualifiers and does not use fuzzy food matching. Only unqualified supported volume measures or explicitly size-qualified piece measures can produce a gram estimate. Unknown quantities, conflicting source amounts, unsupported preparations, drained weights and unverified package sizes remain unresolved. Source ingredient text and units remain unchanged.

Willys quote lines include `conversionEvidence` and shopping rows expose `amountApproximate` separately from package `approximate`. Coop recipe details include `referenceAmount` with amount and evidence; final retail quotes include `amountConversions`. Reference density is an estimate, not a measurement of the purchased product. Standard mass/volume conversions retain full precision until final cost aggregation.

The advisory readiness counts describe the historical conversion snapshot recorded in the enrichment manifest. Later conservative conversion corrections may reduce the usable pool; every candidate and final quote still uses the currently versioned conversion asset and live product facts.

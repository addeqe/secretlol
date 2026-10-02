# Recipe subset and connection policy

The owner requested exclusion of pork/alcohol, uncertain animal sources/extracts, and meat without a verified product under a permitted brand. The single shared implementation is `src/dietary-policy.ts`; matching, review writes and search all enforce it.

Current subset, built 2 October 2026 against catalogue snapshot `7611d6f7-58cd-492a-9049-bde49f40da4e`:

| Dataset | Before | Retained | Removed |
| --- | ---: | ---: | ---: |
| Recipes | 397,353 | 233,846 | 163,507 |
| Ingredient rows | 3,010,082 | 1,596,207 | 1,413,875 |
| Distinct ingredient names | 6,438 | 5,085 | 1,353 |
| Reviews | 1,083,022 | 634,165 | 448,857 |

Removal reasons overlap: pork 26,044 recipes; alcohol 36,103; uncertain alcohol source 203; uncertain animal source 15,912; uncertain extract/form 54,352; no permitted verified meat match 53,680. Do not add these reason counts to obtain the total removed.

The full local recipe exclusion audit records source recipe IDs and every reason. It is not published. Original nutrition, recipe instructions, ingredient evidence and assigned units are copied unchanged for every retained recipe; all associated reviews are copied. Original files remain read-only sources.

## Rebuild using current data

Export a fresh complete authenticated catalogue into an ignored local file. It must include product category, brand, availability, observedAt, listed price, price/comparison units, offers and actual package labels. Keep a private original inventory generated from the source recipe database, rather than the already-filtered active inventory.

```bash
cd /home/adde/Music/willys-catalog
node scripts/ingredient-policy-audit.ts \
  data/pre-dietary-requirements.json data/ingredient-catalogue-20261002.json \
  data/dietary-policy-audit.json

cd /home/adde/Music/food_unit_reconstruction
.venv/bin/python -m food_unit_reconstruction.dietary_filter \
  --source data/outputs/recipes_with_willys_20261002/recipes_with_willys.sqlite \
  --database data/outputs/NEW_DIRECTORY/recipes.sqlite \
  --policy-audit /home/adde/Music/willys-catalog/data/dietary-policy-audit.json \
  --inventory-output /home/adde/Music/willys-catalog/ingredient-data/requirements.json
```

Use a new destination each time. The filter validates the complete source inventory and the shared policy audit, removes entire recipes with any excluded ingredient, copies retained rows into a new database, checks units, foreign keys and integrity, and publishes the file atomically. It also writes the summary and private removed-recipe TSV beside the database. Audit generation refuses stale catalogue observations.

After reviewing the regenerated counts, publish the new daily inventory in the existing public repository, refresh connections against the existing catalogue, and run the private connection importer against the new recipe database. The importer rejects inventory mismatches and disallowed meat brands.

## Keeping recipes eligible after a refresh

The cloud owns the connection inventory, not the entire recipe corpus. A recipe application looks up all ingredients and requires a current matched permitted product for every meat ingredient. Discontinued or stale permitted products produce an unresolved outcome rather than a forbidden substitute. Refreshed local copies expose `recipe_dietary_status.eligible_under_ingredient_policy`; `recipe_willys_status` separately indicates whether all shopping ingredients are connected for pricing.

This is an ingredient-name/brand policy. It is not independent halal certification or verification of every product's unlisted additives, rennet, processing aids or factory practices. Plant extracts whose alcohol status is not explicit are excluded; ordinary dairy/products are not blanket-excluded merely because such hidden information is absent.

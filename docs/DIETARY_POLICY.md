# Recipe subset and connection policy

The owner requested exclusion of pork/alcohol, uncertain animal sources/extracts, and meat without a verified product under a permitted brand. The single shared implementation is `src/dietary-policy.ts`; matching, review writes and search all enforce it.

Current subset, built 2 October 2026 against catalogue snapshot `7611d6f7-58cd-492a-9049-bde49f40da4e`:

| Dataset | Before | Retained | Removed |
| --- | ---: | ---: | ---: |
| Recipes | 397,353 | 233,525 | 163,828 |
| Ingredient rows | 3,010,082 | 1,595,022 | 1,415,060 |
| Distinct ingredient names | 6,438 | 5,064 | 1,374 |
| Reviews | 1,083,022 | 633,761 | 449,261 |

Removal reasons overlap: pork 26,052 recipes; alcohol 36,410; uncertain alcohol source 204; uncertain animal source 15,913; uncertain extract/form 54,352; no permitted verified meat match 53,684. Do not add these reason counts to obtain the total removed.

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

## Additional exclusions found during agent review

The second policy revision recognizes additional explicit aliases: anisette, Ricard, Herbsaint, cachaça, pisco, eau de vie, and crème de cacao/menthe/cassis. It also rejects pork cottage roll and jamón serrano, uncertain drunken cherries and Thai burgers, and requires a permitted meat match for crocodile and bresaola. Relative to the earlier filtered subset, this removes 321 recipes, 1,185 ingredient rows and 404 reviews. The active reviewed subset is `recipes_with_willys_luna_20261002/recipes_with_willys_luna.sqlite`.

Food identities were checked against primary sources: [Ricard](https://www.pernod-ricard.com/fr/nos-marques/ricard), [anisette](https://mariebrizard.com/bottles/anisette/), [Herbsaint](https://www.sazerac.com/our-brands/sazerac-brands/herbsaint.html), [cachaça](https://media.diageo.com/diageo-corporate-media/media/du5oogjv/53_ypi____ca_fact_sheet_final_280512.pdf), [pisco](https://www.peru.travel/gastronomy/en/peruvian-products/pisco.html), [crème de cassis](https://mariebrizard.com/fr/bottles/cassis-de-dijon/), and [Canadian pork cottage roll](https://aliments-nutrition.canada.ca/cnf-fce/serving-portion?id=1940).

Additional meat identity references: [Fumagalli bresaola](https://www.fumagallisalumi.it/en/bresaola/) identifies beef; [Interporc's Spanish pork guide](https://www.interporcspain.org/uploads/1/2/0/5/120592379/guide_to_meats_in_spain_eng_.pdf) describes jamón serrano.

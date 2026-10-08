

## Meal planner cloud database

The retained recipe collection is packaged as an immutable GitHub release and
imported into a separate Cloudflare D1 database in five daily parts. The existing
catalogue workflow loads its ingredient requirements exclusively from that cloud
database. `/meal/*` supplies search/filter definitions, complete recipe and
ingredient evidence, nutrition, reviews, current approved Willys IDs/prices and
meal-plan shopping quotes. See [the API and import guide](docs/mealplanner-api.md).

`MEAL_DATABASE_ID` is the recipe D1 ID; GitHub stores it as a repository variable.
The uploader shares the `willys-cloud-writes` concurrency group with catalogue
updates, checks free quota headroom, verifies release checksums, resumes safely,
and disables its own workflow after the fifth verified part. No paid services or
third-party runtime dependencies are required.

Daily refreshes compare the complete catalogue against a verified packed hash
index and write only changed product versions, real price-history changes and
changed ingredient links. Snapshots retain observation metadata and pinned
versions so pagination remains consistent. Metadata counters, bounded product
queries and version-aware recipe caches reduce D1 reads. An optional verified
trigram title index builds within the free write quota after import completes.

For an existing legacy deployment, first export both databases. Run
`node scripts/migrate-delta-storage.ts`, deploy the Worker, verify its API, then
run `node scripts/migrate-delta-storage.ts --cleanup`. The migration preserves
active IDs, prices and original timestamps, checks account quota, takes the
publication locks and leaves legacy rows available until the new API is live.

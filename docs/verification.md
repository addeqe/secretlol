# Verification — 1 October 2026

## Successful live collection

A complete collection was made against Willys' live online endpoints, using the selected anonymous store session and the site's crawler pacing/window. It was published to the local SQLite file `data/live-catalog.sqlite`; no Cloudflare account was connected for this run.

| Observation | Result |
| --- | --- |
| Selected online store | 2110 — Willys Kungsbacka Hede |
| Started | 2026-10-01 08:09:33 UTC |
| Completed | 2026-10-01 08:32:35 UTC |
| Duration | About 23 minutes |
| Top-level categories | 19 |
| Catalogue pages | 131 |
| Total retailer requests | 139 |
| Unique retained online products | 11,038 |
| Products with a numeric listed price | 11,038 |
| Available products | 10,919 |
| Products with conditional promotions | 699 |
| Listed units observed | `kr/st`, `kr/kg` |
| Initial history observations | 11,038 |
| Local database size after compaction | 62,427,136 bytes, about 59.5 MiB |
| SQLite integrity check | `ok` |

Every category's collected count matched the advertised count. The active store and category tree were checked again after pagination. Cross-category duplicates were removed. This verifies the catalogue exposed by these category endpoints for this store at collection time; it cannot prove that Willys exposes every retailer item through them.

Stored raw responses were also processed through the final price-field normalizer. Listed prices, availability and original observation times were preserved. The local database and detailed scan report are ignored by Git and excluded from the portable project archive.

## Passing checks

- Strict TypeScript checks for both this project and the existing meal planner.
- 22 offline catalogue tests: source-price normalization, promotions, complete pagination, duplicate/shift detection, request pacing, store isolation, failure-safe publication, change history, private API access, freshness, pack conversion, snapshot cursors, daily dispatch and first-time Cloudflare address handling.
- The Worker running in Cloudflare's local runtime against local D1: schema, private authentication, status/freshness, catalogue pagination and kilogram-to-pack price conversion.
- Worker deployment bundle dry-run. This builds the service without uploading it.
- Both GitHub workflow files parse successfully as YAML.
- 12 existing meal-planner tests, plus the new price-connector check for 401 mapped products split into two requests, pack quantities, omitted unmapped products and cache writes.

## Account-dependent verification

Remote resource creation, token scopes, remote D1 writes, the hosted API and the daily scheduled dispatch require your own Cloudflare/GitHub connections. They have not been tested against an account or deployed by the assistant.

The connection wizard applies the schema, deploys the Worker, pushes the workflow and starts a database-only Actions check. After connection, inspect that check in GitHub Actions, run the first collection during the crawler window, run `npm run doctor`, and verify the cron in Cloudflare's Trigger Events settings.

The 24-hour refresh target is best effort on these free services. Quota errors, expired credentials, delayed runners or changed retailer endpoints can prevent updates. Scans remain usable for their Swedish calendar week; a previous-week scan is stale, and earlier campaign expiry is still enforced. The API reports freshness and excludes expired prices.

## Setup resume fix — 2 October 2026

The user's completed Cloudflare deployment was verified through the private hosted API, which returned the expected `catalogue_not_ready` response before its first import. It was adopted into the new setup checkpoints without redeployment. GitHub setup remained unfinished because the CLI was using a different account from the repository owner.

The wizard now saves valid answers immediately, atomically writes its private settings, records each completed operation, and checks/switches the selected GitHub account before repository operations. All 30 tests pass, including eight new setup tests for persisted answers, legacy Cloudflare adoption, failures during deployment/secret upload, account switching, wrong-account browser login and environment-token overrides. TypeScript checks pass.

The saved local selection is `addeqe/secretlol` under account `addeqe`. Browser authentication for that account and the remaining GitHub connection steps still require the user's input. Setup checkpoints contain only fingerprints and are excluded from the portable archive along with all credentials.

## Delta storage, read optimization and cloud verification — 8 October 2026

Three GPT-6 Luna agents implemented and reviewed ingredient deltas, meal read reductions and validation. Strict TypeScript checks, all 85 offline tests and the local Cloudflare Worker smoke pass. Tests cover chronological legacy migration, unchanged revalidation, all product-field changes, additions/removals, failed publication and retry, pinned cursors, halal restrictions, history, cache expiry and literal search parity. Query-plan regressions verify keyed product lookups and bounded catalogue pages rather than materializing the entire compatibility view.

Both cloud databases were exported before migration. The two retained catalogue snapshots and connection runs were migrated chronologically with their original UUIDs, active pointers and observation timestamps preserved. The new Worker was deployed successfully (version `37dc0b53-46c4-4526-b87e-391db7133a70`), its private API was checked, and only then were the replaced legacy physical rows removed. One-time schema/index migration and cleanup consumed approximately 57,300 writes; that cost is separate from daily refreshes. The catalogue database decreased from 132,063,232 to approximately 73,200,000 bytes.

The following counters are actual Cloudflare D1 `meta.rows_read` / `meta.rows_written`, rather than a local SQLite proxy:

| Operation | Reads | Writes |
| --- | ---: | ---: |
| Previous complete catalogue refresh, 8 October | 133,627 | 22,208 |
| Previous ingredient refresh, excluding catalogue carry-forward | 26,123 | 886 |
| New unchanged catalogue publication | 60 | 18 |
| New unchanged ingredient refresh | 11,460 | 9 |
| Cloud recipe ingredient inventory validation | 883 | 0 |
| New unchanged combined refresh including inventory | **12,403** | **27** |
| Catalogue status metadata lookup | 3 | 0 |
| Catalogue page of 100, including next-page probe | 206 | 0 |
| Recipe status metadata/counter lookup | 7 | 0 |
| 40 product-price lookups | 163 | 0 |
| Four recipe ingredient/product point lookups | 34 | 0 |
| Cold availability scan of all 881 ingredient names | 4,399 | 0 |

The unchanged cloud verification reused the already completed 8 October scan with its original completion (`08:24:38.100 UTC`) and oldest observation (`08:02:18.330 UTC`). No extra Willys collection was performed, and freshness was not advanced to the verification time. The previous run contained real changes, so these figures demonstrate the unchanged-path cost and are not a promised fixed daily total. Future totals depend on changed products, changed links, history and retired versions. A separate unchanged check that retired 150 old product versions used 181 combined writes; cleanup is bounded and retains versions needed by pinned readers.

A disposable local replay of the actual 7–8 October catalogue change found 34 added, 117 updated and 33 removed products, with 10,915 unchanged. Only 151 new product versions were needed. All source product fields were compared canonically and preserved. In the cloud, 101 distributed product samples matched the backup payload hashes, and all 881 ingredient names retained their original selected product IDs and statuses. The private API returned the current prices for eggs, chicken breasts and ground beef and rejected pork under the existing policy. The final connection results remain **874 matched and 7 non-purchased**, tracking all 96,082 ingredient occurrences.

Catalogue hashing includes all product content except observation time, including original source metadata, prices/offers, stock, brand and package information. Packed hash records avoid reading eleven thousand product rows back from D1 after a scan; the connection phase reuses that exact hash-verified job input and loads its ingredient requirements only from the cloud recipe database. Every ingredient is still reconsidered daily using the reviewed compatibility rules and approved meat brands. Price and link history are inserted only for actual changes; indexed expiry cleanup avoids scanning the full histories.

Static recipe projections and availability checks use bounded version-aware caches. Every request checks current metadata; catalogue/run changes or price/offer expiry invalidate availability. Live price hydration remains current. Recipe status uses an atomic import counter; interrupted imports and retries retain accurate counts. The optional trigram title index builds only after final recipe verification, within account quota headroom, and activates only after every source/index recipe ID and title matches. Exact substring predicates remain in place, with the original search as a fallback.

# Live ingredient connections

The recipe inventory contains **397,353 recipes**, **3,010,082 ingredient occurrences** and **6,438 distinct original ingredient names**. The complete recipe database stays local; only the names, frequencies and product connections are stored in D1. The inventory is `ingredient-data/requirements.json`.

Every name receives an explicit outcome. `matched` means an available product with a fresh comparable price was selected by a food rule or a recorded human decision. `needs_review` means identity, preparation or substitution is uncertain. `unavailable` means the verified food has no eligible product in this store. `non_purchased` covers tap water and ice without inventing a retail product or amount. Tracking 100% of names does **not** mean 100% are connected, costed, or independently verified as correct.

## Automatic operation

The existing Cloudflare daily trigger at 04:17 UTC starts `.github/workflows/sync.yml`. After a successful catalogue publication, the same job audits every ingredient and selects the lowest comparable listed price among compatible, available products. It uses current pack sizes and compares per kilogram, litre or piece, rather than comparing carton prices. Conditional discounts are not assumed. Store scope remains **2110, Willys Kungsbacka Hede**.

When a compatible product is discontinued, unavailable, stale or no longer cheapest, its connection changes on the next successful refresh. The tracker records product-ID/status changes for 90 days. Unknown foods can use multiple reviewed compatible alternatives; their cheapest eligible alternative wins. A completely new replacement for an unknown food still needs a food rule or review. A missing compatible alternative becomes an explicit unresolved outcome.

Uploads stage a full new connection version and validate inventory counts and selected product existence before publication. Failed or incomplete uploads retain the previous complete version. Readers can distinguish catalogue-version lag through `connectionsCurrent`; `priceFresh` on lookup additionally checks the selected price expiry. Never use a stale lookup as a live price. Refresh timing is best effort, with failures visible in GitHub Actions and the status endpoint.

The matcher runs in GitHub Actions using Node standard libraries. The existing Worker serves stored results; it does not run matching or call a paid model. No subscription or paid resource was added. Actual database row-write/storage figures are included in each refresh report. A normal daily run carries the collector's row-write count into the connection step and reserves capacity for the connection upload before writing. Both steps share an 80,000-write run cap and the account's daily free quota. Separate reruns and other account activity also consume that daily quota; the provider's hard free limit still applies.

## Private API

Use the existing backend `PRICE_API_TOKEN` for reads. The base URL is the existing catalogue Worker. Keep both read and review tokens in a backend.

| Request | Result |
| --- | --- |
| `GET /ingredients/status` | Weighted coverage, outcome counts, store, versions and freshness |
| `GET /ingredients?limit=100` | Paginated connections with candidate products |
| `GET /ingredients?status=needs_review&order=frequency` | Prioritized review queue |
| `POST /ingredients/lookup` | Connections for at most 100 exact original ingredient names |
| `GET /ingredients/products?q=ägg` | Swedish catalogue search, including pack labels |
| `GET /ingredients/history?name=eggs` | Product-ID and outcome history |
| `POST /ingredients/review` | Save an approval, rejection or cleared review |
| `POST /ingredients/refresh` | Queue a connection-only GitHub run |

For pagination, URL-encode each `nextCursor` and preserve the original `status`, `q` and `order` parameters. Stop when `nextCursor` is null. Versions remain pinned while retained; `409 snapshot_expired` requires restarting the download. The importer also verifies that the active connection version stays unchanged for the whole download.

Backend example:

```js
const response = await fetch(`${process.env.PRICE_API_URL}/ingredients/lookup`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.PRICE_API_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ingredients: ['eggs', 'butter', 'water'] })
});
if (!response.ok) throw new Error(`Connection API HTTP ${response.status}`);
const result = await response.json();
// Only use selectedCode when status is matched. Require priceFresh before pricing.
```

Lookup uses the original literal names in the recipe database, including capitalization. It reports `unknown_ingredient` for names outside this inventory. New recipe datasets require regenerating the inventory, checking the source database hash, and refreshing connections.

Writes require a **separate** `INGREDIENT_REVIEW_TOKEN`. Deployment creates and saves it privately in `data/ingredient-review.env`, and uploads it as a Worker secret. Read access cannot change mappings. A review payload looks like `{name:'eggs',action:'approve',code:'100657772_ST',basis:'piece',reason:'Verified compatible whole chicken eggs'}`. `action` can be `approve`, `reject` or `clear`. Saving a review does not mutate the published version; a successful refresh applies it. `refreshNow:true` optionally queues that refresh. Approvals record compatibility rather than permanently fixing a chosen SKU.

## Review screen

Run `npm run ingredients:review` from this project and open `http://127.0.0.1:8789`. The local backend reads the private connection files and holds the tokens. The browser receives no API token. The dashboard lists high-frequency ingredients first, explains matching outcomes, shows candidates, searches Swedish product names, and records reasoned approvals/exclusions. Select **Apply saved reviews** after reviewing a group. This queues only connection work; it does not scrape Willys again. Select Search after completion to reload the summary and queue.

The review UI runs while this local process is open. The daily cloud refresh continues independently with the computer off. For a manual cloud refresh without the UI, dispatch `sync.yml` with `connections_only=true`, or run `npm run ingredients:refresh` with the configured private Cloudflare credentials.

## Local recipe database

The recipe project supplies `python -m food_unit_reconstruction.willys_connections`. It downloads every pinned connection, checks all original name/frequency counts, and atomically imports them. On this computer:

```bash
cd /home/adde/Music/food_unit_reconstruction
.venv/bin/python -m food_unit_reconstruction.willys_connections \
  --database data/outputs/recipes_with_willys_20261002/recipes_with_willys.sqlite
```

The first creation also uses `--source data/outputs/recipes_with_units_20260930/recipes_with_units.sqlite`. It creates a separate complete copy and preserves the source. Later refreshes omit `--source` and update only the small shared connection table. Local copies are snapshots; use the cloud API for automatic daily updates in your application or rerun this importer when updating the local copy.

`ingredient_product_connections` stores one outcome per literal name. `ingredient_willys` joins the connections to all original ingredient rows and exposes `willys_item_id`, product name, price basis and expiry. `recipe_willys_status` counts unresolved ingredients per recipe; `all_shopping_ingredients_connected=1` includes tap water/ice as non-purchased. Original recipes, ingredients, reviews and reconstruction evidence remain available.

```sql
SELECT * FROM ingredient_willys WHERE RecipeId='your-recipe-id';
SELECT RecipeId FROM recipe_willys_status WHERE all_shopping_ingredients_connected=1;
```

## Cost and correctness boundaries

A product connection is a purchasing identity, not a guaranteed quantity conversion. Cups of flour require an ingredient-specific density; count of onions requires a weight/yield; cooked rice and dry rice require a preparation conversion; lemon zest requires a yield; drained cans and total net weight differ. Qualitative/unknown amounts remain unknown. Do not invent a zero price or exact total for these cases. Both the cloud report and local import declare `conversionComplete:false` / `costConversionComplete:false`.

Food rules preserve recognized requested attributes, flag uncertain modifiers, and exclude many keyword-containing mixed foods. They are deterministic, versioned suggestions, not an independently established accuracy figure. New errors can be excluded using the review tool and fixed in the versioned vocabulary. Catalogue gaps, foreign branded foods, compound ingredients and unclear dry/fresh forms need explicit review or a consciously approved substitution; forcing a SKU would hide those unresolved cases.

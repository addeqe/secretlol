# Private API

All data endpoints require `Authorization: Bearer <CATALOG_API_TOKEN>`. Use your generated token on the server side. The unauthenticated `/health` endpoint only identifies the running service; it does not confirm a completed catalogue. Data responses use `Cache-Control: no-store`.

| Endpoint | Result |
| --- | --- |
| `GET /health` | Service is running |
| `GET /status` | Store ID/name, product count, last successful sync, oldest observation, freshness and per-category coverage report |
| `GET /catalog?limit=100` | Catalogue summaries and `nextCursor`; repeat with `cursor=<nextCursor>` |
| `GET /products/101233933_ST` | A product with source response and normalized price fields |
| `GET /history/101233933_ST` | Up to 100 most recent retained observed price/offer changes |
| `POST /prices/query` | Fresh mapped pack prices compatible with Matbord |

Catalogue pagination is pinned to its snapshot. The previous snapshot is retained until the next cleanup. An expired cursor returns `409 snapshot_expired`; restart without the cursor. Unknown products return 404. An uninitialized catalogue returns `503 catalogue_not_ready`; quota/network/database failures return 503. A stale catalogue remains readable for inspection but stale prices do not enter the planner endpoint. A scan is current throughout its Monday–Sunday calendar week in `Europe/Stockholm`, ending at the next Monday 00:00 local time. This is not a rolling seven-day window. Product `expiresAt` is that boundary or an earlier offer end; original observation timestamps remain unchanged. Daily collection continues.

## Product prices

The catalogue fields `priceOre`, `comparePriceOre` and `depositOre` are integer öre; `null` means unresolved. Divide by 100 for SEK. Preserve `priceUnit` and `comparePriceUnit`. `sourcePricing` preserves other original price/promotion/savings fields, and `raw` preserves the product source response. The stored listed price is not automatically a regular price, a paid-at-checkout total or an unconditional promotion price.

Conditional promotions are stored in `offers` with their original quantity, membership and expiry conditions. The service does not calculate an eligible multi-buy/member cart total. `expiresAt` combines observation age and the earliest active promotional expiry. Check it before using catalogue prices directly.

## Planner request

At most 400 products per request. Split larger batches. IDs must be unique within a request.

```json
{
  "storeId": "2110",
  "currency": "SEK",
  "products": [
    { "productId": "your-mapped-milk", "willysCode": "101233933_ST", "packQuantity": 1500, "unit": "ml" },
    { "productId": "your-mapped-orange", "willysCode": "100126114_KG", "packQuantity": 275, "unit": "g" }
  ]
}
```

For a `kr/st` product the response uses its listed item/pack price. A `kr/kg` product requires the mapped pack quantity in grams; `kr/l` requires millilitres. A variable-weight price is an estimate for that mapped quantity, not an exact checkout weight. Unknown units, unknown deposits and missing/incompatible pack sizes produce no price entry.

```text
{
  prices: [{ productId, storeId, price, currency: "SEK", source: "snapshot",
             observedAt, expiresAt, available, deposit }],
  unresolved: [{ productId, reason: "unknown_code" | "pack_price_unresolved" | "stale" }]
}
```

The `prices` numbers are SEK per mapped pack; deposits are separate. Unavailable products retain their price with `available: false`. There is no zero-price substitute for a missing entry. The server rejects a request for another store or currency rather than relabelling data.

No browser CORS access is enabled by default: call this service from your application's backend to keep its access token private. It has no public collection/dispatch endpoint; daily dispatch uses only Cloudflare's scheduled handler.

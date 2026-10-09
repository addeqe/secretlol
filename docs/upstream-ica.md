# ICA source and adapter status

Checked 2026-10-08 using public, read-only requests and an anonymous first-party store-page visit. The adapter supports postcode store resolution and selected-store category trees. It does not enumerate or save ICA products.

## Verified

`GET https://handla.ica.se/api/store/v1?zip=<five digits>&customerType=B2C` returns JSON with `forHomeDelivery` and `forPickupDelivery` arrays. Records include a branch `id`, `accountId`, store name, address, `deliveryMethods`, `retailerSiteId`, and `slug`. The response can repeat a store in both arrays. The client uses `accountId` as its `StoreScope.storeId`, because the first-party store page uses `/stores/{accountId}`, and merges the channels for repeated records. A small response excerpt is saved in `tests/fixtures/retailers/ica-stores-11455.json`.

The first-party store-selector app at `https://handla.ica.se/app/store/0.1.281928/store-selector-app.js` calls the postcode resolver and selects a store by navigating to `/stores/{accountId}`. Selecting ICA Karlaplan for postcode 11455 loaded `/stores/1003714`. Its boot data set `session.metadata.basePath` to `/stores/1003714`, with retailer region `1003714` and name `ICA Karlaplan`. The first-party fetch wrapper prefixes this base path to API requests.

An anonymous GET to `https://handlaprivatkund.ica.se/stores/1003714/api/webproductpagews/v1/categories?decoration=false&categoryDepth=2` returned HTTP 200 and 26 top-level categories for the selected store. This works with Node's ordinary `fetch` and no cookies or custom session headers. The adapter exposes this route through `categories(scope)` and only returns category IDs, names, and children.

A single store-specific `Frukt & Grönt` page showed product names, package sizes, regular prices, unit prices, and offers. The product detail page for product ID `1483119` exposed JSON-LD `Product` data with SKU, brand, `size: 0.7kg`, a SEK offer, and `availability: InStock`. The visible offer was marked “Stammispris” and showed an ordinary price separately. The JSON-LD had no EAN. This page observation does not establish delivery-slot/channel pricing, price terms for all products, or EAN availability.

## Product API gap

The first-party JavaScript defines product listing through `web_product_page_ws` at `/api/webproductpagews/v6/product-pages`, with `categoryId` or `retailerCategoryId`, repeated `tag=web&tag=category-item`, `maxPageSize`, `maxProductsToDecorate`, and optional `pageToken`. The wrapper's store `basePath` makes the selected-store route `/stores/{accountId}/api/webproductpagews/v6/product-pages`. The actual category-page request was observed in the browser's asset inventory. Bounded direct GETs using that exact route and repeated-tag serialization returned HTTP 403 from CloudFront. The observed v5 home-page route and one first-party product search also returned 403. Anonymous page-session cookies, ordinary CSRF handling and current app headers did not establish a working server path.

The original app wraps relative same-origin requests through `window.AwsWafIntegration.fetch`. A response with status 405 and `x-amzn-waf-action: captcha` opens the app's official CAPTCHA UI. A normal anonymous browser session displayed category products without a visible CAPTCHA; this is evidence of browser access, not of a server-readable product API. The anonymous store-page bootstrap contains store/session metadata but an empty `data.products.productEntities`, so it cannot replace the product API. No protection was bypassed and no CAPTCHA was solved. Browse and product lookup remain disabled until a reproducible automatic runtime is verified. A possible browser integration and its unresolved runtime requirements are documented separately in [the browser bridge proposal](ica-browser-bridge.md).

An explicitly authorized follow-up used ordinary visible Chromium through Playwright 1.64.0. It opened the selected store and followed the original cookie/menu UI. The final product check detected a CAPTCHA and stopped without solving it or retrying afterward. No successful product-price artifact was produced. This leaves unattended browser collection unverified as well as plain server collection. See [the bounded probe and result](ica-browser-probe.md).

Generic ICA catalogue pages and their schema.org product fields are not treated as proof of selected-store stock or price. The anonymous UI explicitly asks customers to log in to see stock; a JSON-LD `InStock` field alone therefore does not certify actual selected-slot availability. The adapter has no verified automatic product read path or safe way to distinguish member and ordinary offer prices in arbitrary responses. No price, EAN, pack, stock, or product parser is enabled. No login, basket, checkout, or order action was attempted.

## Client routes

- `stores(postalCode)` resolves public B2C stores, maps `accountId` to the internal store key, retains supported pickup/delivery channels, and merges duplicate records.
- `categories(scope)` reads the category tree through the selected store base path.
- `browse` and `products` throw `RetailerUnsupportedError`; product listings and verified store pricing are unavailable.

The source is an unofficial website interface. Public technical access does not grant a catalogue reuse licence.

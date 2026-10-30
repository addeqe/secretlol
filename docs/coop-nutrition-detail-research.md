# Coop product nutrition detail endpoint research

Research date: 2026-10-13. This is a source-code inspection of the saved first-party Coop site page and its published JavaScript bundle, plus the repository's approved live collection. No external calls were made during this inspection.

## Finding

The published Coop storefront client uses the Personalization search index endpoint for product-by-ID reads. I found no distinct published product-detail nutrition endpoint or schema in the inspected first-party page bundle. The bundle does expose a Hybris API client, but the product-by-ID code path used by the storefront is not a Hybris `/products/{EAN}` request: it posts IDs to `/search/entities/by-id` and reads nutrition fields from those returned product entities. A guessed Hybris product URL would therefore be unsupported by the inspected frontend and was not probed.

The matching source payloads for products with energy recorded as exactly `0 kcal` and `0 kJ` have only those energy links plus a 100 g nutrient basis. They contain no other nutrient entries that could distinguish a real zero-energy food from a default/placeholder response. The repository quality report accordingly counts 17 such records as “zero energy only” and suppresses them from energy capabilities. The source is insufficient to infer either a true nutrition label or a richer detail record.

## First-party frontend evidence

- `coop-page.html` publishes the storefront settings, including the Personalization API base `https://external.api.coop.se/personalization` and API version `v1` (file SHA-256 `6ebe0b3292ba64bc28c284de7cc783ee402eea79974b2e7eec20201ea30972aa`).
- `coop-ecommerce.js` module `72791` constructs the Personalization client from those settings. Module `91018` implements the batched product-ID lookup; its fetch function posts the requested ID array to `/search/entities/by-id` with store, customer groups, device, and `quickSearch:false` parameters.
- In the same bundle, product lookup module `59297` implements `getProductById` by delegating to that ID lookup. Product mapping module `82876` carries the returned `nutrientInformation` and `nutrientLinks` into the product detail model (`nutritionFacts` is derived from `nutrientLinks`). This makes the by-ID endpoint the source the official storefront itself uses for its product view.
- The bundle also defines a Hybris client rooted at `https://external.api.coop.se/ecommerce/coop` (`coop-ecommerce.js` module `80562`), but the inspected public product-by-ID lookup does not call a product endpoint there. The inspected storefront bundles had no nutrition-field usage in a separate endpoint client. Relevant bundle SHA-256: `65cea8213a2529b9449d96857234d060e1c99c132749364522bda4eb6e04f592`.

## Payload evidence

The live approved collection's raw source payload confirms the limitation:

- `7340191149588` (Coop Smör Normalsaltat 81%, 500 g): `nutrientLinks` contains only `0 Kilokalori` and `0 Kilojoule`; `nutrientInformation` contains only a 100 g basis header.
- `7340191157187` (Salt, 600 g): same two zero energy links and the same basis-only nutrient information.

Both records are `collected` in `coop-labels-approved-live.json`; “collected” means a source payload was obtained, not that its nutrition claims were validated. Their shared energy-link content hash is `a6fefae27bd9ba39e5c3047cf87af83c0a13e352311084d8147e84ed46771184`. The butter payload hash is `7e6d1a8373a16e5f0578d1f1a70eabb2a2bd69bba0340128a3f8751266103d82`.

`coop-label-quality-v2.json` records 17 `zero_energy_only_label_needs_review` products and 17 suppressions from energy capabilities. Its classification explicitly limits the check to machine quality and says it does not verify product composition or generate nutrition values.

## Scope and next step

This inspection does not prove that Coop has no internal, mobile-app, or partner product-data service; it establishes only that the public storefront's published product-detail path reuses the Personalization by-ID response, and that the captured approved payloads do not contain fuller nutrition for these cases. A richer source should be adopted only after Coop's public site/app or documentation identifies its exact endpoint and its response schema. Until then these 17 records should remain unknown for nutrition-derived calculations, not be treated as true zero-energy items.

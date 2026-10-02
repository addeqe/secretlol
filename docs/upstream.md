# Willys source and adaptation

Based on the cookie/CSRF handling and catalogue protocol in [ErikHellman/willys-agent](https://github.com/ErikHellman/willys-agent), MIT-licensed. The local Matbord vendor reference records revision `73bbf97356d8780de4c40735473646f65fdfae59`. This project contains a small catalogue-focused adaptation, rather than login/cart operations. The original copyright/license is included in `THIRD_PARTY_LICENSES.md`.

On 2026-10-01, live checks verified these currently used website routes:

```text
GET  /robots.txt
GET  /api/config
GET  /axfood/rest/csrf-token
POST /axfood/rest/v2/store/activate?storeId=2110&activelySelected=true&forceAsPickingStore=true
GET  /axfood/rest/v2/store/active
GET  /axfood/rest/v2/leftMenu/categorytree?storeId=2110&deviceType=OTHER
GET  /axfood/rest/v2/c?p=<category-path>&size=100&page=<number>&sort=name-asc
GET  /axfood/rest/v2/store?online=true
```

The store-activation and v2 catalogue routes were identified in JavaScript served by Willys' current website. Anonymous activation and readback worked for 2110, identified as Willys Kungsbacka Hede with `onlineStore: true`. A category page exposed listed prices, promotion rules, unit prices, deposit fields and online/stock flags. The response accepted 100-item page sizes in earlier sample checks.

The root category tree returned 19 top-level departments. A rootless category request returned 404, so this collector walks the published category tree instead of claiming an unverified catch-all endpoint. Category counts and page uniqueness are checked for every completed scan. This establishes coverage of the exposed category responses, not independent proof of every hidden retailer SKU.

The source is an unofficial website interface. Schema changes, restrictions or errors stop the scan. No proxies, CAPTCHA bypass, credential collection or checkout actions are included. The activation changes only a newly created anonymous session's selected store. Public technical access and robots instructions do not themselves grant a catalogue-reuse licence.

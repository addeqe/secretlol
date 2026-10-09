# ICA browser source probe

This is a one-time, manually invoked source check for the anonymous ICA store UI. It is not a production connector and does not establish delivery availability or store-specific stock. The app may show prices while withholding stock information until a customer signs in; this probe never logs in.

The script only permits store `1003714` and the observed Frukt & Grönt category `f9f8d3ec-9204-4e40-906b-cc5609bc10f0`. It opens the official store page in a visible, ordinary Playwright Chromium browser, opens the visible “Kategorier” menu, and follows only the matching visible category link. It accepts at most one product-pages response whose exact store route and category query match. It writes at most ten product observations with both a name and product identifier/path, using an explicit public-field allowlist or visible product-card name and route. It may include a bounded response shape (keys/types only) to aid schema inspection. It never writes request/response headers, cookies, browser storage, raw API envelopes, basket/account data, or WAF state. If a CAPTCHA appears, it stops without retrying. If the final URL or scoped product evidence is missing, it saves no artifact.

Playwright must already be available in the project environment. This repository does not install it as part of the probe. Run only after explicitly deciding to make a live browser request:

```sh
node scripts/probe-ica-browser.mjs --allow-live --store-id 1003714
```

The script is bounded to 60 seconds. It saves `data/ica-browser-probe.json` with exclusive creation, so it will not overwrite an earlier artifact. That file is a local source-probe artifact, not the production observation schema. Its `availability` remains `unknown`; `shippingVerified`, `availabilityVerified`, and `productionActivated` remain false. Visible prices are only evidence that the anonymous UI exposed those prices during this probe. They do not establish stock, shipping eligibility, or an ongoing refresh service.

## Live result: 8 October 2026

The user explicitly authorized this ordinary Chromium/Playwright probe. Playwright 1.64.0 and its official Chromium build were installed locally for the check, without adding a production dependency or changing the lockfile. The store page opened. Navigation needed ICA's visible cookie-rejection action and its two-stage category menu; the probe now follows that normal flow.

The final product check detected ICA's CAPTCHA condition and stopped. No CAPTCHA was solved, no further live retry followed the challenge, no successful product-price artifact was saved, and no Cloudflare call, full scan or deployment was performed. This result does not establish unattended product access, GitHub Actions readiness, or a working customer-price connector. The last good Willys and Coop code remains unaffected.

The syntax check still passes, and running the script without live flags stops before browser import or network access. Any production integration still needs a reviewed data contract, evidence that displayed prices and identifiers map to the app's required fields, and an independently established stock signal for the selected shopping context.

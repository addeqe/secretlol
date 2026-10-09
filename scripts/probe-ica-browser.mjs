#!/usr/bin/env node

// Explicit, one-shot source check in the ordinary visible ICA app.
const STORE_ID = "1003714";
const CATEGORY_ID = "f9f8d3ec-9204-4e40-906b-cc5609bc10f0";
const ORIGIN = "https://handlaprivatkund.ica.se";
const STORE_PATH = `/stores/${STORE_ID}`;
const API_PATH = `${STORE_PATH}/api/webproductpagews/v6/product-pages`;
const MAX_MS = 60_000;
const MAX_PRODUCTS = 10;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const allowed = new Set(["--allow-live", "--store-id"]);
  const parsed = { allowLive: false, storeId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!allowed.has(key)) throw new Error(`Unknown or duplicate argument: ${key}`);
    if (key === "--allow-live") {
      if (parsed.allowLive) throw new Error("Duplicate --allow-live flag.");
      parsed.allowLive = true;
    } else {
      if (parsed.storeId !== null || !argv[i + 1] || argv[i + 1].startsWith("--")) {
        throw new Error("--store-id must be supplied exactly once with a value.");
      }
      parsed.storeId = argv[++i];
    }
  }
  return parsed;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error.message);
}
if (options) {
  if (!options.allowLive || options.storeId !== STORE_ID) {
    fail(`Live browsing is disabled by default. To explicitly run the bounded probe, pass --allow-live --store-id ${STORE_ID}.`);
  } else {
    await runProbe();
  }
}

async function runProbe() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("Playwright is not available. This script does not install dependencies.");
    return;
  }

  let browser;
  let page;
  let timer;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    page = await context.newPage();
    const responseTasks = [];
    let captured = null;
    let challenge = false;
    let responseCount = 0;
    let resolveSourceResponse;
    const sourceResponse = new Promise(resolve => { resolveSourceResponse = resolve; });

    page.on("response", (response) => {
      const task = (async () => {
        const url = new URL(response.url());
        if (url.pathname !== API_PATH) return;
        responseCount += 1;
        if (url.origin !== ORIGIN || responseCount > 1 || url.searchParams.get("categoryId") !== CATEGORY_ID) {
          captured = { kind: "invalid" };
          return;
        }
        const wafAction = await response.headerValue("x-amzn-waf-action").catch(() => null);
        if (response.status() === 405 && wafAction === "captcha") {
          challenge = true;
          captured = { kind: "blocked" };
          return;
        }
        if (!response.ok()) {
          captured = { kind: "http-error", status: response.status() };
          return;
        }
        const length = Number(await response.headerValue("content-length").catch(() => "0"));
        if (Number.isFinite(length) && length > 1_000_000) {
          captured = { kind: "too-large" };
          return;
        }
        try {
          const body = await response.body();
          if (body.length > 1_000_000) { captured = { kind: "too-large" }; return; }
          const payload = JSON.parse(body.toString("utf8"));
          captured = { kind: "json", products: extractProducts(payload), schema: describeShape(payload) };
        } catch {
          captured = { kind: "unreadable" };
        }
      })().catch(() => { captured = { kind: "unreadable" }; }).finally(() => {
        if (new URL(response.url()).pathname === API_PATH) resolveSourceResponse();
      });
      responseTasks.push(task);
    });

    const timed = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Probe reached its 60-second limit.")), MAX_MS);
    });
    await Promise.race([performUiProbe(page), timed]);
    await Promise.race([sourceResponse, delay(10_000), timed]);

    if (challenge || captured?.kind === "blocked" || await page.locator("#waf-captcha-container").isVisible().catch(() => false)) {
      fail("ICA displayed its CAPTCHA challenge. The probe stopped without retry or challenge handling.");
      return;
    }
    const finalUrl = new URL(page.url());
    if (finalUrl.origin !== ORIGIN || finalUrl.pathname !== STORE_PATH && !finalUrl.pathname.startsWith(`${STORE_PATH}/`) || !finalUrl.href.includes(CATEGORY_ID)) {
      fail("The final browser URL did not confirm the exact observed store and category; no artifact was saved.");
      return;
    }
    await Promise.race([Promise.all(responseTasks), delay(5_000)]);
    if (captured?.kind === "invalid") {
      fail("Unexpected, repeated, or category-unscoped product API route; probe stopped without saving data.");
      return;
    }
    if (captured?.kind === "blocked") {
      fail("ICA returned its CAPTCHA challenge. The probe stopped without retry.");
      return;
    }

    let sourceKind = "browser-dom-visible";
    let products = captured?.kind === "json" ? captured.products : [];
    const schema = captured?.kind === "json" ? captured.schema : undefined;
    const visibleProducts = await extractVisibleCards(page);
    if (products.length) sourceKind = "browser-api-public-field-allowlist";
    else products = visibleProducts;
    if (!products.length) {
      if (schema) console.log(`Public response structure: ${JSON.stringify(schema)}`);
      throw new Error(`No named products were exposed; API response ${captured?.kind ?? "not observed"}${captured?.status ? ` (${captured.status})` : ""}.`);
    }

    const artifact = {
      probeKind: "sourceProbeOnly",
      capturedAt: new Date().toISOString(),
      storeId: STORE_ID,
      categoryId: CATEGORY_ID,
      sourceKind,
      ...(schema ? { responseShape: schema } : {}),
      products: products.slice(0, MAX_PRODUCTS),
      visibleProducts,
      availability: "unknown",
      shippingVerified: false,
      availabilityVerified: false,
      productionActivated: false,
    };
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const output = path.resolve("data/ica-browser-probe.json");
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Saved source-only probe with ${artifact.products.length} observations to ${output}`);
  } catch (error) {
    if (page) {
      const fs = await import("node:fs/promises");
      await fs.mkdir("data/research/retailers/verification", { recursive: true });
      await page.screenshot({ path: "data/research/retailers/verification/ica-browser-probe-failure.png" }).catch(() => {});
      const location = new URL(page.url());
      console.error(`Stopped at ${location.origin}${location.pathname}`);
    }
    fail(error instanceof Error ? error.message : "Probe failed without saving data.");
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
  }
}

async function performUiProbe(page) {
  await page.goto(`${ORIGIN}${STORE_PATH}`, { waitUntil: "domcontentloaded", timeout: MAX_MS });
  if (await page.locator("#waf-captcha-container").isVisible().catch(() => false)) throw new Error("ICA displayed its CAPTCHA challenge; stopped.");

  const rejectCookies = page.getByRole("button", { name: "Avvisa alla", exact: true });
  if (await rejectCookies.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) {
    await rejectCookies.click({ timeout: 5_000 });
    await rejectCookies.waitFor({ state: "hidden", timeout: 5_000 });
  }

  // Open the ordinary visible category menu, then choose only the observed UUID.
  const categoriesButton = page.getByRole("button", { name: /^kategorier$/i });
  await categoriesButton.first().waitFor({ state: "visible", timeout: 10_000 });
  await categoriesButton.first().click({ timeout: 5_000 });
  const link = page.locator(`a[href*="${CATEGORY_ID}"]:visible`).first();
  await link.waitFor({ state: "visible", timeout: 10_000 });
  const href = await link.getAttribute("href");
  if (!href || !href.includes(CATEGORY_ID)) throw new Error("Visible category link did not match the observed category.");
  await link.click({ timeout: 5_000 });
  // The first menu link expands the submenu. Its heading is the ordinary
  // browse link for the same category, as shown by the site's navigation UI.
  if (!page.url().includes(CATEGORY_ID)) {
    const browseLink = page.locator(`a[href*="${CATEGORY_ID}"]:visible:not([aria-haspopup="true"])`).first();
    await browseLink.waitFor({ state: "visible", timeout: 5_000 });
    await browseLink.click({ timeout: 5_000 });
  }
  await page.waitForURL((url) => url.origin === ORIGIN && url.href.includes(CATEGORY_ID), { timeout: 15_000, waitUntil: "domcontentloaded" });
  await page.locator(".product-card-container").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PUBLIC_KEYS = new Set([
  "productId", "retailerProductId", "ean", "eanCode", "gtin", "sku", "name", "displayName",
  "brand", "brandName", "categoryId", "categoryName", "packSize", "packageSize", "quantity",
  "unit", "price", "unitPrice", "pricePerUnit", "currency", "priceUnit", "priceUnitLabel",
  "offerPrice", "regularPrice", "discountPrice", "priceValue",
]);
const IDENTIFIER_KEYS = ["productId", "retailerProductId", "ean", "eanCode", "gtin", "sku"];

function extractProducts(payload) {
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      const records = node.map(sanitizeProduct).filter(Boolean);
      if (records.length) return records.slice(0, MAX_PRODUCTS);
      queue.push(...node);
    } else {
      for (const [key, value] of Object.entries(node)) {
        if (["products", "items", "productItems"].includes(key)) queue.push(value);
        else if (value && typeof value === "object") queue.push(value);
      }
    }
  }
  return [];
}

function sanitizeProduct(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(item)) {
    if (!PUBLIC_KEYS.has(key) || value == null) continue;
    if (["string", "number"].includes(typeof value)) clean[key] = typeof value === "string" ? value.slice(0, 160) : value;
  }
  if ((!clean.name && !clean.displayName) || !IDENTIFIER_KEYS.some((key) => clean[key] !== undefined)) return null;
  clean.availability = "unknown";
  return clean;
}

function describeShape(value, depth = 0) {
  if (depth >= 4 || value == null || typeof value !== "object") return Array.isArray(value) ? "array" : typeof value;
  if (Array.isArray(value)) return { type: "array", sample: value.length ? describeShape(value[0], depth + 1) : "empty" };
  const shape = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (/token|cookie|session|account|basket|customer|personal/i.test(key)) continue;
    shape[key.slice(0, 60)] = describeShape(item, depth + 1);
  }
  return shape;
}

async function extractVisibleCards(page) {
  return page.locator(".product-card-container").evaluateAll((cards) => cards.slice(0, 10).map((card) => {
    const link = card.querySelector('a[href*="/products/"]');
    const productPath = link ? new URL(link.href).pathname : null;
    const name = link?.textContent?.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!name || !productPath || !productPath.startsWith("/stores/1003714/products/")) return null;
    const visibleText = card.innerText?.trim().replace(/\s+/g, " ").slice(0, 600) || "";
    return { name, productPath, visibleText, availability: "unknown" };
  }).filter(Boolean));
}

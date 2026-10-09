# Coop-drift och lokal ICA-förberedelse

Dokumentet beskriver Coop som den enda kedjan som kan sättas upp för daglig molnuppdatering. ICA förblir avstängt och uppskjutet: serverns produkt-/prisanrop blockeras. Coop-adaptern stöder verifierade kategori-/produktuppslag och butikens onlinepriser för pickup, och full pagination har verifierats den 9 oktober: 14 368 unika produkter från Stora Coop Västberga (256600). Åtkomst från GitHub Actions ska verifieras innan dagsjobbet aktiveras. Molnpublicering kräver därför först kvotkontroll och en installerad, granskad Coop-katalog.

## Börja offline

CLI:ns standardkommando är en syntetisk demo. Den använder en markerad testfixture, skapar en temporär lokal databas i minnet och visar både ändrad och oförändrad publicering samt en whole-package-korg. Den gör noll retailer- och Cloudflare-anrop.

```sh
npm run retailers -- demo
npm run retailers -- capabilities --retailer coop
npm run retailers -- capabilities --retailer ica
npm run retailers:init
```

Demo kan sparas i en lokal SQLite-fil med `--local data/retailer-demo.sqlite`; det är fortfarande syntetiska data och inte en källa för butikens sortiment eller pris.

## Faktisk CLI-syntax

Skriptet `npm run retailers -- ...` stöder:

```text
demo
capabilities --retailer coop|ica
scan --retailer coop|ica --store-id ID [--channel pickup|delivery] [--slot-id ID] --allow-live [--output FIL]
archive --input SCAN.json [--output FIL.json.gz]
inventory --remote --confirm-cloudflare [--output FIL]
review --retailer coop|ica --input SCAN.json --inventory INVENTORY.json [--output FIL]
publish --retailer coop|ica --input REVIEWED.json --inventory INVENTORY.json [--categories TREE.json] --local FIL.sqlite
publish --retailer coop|ica --input REVIEWED.json --inventory INVENTORY.json [--categories TREE.json] --remote --confirm-cloudflare --write-budget RADER
refresh --retailer coop|ica --store-id ID [--channel pickup|delivery] --allow-live --local FIL.sqlite
refresh --retailer coop|ica --store-id ID [--channel pickup|delivery] --allow-live --remote --confirm-cloudflare --write-budget RADER
```

`scan` använder lokala checkpoints, som kan väljas med `--checkpoint MAPP`. Det kräver `--allow-live` och skriver bara en lokal insamlingsartefakt; den publicerar inte. `review` och `archive` arbetar offline. Coop-publicering validerar granskningen mot hela startkatalogen, kategoriträdet, tidigare granskade förslag och eventuella manuella kandidatnomineringar. Nomineringar är låsta till butik, inventering och katalogens kontrollsumma; varje faktiskt produktval kräver ett separat granskningsbeslut. Om priserna från startscannen hunnit gå ut före publicering kan `publish --allow-live` först kontrollera de godkända ID:na igen. Förändrad produktidentitet kräver ny granskning; verkliga prisdatum skrivs aldrig om för att få gamla data att verka färska. Molnkommandon kräver dessutom `RETAILERS_CLOUD_ENABLED=true` och anslutna Cloudflare-variabler. Kommandot `inventory` läser molnets receptinventering; kör det först när sådan läsning uttryckligen är godkänd.

`npm run retailers:init` (eller `node scripts/init-retailers.ts`) visar lokalt planläge och kontaktar inte Cloudflare. Coop-molninitiering kräver `--retailer coop --remote --confirm-cloudflare`, `RETAILERS_CLOUD_ENABLED=true` och giltig konfiguration. Initieringen kan skapa Coop-databasen, spara ID:t och köra fjärrmigrationen. Kör inte ICA-initiering. Coop hämtning kräver `COOP_PUBLIC_SUBSCRIPTION_KEY`: den är en offentlig klientnyckel som Coop själv använder i webbläsaranrop, inte en Cloudflare-credential. Lägg den som GitHub Actions-secret för dagsjobbet så att den maskeras i loggar. Behandla den som konfiguration och begränsa användningen till Coops tillåtna API.

Viktigt: `--write-budget` är en explicit, konservativ övre gräns för den skrivande D1-klientens räknade rader och kontrolleras även mot en uppskattning innan publicering. Det är inte en Cloudflare-kontokvot eller reserverad andel. D1-budgeten delas med Willys och receptimporterna. Kontrollera kontots faktiska återstående kvot innan skrivning; flaggan säkerställer inte att kontot har tillräckligt utrymme.

CLI:n laddar inte `.env` automatiskt. Anslutningsvärden kan laddas med Nodes `--env-file=.env`. Coop-installation efter kvotkontroll: `RETAILERS_CLOUD_ENABLED=true node --env-file=.env scripts/init-retailers.ts --retailer coop --remote --confirm-cloudflare`. Installera bara Coop-databasen. Det här kommandot driftsätter inte Worker eller aktiverar dagsjobbet.

## Daglig Coop-uppdatering

`.github/workflows/retailers.yml` kör endast Coop, dagligen 04:50 UTC och vid manuell start. ICA ingår inte i workflowet. Aktivera genom att sätta GitHub Actions-variabeln `COOP_DAILY_ENABLED` till `true` efter att Coop-databasen och Worker är installerade och Coop-priserna har verifierats från Actions-miljön. Workflowet använder `npm ci` för låsta beroenden.

Före varje uppdatering frågar `scripts/check-retailer-quota.ts` Cloudflares D1-analys efter dagens UTC-skrivningar i hela kontot. Körningen går vidare endast när uppmätt användning + `COOP_WRITE_ALLOWANCE` + `COOP_SHARED_WRITE_RESERVE` högst är `COOP_ACCOUNT_WRITE_LIMIT`. Standard är 10 000 reserverade skrivningar och 90 000 som gräns. Saknad/ogiltig kvotdata stoppar körningen; otillräckligt utrymme skjuter upp den. Sätt `COOP_WRITE_ALLOWANCE` till en konservativ gräns för den här katalogen. Samma allowance begränsar publiceringen. Willys och receptimport delar fortfarande kvoten; kvotkontrollen reserverar inget åt andra jobb utöver det uttryckliga reservvärdet.

Actions-inställningar för Coop-jobbet:

| Typ | Namn | Användning |
|---|---|---|
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Kontot för kvotkontroll och D1 |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare GraphQL-kvot och D1-access |
| Variable | `COOP_DATABASE_ID` | Installerad Coop D1-databas |
| Secret | `COOP_PUBLIC_SUBSCRIPTION_KEY` | Coops klientnyckel för källhämtning; maskeras i Actions-loggar |
| Variable | `COOP_REFERENCE_STORE_ID` | Verifierad referensbutik |
| Variable | `COOP_REFERENCE_CHANNEL` | Ska vara `pickup` |
| Variable | `COOP_WRITE_ALLOWANCE` | Max antal skrivningar avsatta för refreshen, 1–50 000 |
| Variable | `COOP_DAILY_ENABLED` | Sätt till `true` först när driften är redo |
| Optional variable | `COOP_SHARED_WRITE_RESERVE` | Gemensam kvotreserv; standard 10 000 |
| Optional variable | `COOP_ACCOUNT_WRITE_LIMIT` | Gräns för dagens D1-skrivningar; standard 90 000 |

Det behövs ingen betald AI-runtime eller AI-API för workflowet eller kundens vanliga API. Den publika Coop-nyckeln är upstream-konfiguration; Cloudflare-kontot och API-token är hemligheter och får aldrig skrivas ut.

## Källornas status

| Kedja | Verifierat | Inte verifierat och därför avstängt |
|---|---|---|
| Coop | Pickup-butiksförslag via postnummer, kategoriträd, kategoribrowse utan sökord, produkt-/batchuppslag och onlinepriser med uttryckligt butiks-ID. | Leverans-/slot-scope, generell ID-portabilitet och drift från GitHub/Worker. Full startscan har verifierats för referensbutik 256600 den 9 oktober. Generiskt EAN-pris används aldrig som lokalt butikspris. |
| ICA | Butiksförslag via postnummer och automatiskt butiksspecifikt kategoriträd. En anonym webbläsarsession visar lokal kategori, produkt och priser. | Produkt-/prisanrop från backend eller Actions: serveranrop får CloudFront 403, medan den vanliga webbappen använder `AwsWafIntegration.fetch`. Full pagination och ID-portabilitet återstår också. |

Kapabilitetskommandot visar adapterkonfiguration, inte bevis för att alla upstream-kontroller lyckas just nu. ICA:s fungerande anonyma webbläsarsida är inte bevis för automatisk källa. Aktuell checklistestatus finns i [Coop/ICA-arbetslistan](coop-ica-todo.md), och det godkända arbetssättet i [planen](coop-ica-plan.md).

## API som förberetts

API:t ligger på samma auktoriserade Worker som matplaneraren. De nya anropen är:

- `GET /retailers` visar anslutning, konfiguration, referensscope, senaste uppdatering och adapterkapabiliteter. Standardkedja för gamla klienter är fortfarande Willys.
- `GET /stores?retailer=ica&postalCode=11455` föreslår butiker per postnummer. Byt `ica` till `coop` vid behov. Det kräver att retailer-liveuppslag har aktiverats och att adapterfunktionen stöds. Coop visar just nu pickup-förslag från första resultatsidan; leverans är inte verifierad.
- `GET /retailers/coop/products?ids=ID,ID` ger upp till 100 spårade produkters namn, EAN, förpackning, pris, butik och aktualitet. Svaret markerar gamla eller oanvändbara priser med `publicPriceUsable: false`; det gör inget nytt Coop-anrop.
- `GET /retailers/openapi.json` beskriver tillägget.
- `POST /meal/quote` kan ta `retailer: "coop"` eller `"ica"`, upp till tre menyfinalister, och `priceMode: "reference"` eller `"local"`.

API-exempel: rangordna två menyfinalister efter referensdata. Recept-ID:n är exempel; använd faktiska ID:n från den aktuella molnreleasen. Detta är ett **utkast till API-anrop**, inte ett påstående att Coop/ICA-katalogen redan är ansluten eller att offertrutinen kan slutföras idag.

```http
POST /meal/quote
Authorization: Bearer <token>
Content-Type: application/json

{
  "retailer": "coop",
  "priceMode": "reference",
  "budgetOre": 90000,
  "finalists": [
    { "id": "menu-a", "recipes": [{ "recipeId": 123, "servings": 4 }] },
    { "id": "menu-b", "recipes": [{ "recipeId": 234, "servings": 4 }, { "recipeId": 345, "servings": 2 }] }
  ]
}
```

För en lokal ICA-offert skickas bland annat butik och handelsform. Det svaret får endast bli tillgängligt när automatisk prishämtning och eventuella lokala produktmappningar har verifierats. Dagens ICA-adapter klarar inte detta; förfrågan ska för närvarande misslyckas stängt med 503.

```json
{
  "retailer": "ica",
  "priceMode": "local",
  "storeId": "account-store-id",
  "channel": "pickup",
  "finalists": [
    { "id": "menu-a", "recipes": [{ "recipeId": 123, "servings": 4 }] },
    { "id": "menu-b", "recipes": [{ "recipeId": 234, "servings": 4 }] }
  ]
}
```

Svar kan innehålla `priceMode`, `priceSource` (`reference-webshop` eller `local-webshop`), `datasetId`, `inventoryHash`, `policyVersion`, `pricedAt`, `earliestPriceExpiry`, `finalists`, `selectedMenuId`, `referenceCostIsEstimate` och `cheapestVerified`. Lokalofferten använder en snabb, märkt referensuppskattning och gör den riktiga korgoptimeringen med kundens lokala priser. Varje meny beräknas en gång; totalt högst 20 000 arbetssteg delas mellan finalisterna. Varje finalist redovisar korgens `complete`, `optimizationComplete`, `purchaseCostOre`, `consumedCostOre`, rader med antal hela paket/pant/restmängd samt olösta ingredienser. `complete` beskriver om alla kostnader kunde lösas; `optimizationComplete` anger om sökningen kunde bevisa bästa korgen inom beräkningsgränsen. Delad lokal priscache lagrar grupper av produktuppslag under en kort hashnyckel. Det undviker ett cacheanrop per produkt; varm minnescache återanvänds även mellan olika menyförslag. Inga kundofferter skrivs i D1. Lokalt webbshoppris är inte ett löfte om fysisk hyllkostnad eller leveransavgifter.

Förbrukningskostnaden summeras utan avrundning över alla produkter och avrundas sedan till hela ören. Enskilda raders visningsbelopp avrundas separat, så deras summa kan skilja något från totalsumman. Inköpskostnaden summerar produktens faktiska paket-/viktkostnad inklusive pant. Mängder under `1e-9` gram, milliliter eller styck, eller mängder som inte kan summeras med bibehållen numerisk precision, markeras som olösta i stället för att få nollkostnad.

## Coop innan dagsjobbet aktiveras

1. Verifiera Coop pickup-pris och anrop från GitHub Actions-miljön. Lokala serverprov garanterar inte att samma källa fungerar där.
2. Kontrollera dagens delade Cloudflare-kvot innan molnläsning eller skrivning. Workflowets preflight gör samma kontroll inför varje schemalagd refresh.
3. Importera och granska Coop-produkter, skapa endast Coop-databasen/migrationen och driftsätt bindings innan `COOP_DAILY_ENABLED=true`.
4. Mät små offerter, aktualitet, CPU, cache, externa anrop och läs-/skrivförbrukning. Utöka först när källan och den delade kvoten motiverar det.
5. ICA:s produkt-/priskälla återstår separat; detta Coop-jobb aktiverar aldrig ICA.

Det vanliga kund-API:t och dagsjobbet behöver ingen betald AI-runtime. Fulla scans är en engångs-/återhämtningsåtgärd, inte en rutin. Upstream-begränsningar kan göra att bara en del av planen kan genomföras nästa arbetsdag.
